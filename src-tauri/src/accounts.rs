//! Agent accounts: several Claude Code and Codex logins on one Mac.
//!
//! Each account is a config folder of its own,
//! `~/.config/santree/accounts/<claude|codex>/<id>/`, which a launch hands the
//! CLI through its own documented override (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`).
//! The CLI does the rest: it logs in there, keeps its credential there (or in a
//! keychain item named after the folder), and never knows santree is involved.
//! The **Default** account is not one of these — it is whatever the CLI uses
//! with no override, and it is never on disk here.
//!
//! What makes a second account usable rather than a blank install is that the
//! folder shares the user's state with the Default one: settings, instructions,
//! skills, and — load-bearing — the transcripts, so a session started on one
//! account can be resumed on another. [`provision`] symlinks a fixed allowlist
//! of entries from the Default home into the folder. Nothing on the list is a
//! credential, and nothing here reads, copies or writes one (COMPLIANCE.md,
//! "Agent accounts").
//!
//! The folder is the single source of truth, shared by a dev and a release
//! build: an account exists exactly when its folder holds a readable
//! [`MARKER`].

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use std::collections::HashMap;
use std::ffi::OsStr;
use std::os::unix::fs::OpenOptionsExt;

use anyhow::{anyhow, bail, Context, Result};
use santree_core::domain::{account_tag, is_account_id, AgentAccount, AgentKind, EnvVar};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::db::Db;

/// The provider-scoped setting naming the account a fresh launch uses
/// (`agent_account__claude`, …, through [`crate::settings::provider_setting_key`]).
/// Empty or absent is the Default account.
pub const SETTING_KEY: &str = "agent_account";

/// The file that makes a folder an account, and holds its label.
const MARKER: &str = "santree-account.json";

/// The environment variable that tells `santree-hook` which account a session
/// runs on, so its rate-limit windows are recorded as that account's. Its value
/// is agent-qualified ([`account_tag`]).
const ACCOUNT_VAR: &str = "SANTREE_ACCOUNT";

/// The CLIs' own config-folder overrides, which a launch on an account sets.
const CONFIG_VARS: [&str; 2] = ["CLAUDE_CONFIG_DIR", "CODEX_HOME"];

/// Longest label kept, in characters. A label is display text; this only keeps
/// the marker file and the rows that show it sane.
const LABEL_MAX: usize = 64;

/// Entries of Claude's config folder shared into every account. An allowlist,
/// so that what an account shares is something a reviewer can read. Kept per
/// account, by never appearing here: the credential, `.claude.json` (its
/// login, onboarding and workspace trust), Claude's live `sessions/` registry,
/// the daemon's state, scheduled tasks, jobs, caches and databases.
const CLAUDE_SHARED: &[&str] = &[
    "settings.json",
    "CLAUDE.md",
    "keybindings.json",
    "agents",
    "commands",
    "skills",
    "plugins",
    "output-styles",
    "hooks",
    "rules",
    "projects",
    "history.jsonl",
    "todos",
    "plans",
    "file-history",
    "shell-snapshots",
    "session-env",
    "paste-cache",
    "tasks",
    "transcripts",
];

/// Codex's equivalent of [`CLAUDE_SHARED`]. Its sqlite state stays per account:
/// `codex resume` finds a thread by scanning `sessions/`, which is shared.
const CODEX_SHARED: &[&str] = &[
    "config.toml",
    "AGENTS.md",
    "hooks.json",
    "hooks",
    "prompts",
    "skills",
    "rules",
    "plugins",
    "agents",
    "sessions",
    "archived_sessions",
    "history.jsonl",
    "session_index.jsonl",
];

#[derive(Serialize, Deserialize)]
struct Marker {
    label: String,
}

/// The two agents that have accounts, and the folder name each lives under.
fn agent_segment(agent: AgentKind) -> Result<&'static str> {
    match agent {
        AgentKind::Claude => Ok("claude"),
        AgentKind::Codex => Ok("codex"),
        AgentKind::Cursor | AgentKind::Opencode => {
            bail!("{} has no accounts in santree", agent.as_str())
        }
    }
}

/// `~/.config/santree/accounts`.
fn accounts_root() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config/santree/accounts"))
}

/// `~/.config/santree/accounts/<agent>`.
fn agent_root(agent: AgentKind) -> Result<PathBuf> {
    let root = accounts_root().ok_or_else(|| anyhow!("HOME is not set"))?;
    Ok(root.join(agent_segment(agent)?))
}

/// Whether `path` is one of santree's account folders, or inside one — taken
/// both as written and with links resolved, so neither spelling slips past.
pub(crate) fn inside_accounts_root(path: &Path) -> bool {
    let Some(root) = accounts_root() else {
        return false;
    };
    let real_root = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    path.starts_with(&root) || real.starts_with(&real_root)
}

/// Forget the account santree's own process was started under.
///
/// santree is often launched from a terminal of its own — a tab on one of its
/// accounts — and would otherwise inherit that tab's `SANTREE_ACCOUNT` and its
/// `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Every Default launch would then run on
/// that account and the hook would file its numbers under it; the Default usage
/// read would use the account's credential; and the Default home, which each
/// account links back to, would be the account itself. So the marker is
/// dropped, and a config-folder variable pointing into the accounts root with
/// it; a user's own value pointing anywhere else is theirs and stays.
///
/// Call first thing in `run`, before any thread exists: changing the process
/// environment while another thread reads it is undefined.
pub fn forget_inherited_account() {
    std::env::remove_var(ACCOUNT_VAR);
    for name in CONFIG_VARS {
        let ours = std::env::var_os(name).is_some_and(|value| names_an_account(&value));
        if ours {
            std::env::remove_var(name);
        }
    }
}

/// Whether a config-folder value names an account folder. Claude reads a
/// comma-separated list here, so any entry counts.
fn names_an_account(value: &OsStr) -> bool {
    value
        .to_string_lossy()
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .any(|entry| inside_accounts_root(Path::new(entry)))
}

/// The folder an account id names, whether or not it exists. The id is checked
/// against [`is_account_id`] and joined as one relative component, so a value
/// from IPC can never name anything outside the agent's root.
fn dir_of(agent: AgentKind, id: &str) -> Result<PathBuf> {
    if !is_account_id(id) {
        bail!("{id:?} is not an account id");
    }
    crate::git::safe_path(&agent_root(agent)?, id)
}

/// The account's label, when `dir` is a real folder (not a link) holding a
/// readable marker — the whole definition of "this account exists".
fn read_marker(dir: &Path) -> Option<String> {
    let meta = std::fs::symlink_metadata(dir).ok()?;
    if !meta.is_dir() {
        return None;
    }
    let raw = std::fs::read_to_string(dir.join(MARKER)).ok()?;
    let marker: Marker = serde_json::from_str(&raw).ok()?;
    Some(marker.label)
}

/// The folder of an account that exists, or an error saying it doesn't.
pub(crate) fn existing(agent: AgentKind, id: &str) -> Result<PathBuf> {
    let dir = dir_of(agent, id)?;
    read_marker(&dir)
        .map(|_| dir)
        .ok_or_else(|| anyhow!("there is no {} account {id:?}", agent.as_str()))
}

/// The folder as the string the CLI is given. NFC, because Claude names the
/// account's keychain item after a hash of exactly this string
/// (`claude_usage.rs`): the env value and the hash must agree byte for byte.
pub(crate) fn dir_string(dir: &Path) -> String {
    dir.to_string_lossy().nfc().collect()
}

/// Every account of `agent` on disk, as `(id, label, folder)`, by id. Folders
/// without a marker, or whose name is not an id, are not accounts.
pub(crate) fn on_disk(agent: AgentKind) -> Vec<(String, String, PathBuf)> {
    let Ok(root) = agent_root(agent) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out: Vec<_> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let id = entry.file_name().into_string().ok()?;
            if !is_account_id(&id) {
                return None;
            }
            let dir = entry.path();
            let label = read_marker(&dir)?;
            Some((id, label, dir))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Every account of `agent`, with whether it is signed in.
///
/// Claude's answer is the folder's own `.claude.json` — the login Claude
/// recorded there, never its credential. Codex's is `codex login status` with
/// `CODEX_HOME` pointed at the folder, the same question Settings asks of the
/// Default account.
pub async fn list(db: &Db, agent: AgentKind) -> Result<Vec<AgentAccount>> {
    let accounts = on_disk(agent);
    let codex = match agent {
        AgentKind::Codex => crate::settings::agent_executable(db, agent).await.ok(),
        _ => None,
    };
    let rows = accounts.into_iter().map(|(id, label, dir)| {
        let codex = codex.clone();
        async move {
            let (email, signed_in) = match (agent, codex) {
                (AgentKind::Claude, _) => {
                    let email = crate::settings::claude_account_at(&dir.join(".claude.json"))
                        .map(|(email, _, _)| email);
                    let signed_in = email.is_some();
                    (email, signed_in)
                }
                (_, Some(executable)) => {
                    let signed_in = crate::codex_cli::account(&executable, Some(&dir))
                        .await
                        .is_ok_and(|account| account.connected);
                    (None, signed_in)
                }
                _ => (None, false),
            };
            AgentAccount {
                id,
                agent,
                label,
                dir: dir_string(&dir),
                email,
                signed_in,
            }
        }
    });
    Ok(futures::future::join_all(rows).await)
}

/// The label as stored: trimmed, non-empty, no control characters.
fn clean_label(label: &str) -> Result<String> {
    let label = label.trim();
    if label.is_empty() {
        bail!("an account needs a name");
    }
    if label.chars().count() > LABEL_MAX {
        bail!("an account name is at most {LABEL_MAX} characters");
    }
    if label.chars().any(char::is_control) {
        bail!("an account name can't contain control characters");
    }
    Ok(label.to_string())
}

/// The readable half of an id: lowercase ASCII letters and digits, runs of
/// anything else as one `-`, never leading or trailing, at most 24 characters.
fn slug(label: &str) -> String {
    let mut out = String::new();
    for c in label.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 24 {
            break;
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "account".into()
    } else {
        out.into()
    }
}

/// A new id for `label`: its [`slug`] and six random hex digits.
///
/// Never the slug alone. Claude names an account's keychain item after its
/// folder path, so an id that came back after its account was removed would
/// reopen the old login — and show its usage under the new account.
fn mint_id(label: &str) -> String {
    format!("{}-{:06x}", slug(label), rand::random::<u32>() & 0xff_ffff)
}

/// Create an account: mint its id, make its folder and marker, and provision
/// it. The CLI is not run — signing in is the user's, in a terminal
/// ([`login_command`]).
pub async fn create(db: &Db, agent: AgentKind, label: &str) -> Result<AgentAccount> {
    let label = clean_label(label)?;
    let root = agent_root(agent)?;
    let dir = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
        std::fs::create_dir_all(&root).with_context(|| format!("creating {}", root.display()))?;
        for _ in 0..8 {
            let dir = crate::git::safe_path(&root, &mint_id(&label))?;
            // `create_dir`, not `_all`: it fails on a folder that is already
            // there, which is what makes the id ours rather than a race's.
            match std::fs::create_dir(&dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e).with_context(|| format!("creating {}", dir.display())),
            }
            return match fill_new_account(agent, &dir, &label) {
                Ok(()) => Ok(dir),
                // A folder with a marker but no links would list as an account
                // that launches without the user's settings or transcripts.
                Err(e) => {
                    let _ = std::fs::remove_dir_all(&dir);
                    Err(e)
                }
            };
        }
        bail!("couldn't find a free id for {label:?}")
    })
    .await??;
    let id = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    list(db, agent)
        .await?
        .into_iter()
        .find(|account| account.id == id)
        .ok_or_else(|| anyhow!("the new account's folder disappeared"))
}

/// A just-created account folder's marker, seeded state and links. Blocking.
fn fill_new_account(agent: AgentKind, dir: &Path, label: &str) -> Result<()> {
    let marker = serde_json::to_vec_pretty(&Marker {
        label: label.to_string(),
    })?;
    std::fs::write(dir.join(MARKER), marker)?;
    if agent == AgentKind::Claude {
        seed_claude_state(dir)?;
    }
    provision(agent, dir)
}

/// Delete an account's folder, then everything santree kept about it: the
/// sessions launched on it go back to the Default account, its stored
/// rate-limit windows go, and so does every `agent_account` setting naming it.
///
/// Only a real folder under the agent's root that holds a marker is removed,
/// and `remove_dir_all` never follows the links inside it, so the shared state
/// they point at is untouched. The keychain item the CLI made for it, if any,
/// is left as it is: santree never writes the keychain.
pub async fn remove(db: &Db, agent: AgentKind, id: &str) -> Result<()> {
    let dir = existing(agent, id)?;
    tokio::task::spawn_blocking(move || {
        std::fs::remove_dir_all(&dir).with_context(|| format!("removing {}", dir.display()))
    })
    .await??;
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE terminal_sessions SET account = NULL WHERE agent_kind = ? AND account = ?")
        .bind(agent.as_str())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if agent == AgentKind::Claude {
        sqlx::query("DELETE FROM claude_account_rate_limits WHERE account = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("DELETE FROM settings WHERE key = ? AND value = ?")
        .bind(crate::settings::provider_setting_key(SETTING_KEY, agent))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// The command that signs an account in, run in a terminal the user watches:
/// the vendor's own login, pointed at the account's folder.
///
/// A control character in either path is refused rather than quoted: inside
/// single quotes a newline is still a line break in the terminal it is typed
/// into.
pub async fn login_command(db: &Db, agent: AgentKind, id: &str) -> Result<String> {
    let dir = dir_string(&existing(agent, id)?);
    let executable = crate::settings::agent_executable(db, agent)
        .await
        .unwrap_or_else(|_| crate::settings::agent_binary(agent).to_string());
    if [&dir, &executable]
        .iter()
        .any(|text| text.chars().any(char::is_control))
    {
        bail!("the login command would carry a control character; check the executable path");
    }
    let quote = crate::hooks::sh_quote;
    Ok(match agent {
        AgentKind::Claude => format!(
            "CLAUDE_CONFIG_DIR={} {} auth login",
            quote(&dir),
            quote(&executable)
        ),
        _ => format!("CODEX_HOME={} {} login", quote(&dir), quote(&executable)),
    })
}

/// The account a launch of `agent` on `term_key` runs on, provisioned, and the
/// environment that selects it — `None` for the Default account.
///
/// A surface with a stored session keeps the account it was launched on (that
/// is what makes a resume land in the same login); otherwise the
/// `agent_account` setting, repo over app.
///
/// An account that is not there is an error, never a quiet fall back to the
/// Default one: running a session on a login the user didn't pick is the
/// automatic switching COMPLIANCE.md rules out. Removing an account in santree
/// resets what named it ([`remove`]), so this only meets a folder deleted
/// behind santree's back, and the user picks where the session continues.
pub async fn for_launch(
    db: &Db,
    repo: &str,
    term_key: &str,
    agent: AgentKind,
) -> Result<Option<(String, Vec<EnvVar>)>> {
    if agent_segment(agent).is_err() {
        return Ok(None);
    }
    let stored: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT account FROM terminal_sessions WHERE repo = ? AND term_key = ? AND agent_kind = ?",
    )
    .bind(repo)
    .bind(term_key)
    .bind(agent.as_str())
    .fetch_optional(db)
    .await?;
    let id = match stored {
        Some((account,)) => account,
        None => {
            let key = crate::settings::provider_setting_key(SETTING_KEY, agent);
            crate::settings::resolve(db, repo, &key).await?
        }
    };
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let Ok(dir) = existing(agent, &id) else {
        bail!(
            "the {} account {id:?} no longer exists; continue this session on another account",
            agent.as_str()
        );
    };
    let provisioned = dir.clone();
    tokio::task::spawn_blocking(move || provision(agent, &provisioned)).await??;
    let env = launch_env(agent, &id, &dir);
    Ok(Some((id, env)))
}

/// The environment a launch on account `id` sets: the CLI's config folder and
/// the hook's account tag, nothing else.
fn launch_env(agent: AgentKind, id: &str, dir: &Path) -> Vec<EnvVar> {
    let config_var = match agent {
        AgentKind::Claude => CONFIG_VARS[0],
        _ => CONFIG_VARS[1],
    };
    vec![
        EnvVar {
            name: config_var.into(),
            value: dir_string(dir),
        },
        EnvVar {
            name: ACCOUNT_VAR.into(),
            value: account_tag(agent, id),
        },
    ]
}

/// The Default account's home, which every account's shared entries point at.
fn default_home(agent: AgentKind) -> Option<PathBuf> {
    match agent {
        AgentKind::Claude => crate::global_capture::claude_config_dir(),
        _ => crate::codex_rollouts::codex_home(),
    }
}

/// Folders that are always shared, created in the Default home when missing:
/// the transcripts. Without the link a session would write its record into the
/// account folder, where no other account could resume it.
fn always_shared(agent: AgentKind) -> &'static str {
    match agent {
        AgentKind::Claude => "projects",
        _ => "sessions",
    }
}

/// Links already reported as replaced by a real file, so a launch that meets
/// one again doesn't repeat the warning.
static WARNED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Held while provisioning: two tabs on one account opening together would
/// otherwise race on the same links. Another santree process (a dev build
/// beside a release one) can still race, which [`link`] tolerates.
static PROVISIONING: Mutex<()> = Mutex::new(());

/// Point an account folder's shared entries at the Default home. Idempotent:
/// run at create and before every launch on the account, so an entry the user
/// adds to their Default home later (a first `skills/`) reaches every account.
///
/// A correct link is left alone; a dangling or wrong one is replaced; a real
/// file or folder where a link belongs — the CLI replaced it — is left, and
/// reported once, because removing it could lose what the CLI wrote there.
/// Links are never followed when removed. Blocking.
fn provision(agent: AgentKind, dir: &Path) -> Result<()> {
    let Some(home) = default_home(agent) else {
        bail!("no home directory to share {} state from", agent.as_str());
    };
    // An account linked to an account: santree inherited one's config folder
    // and [`forget_inherited_account`] didn't recognise it. Linking would
    // replace the links that point at the real Default home.
    if inside_accounts_root(&home) {
        bail!(
            "{} is one of santree's accounts, not the Default {} home",
            home.display(),
            agent.as_str()
        );
    }
    let _provisioning = PROVISIONING.lock().unwrap_or_else(|e| e.into_inner());
    let names = match agent {
        AgentKind::Claude => CLAUDE_SHARED,
        _ => CODEX_SHARED,
    };
    let always = always_shared(agent);
    std::fs::create_dir_all(home.join(always))
        .with_context(|| format!("creating {}", home.join(always).display()))?;
    for name in names {
        let source = home.join(name);
        let entry = dir.join(name);
        match std::fs::symlink_metadata(&entry) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let correct = std::fs::read_link(&entry).is_ok_and(|to| to == source);
                if correct && source.exists() {
                    continue;
                }
                match std::fs::remove_file(&entry) {
                    Ok(()) => {}
                    Err(e) if crate::session::is_absence(&e) => {}
                    Err(e) => {
                        return Err(e).with_context(|| format!("replacing {}", entry.display()))
                    }
                }
            }
            Ok(_) => {
                let mut warned = WARNED.lock().unwrap_or_else(|e| e.into_inner());
                if warned.insert(entry.clone()) {
                    log::warn!(
                        "{} is no longer shared with the Default account: the CLI replaced \
                         the link with its own copy",
                        entry.display()
                    );
                }
                continue;
            }
            Err(e) if crate::session::is_absence(&e) => {}
            Err(e) => return Err(e).with_context(|| format!("reading {}", entry.display())),
        }
        if !source.exists() {
            continue;
        }
        link(&source, &entry)?;
    }
    Ok(())
}

/// Symlink `entry` to `source`. Losing a race to someone making the same link
/// is success; losing it to anything else is not.
fn link(source: &Path, entry: &Path) -> Result<()> {
    match std::os::unix::fs::symlink(source, entry) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            if std::fs::read_link(entry).is_ok_and(|to| to == source) {
                Ok(())
            } else {
                Err(e).with_context(|| format!("linking {}", entry.display()))
            }
        }
        Err(e) => Err(e).with_context(|| format!("linking {}", entry.display())),
    }
}

/// The Default account's `.claude.json`: in the config folder when santree was
/// itself started with `CLAUDE_CONFIG_DIR`, else `~/.claude.json`.
fn default_claude_json() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(_) => crate::global_capture::claude_config_dir().map(|d| d.join(".claude.json")),
        None => std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude.json")),
    }
}

/// Give a new Claude account the state that would otherwise greet the user
/// with a first-run wizard: onboarding done, the Default account's theme, and
/// workspace trust for exactly the folders the user already trusted there. No
/// login, no credential — Claude writes those itself on sign-in. Only when the
/// folder has no `.claude.json` yet, and never over one.
fn seed_claude_state(dir: &Path) -> Result<()> {
    let target = dir.join(".claude.json");
    // Streamed into a type with only the two fields used: the file also holds
    // the user's login and, for an API-key user, the key, and neither has any
    // reason to be in santree's memory.
    let default: DefaultClaudeState = default_claude_json()
        .and_then(|path| std::fs::File::open(path).ok())
        .and_then(|file| serde_json::from_reader(std::io::BufReader::new(file)).ok())
        .unwrap_or_default();
    let seed = seeded_claude_json(&default);
    // 0600, as Claude keeps its own.
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&target);
    let mut file = match file {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(e) => return Err(e).with_context(|| format!("creating {}", target.display())),
    };
    std::io::Write::write_all(&mut file, serde_json::to_string_pretty(&seed)?.as_bytes())?;
    Ok(())
}

/// What a new account takes from the Default account's `.claude.json`.
#[derive(Deserialize, Default)]
struct DefaultClaudeState {
    #[serde(default)]
    theme: Option<String>,
    #[serde(default)]
    projects: HashMap<String, ProjectTrust>,
}

#[derive(Deserialize)]
struct ProjectTrust {
    #[serde(default, rename = "hasTrustDialogAccepted")]
    trusted: bool,
}

/// [`seed_claude_state`]'s document, from the Default account's.
fn seeded_claude_json(default: &DefaultClaudeState) -> serde_json::Value {
    let mut seed = serde_json::Map::new();
    seed.insert("hasCompletedOnboarding".into(), true.into());
    if let Some(theme) = &default.theme {
        seed.insert("theme".into(), theme.clone().into());
    }
    let trusted: serde_json::Map<String, serde_json::Value> = default
        .projects
        .iter()
        .filter(|(_, project)| project.trusted)
        .map(|(path, _)| {
            (
                path.clone(),
                serde_json::json!({ "hasTrustDialogAccepted": true }),
            )
        })
        .collect();
    seed.insert("projects".into(), trusted.into());
    seed.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An id names a folder and arrives over IPC, so only the minted shape
    /// passes — nothing that could climb out of the accounts root, flag-like,
    /// or too long for the keychain item Claude derives from it.
    #[test]
    fn only_a_minted_shape_is_an_account_id() {
        for ok in ["work", "a", "0", "work-2", &"a".repeat(32)] {
            assert!(is_account_id(ok), "{ok}");
        }
        for bad in [
            "",
            "-work",
            "Work",
            "wörk",
            "a/b",
            "..",
            ".",
            "work 2",
            "work_2",
            &"a".repeat(33),
        ] {
            assert!(!is_account_id(bad), "{bad}");
            assert!(dir_of(AgentKind::Claude, bad).is_err(), "{bad}");
        }
        for label in ["Work", "  My  Team!! ", "ÉQUIPE", "---", &"x".repeat(80)] {
            let id = mint_id(label);
            assert!(is_account_id(&id), "{label} → {id}");
        }
        // A label used again is a new folder, so never the old login.
        assert_ne!(mint_id("Work"), mint_id("Work"));
    }

    /// A launch on an account sets the CLI's config folder and the hook's tag,
    /// and nothing else: every other variable a session sees is the user's.
    #[test]
    fn an_account_launch_sets_exactly_its_folder_and_tag() {
        let dir = Path::new("/Users/someone/.config/santree/accounts/codex/work-0a1b2c");
        for (agent, config, tag) in [
            (AgentKind::Claude, "CLAUDE_CONFIG_DIR", "claude:work-0a1b2c"),
            (AgentKind::Codex, "CODEX_HOME", "codex:work-0a1b2c"),
        ] {
            let env: Vec<(String, String)> = launch_env(agent, "work-0a1b2c", dir)
                .into_iter()
                .map(|var| (var.name, var.value))
                .collect();
            assert_eq!(
                env,
                [
                    (config.to_string(), dir.to_string_lossy().into_owned()),
                    ("SANTREE_ACCOUNT".to_string(), tag.to_string()),
                ]
            );
        }
    }
}
