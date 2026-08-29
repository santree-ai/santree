//! Codex, asked through the plain vendor CLI.
//!
//! santree used to run its own `codex app-server` — a JSON-RPC control plane on
//! a private Unix socket — and every Codex surface went through it. Interactive
//! sessions moved to the plain CLI first; this module is the rest of that move,
//! and the server is gone. What it cost while it existed is worth recording: a
//! long-lived child process per app run that outlived its parent, and one
//! writer lock per Codex thread, which is what made `thread/resume` fail with
//! "thread `<id>` already has an active writer" in the user's face.
//!
//! Every read here is one short-lived, non-interactive invocation of the real
//! `codex` binary, bounded by a timeout and an output cap:
//!
//! * `codex --version` — the version floor.
//! * `codex login status` — signed in, and by what method. It prints one line
//!   *about* the credential store; it never prints a credential, and santree
//!   never reads `~/.codex/auth.json` or any other auth file.
//! * `codex debug models` — the model catalog, as JSON.
//! * `codex logout` — the vendor's own documented way to sign out, run on a
//!   click. santree hands the request on; Codex owns what happens to the
//!   credentials.
//!
//! There is deliberately **no login command**. Starting a ChatGPT login was an
//! App Server call, and the CLI's own `codex login` is an interactive flow that
//! owns a browser round trip and a local callback. Rather than reimplement it,
//! Settings says to run `codex login` in a terminal. Subscription usage is not
//! here either: see [`crate::codex_rollouts::latest_rate_limits`] for the one
//! source that needs neither a server nor a credential.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use santree_core::domain::{CodexAccount, CodexHealth, CodexModel, CodexReasoningEffort};
use serde::Deserialize;
use tokio::io::AsyncReadExt;

/// The floor santree launches against. Below it the hook flags a Codex launch
/// carries (`-c 'hooks.<Event>=…'` plus `--dangerously-bypass-hook-trust`) are
/// not understood, so a session would run with no state reporting at all.
const MIN_VERSION: (u64, u64, u64) = (0, 149, 0);

/// Generous for `debug models`, which may refresh its catalog over the network,
/// and irrelevant for the rest, which are local reads.
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

/// The model catalog is the big one and is well under this. The cap exists so a
/// wedged or wrong binary can't stream santree out of memory.
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;

pub async fn health(executable: Option<String>) -> CodexHealth {
    let Some(executable) = executable else {
        return CodexHealth {
            error: Some("Codex CLI was not found. Install it or set its executable path.".into()),
            ..Default::default()
        };
    };
    match detected_version(&executable).await {
        Ok((version, compatible)) => CodexHealth {
            available: compatible,
            version,
            error: (!compatible).then(|| "Codex 0.149.0 or newer is required.".into()),
            executable,
        },
        Err(e) => CodexHealth {
            executable,
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

/// `codex login status`. One line, and the CLI's own wording is the contract —
/// santree matches the "Logged in" prefix and reports the method verbatim rather
/// than mapping it to an enum, so a new auth method Codex adds shows up as
/// itself instead of as "unknown".
pub async fn account(executable: &str) -> Result<CodexAccount> {
    let output = run(executable, &["login", "status"]).await?;
    Ok(parse_login_status(&output))
}

fn parse_login_status(output: &str) -> CodexAccount {
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    let Some(method) = line.strip_prefix("Logged in using ") else {
        return CodexAccount::default();
    };
    CodexAccount {
        connected: true,
        // "Logged in using an API key - sk-…" carries a redacted hint after a
        // dash. Cut at it: the method is what the UI shows, and everything to
        // the right of that dash is about the credential.
        auth_type: method
            .split(" - ")
            .next()
            .unwrap_or(method)
            .trim()
            .to_string(),
    }
}

/// `codex debug models`, which renders the raw catalog as JSON.
///
/// Only `visibility: "list"` entries are kept — the catalog also carries
/// internal routing targets (`gpt-reserve`, `codex-auto-review`) that Codex's own
/// picker hides, and offering them as a work model would be offering something
/// the user cannot meaningfully choose.
pub async fn models(executable: &str) -> Result<Vec<CodexModel>> {
    let output = run(executable, &["debug", "models"]).await?;
    let catalog: Catalog =
        serde_json::from_str(&output).context("parsing the Codex model catalog")?;
    Ok(catalog
        .models
        .into_iter()
        .filter(|model| model.visibility.as_deref() == Some("list"))
        .map(Into::into)
        .collect())
}

pub async fn logout(executable: &str) -> Result<()> {
    run(executable, &["logout"]).await?;
    Ok(())
}

// ── The catalog's own shape ─────────────────────────────────────────────────

/// Only the fields the UI contract needs. `serde` ignores the ~30 others by
/// default, which is what lets a Codex release add fields without breaking this.
#[derive(Deserialize)]
struct Catalog {
    #[serde(default)]
    models: Vec<CatalogModel>,
}

#[derive(Deserialize)]
struct CatalogModel {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    default_reasoning_level: String,
    #[serde(default)]
    supported_reasoning_levels: Vec<CatalogEffort>,
    visibility: Option<String>,
}

#[derive(Deserialize)]
struct CatalogEffort {
    #[serde(default)]
    effort: String,
    #[serde(default)]
    description: String,
}

impl From<CatalogModel> for CodexModel {
    fn from(model: CatalogModel) -> Self {
        Self {
            id: model.slug,
            display_name: model.display_name,
            description: model.description,
            default_reasoning_effort: model.default_reasoning_level,
            supported_reasoning_efforts: model
                .supported_reasoning_levels
                .into_iter()
                .map(|level| CodexReasoningEffort {
                    effort: level.effort,
                    description: level.description,
                })
                .collect(),
        }
    }
}

// ── Running the binary ──────────────────────────────────────────────────────

/// `codex --version` → `("0.150.1", meets the floor)`.
async fn detected_version(executable: &str) -> Result<(String, bool)> {
    let text = run(executable, &["--version"]).await?;
    let version = text
        .split_whitespace()
        .find(|part| part.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or_default()
        .trim_start_matches('v');
    Ok((version.into(), parse_version(version) >= MIN_VERSION))
}

/// Lenient on purpose: a pre-release suffix (`0.151.0-alpha.2`) must compare as
/// its release numbers, not fail the parse and read as "too old".
fn parse_version(version: &str) -> (u64, u64, u64) {
    let mut numbers = version.split('.').map(|part| {
        part.split(|c: char| !c.is_ascii_digit())
            .next()
            .unwrap_or("0")
            .parse::<u64>()
            .unwrap_or(0)
    });
    (
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
        numbers.next().unwrap_or(0),
    )
}

/// One non-interactive `codex` call: stdin closed, stdout captured under a cap,
/// killed on timeout and on drop.
///
/// `stdin(null)` is load-bearing rather than tidy. Every subcommand here is
/// documented as non-interactive, but a future one that decides to prompt would
/// otherwise sit forever on a terminal nobody is watching, holding a
/// blocking-pool slot — the same class of stuck process the App Server left 87
/// of behind.
async fn run(executable: &str, args: &[&str]) -> Result<String> {
    let mut child = tokio::process::Command::new(executable)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("running codex {}", args.join(" ")))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("codex stdout was not captured"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow!("codex stderr was not captured"))?;

    let call = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut capped_out = (&mut stdout).take((OUTPUT_LIMIT + 1) as u64);
        let mut capped_err = (&mut stderr).take((OUTPUT_LIMIT + 1) as u64);
        // Both pipes are drained concurrently with the wait: a subcommand that
        // fills one while we block on the other would deadlock on the kernel's
        // pipe buffer.
        let (out_read, err_read, status) = tokio::join!(
            capped_out.read_to_end(&mut out),
            capped_err.read_to_end(&mut err),
            child.wait(),
        );
        out_read?;
        err_read?;
        if out.len() > OUTPUT_LIMIT {
            bail!("codex {} produced more than {OUTPUT_LIMIT} bytes", args[0]);
        }
        let status = status?;
        if !status.success() {
            let detail = String::from_utf8_lossy(&err);
            let detail = detail.trim();
            let detail = detail.lines().next().unwrap_or_default();
            bail!("codex {} exited {status}: {detail}", args.join(" "));
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    };
    tokio::time::timeout(CALL_TIMEOUT, call)
        .await
        .map_err(|_| anyhow!("codex {} timed out", args.join(" ")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact strings `codex` 0.150.1 prints — read out of the shipped
    /// binary rather than guessed, because this parser *is* the contract with a
    /// human-readable command.
    #[test]
    fn login_status_is_read_from_the_clis_own_wording() {
        assert_eq!(parse_login_status("Not logged in"), CodexAccount::default());
        assert_eq!(parse_login_status(""), CodexAccount::default());
        for (line, method) in [
            ("Logged in using ChatGPT", "ChatGPT"),
            ("Logged in using access token", "access token"),
            (
                "Logged in using personal access token",
                "personal access token",
            ),
            ("Logged in using workload identity", "workload identity"),
            (
                "Logged in using Amazon Bedrock API key",
                "Amazon Bedrock API key",
            ),
        ] {
            let account = parse_login_status(line);
            assert!(account.connected, "{line}");
            assert_eq!(account.auth_type, method);
        }
    }

    /// The one variant that prints something *after* the method: a redacted key
    /// hint. It must not become part of the method the UI shows.
    #[test]
    fn an_api_key_hint_never_reaches_the_account_field() {
        let account = parse_login_status("Logged in using an API key - sk-proj-abc…xyz\n");
        assert!(account.connected);
        assert_eq!(account.auth_type, "an API key");
    }

    /// `codex debug models` names its fields differently from the App Server's
    /// `model/list` (`slug`, not `id`; `default_reasoning_level`, not
    /// `defaultReasoningEffort`), and marks hidden entries with `visibility`
    /// rather than a boolean. Getting either wrong is silent: the picker just
    /// shows blank rows, or offers a routing target the user can't pick.
    #[test]
    fn the_catalog_is_read_by_its_own_field_names_and_hidden_entries_stay_hidden() {
        let catalog: Catalog = serde_json::from_str(
            r#"{"models":[
                {"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol","description":"Frontier.",
                 "default_reasoning_level":"medium","visibility":"list","priority":1,
                 "supported_reasoning_levels":[{"effort":"low","description":"Fast"},
                                               {"effort":"high","description":"Deep"}],
                 "future_field":{"safe":"to ignore"}},
                {"slug":"gpt-reserve","display_name":"GPT-Reserve","description":"",
                 "default_reasoning_level":"medium","visibility":"hide",
                 "supported_reasoning_levels":[]}
            ]}"#,
        )
        .unwrap();
        let models: Vec<CodexModel> = catalog
            .models
            .into_iter()
            .filter(|model| model.visibility.as_deref() == Some("list"))
            .map(Into::into)
            .collect();
        assert_eq!(models.len(), 1, "a hidden routing target was offered");
        assert_eq!(models[0].id, "gpt-5.6-sol");
        assert_eq!(models[0].display_name, "GPT-5.6-Sol");
        assert_eq!(models[0].default_reasoning_effort, "medium");
        assert_eq!(
            models[0]
                .supported_reasoning_efforts
                .iter()
                .map(|e| e.effort.as_str())
                .collect::<Vec<_>>(),
            ["low", "high"]
        );
    }

    #[test]
    fn the_version_floor_is_ordered_numerically_and_tolerates_a_prerelease() {
        assert!(parse_version("0.150.1") >= MIN_VERSION);
        assert!(parse_version("0.149.0") >= MIN_VERSION);
        assert!(parse_version("0.151.0-alpha.2") >= MIN_VERSION);
        assert!(parse_version("0.99.99") < MIN_VERSION);
    }

    #[test]
    fn a_missing_executable_is_a_remedy_not_a_crash() {
        let health = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(health(Some("/nonexistent/codex".into())));
        assert!(!health.available);
        assert!(health.error.is_some());
    }
}
