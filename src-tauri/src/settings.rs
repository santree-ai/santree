//! Generic app/per-repo key-value settings (the `settings` table) plus discovery
//! of the Claude slash-commands offered by the triage "Investigate" picker.
//!
//! `scope` is `"app"` or `"repo:<name>"`: a repo value overrides the app value
//! for the same key, and absence falls back to the app value (see [`resolve`]).

use std::path::{Path, PathBuf};

use anyhow::Result;

use santree_core::config;
use santree_core::domain::{
    AgentAuth, AgentKind, ClaudeCommand, ClaudeCommandFile, ClaudeCommands, CommandSource, Settings,
};

use crate::db::Db;

/// The `settings` key under which the full [`Settings`] blob is persisted (scope `"app"`).
const SETTINGS_KEY: &str = "settings";

/// Gate the *IPC* key-value surface (`get_setting` / `set_setting`), whose scope and
/// key both arrive from the webview. Internal callers (`pricing`'s `price_cache`
/// scope, the [`Settings`] blob itself) use [`get`]/[`set`] directly and are trusted.
///
/// Two things it enforces:
///  - The scope is really `"app"` or `"repo:<name>"`. Nothing checked this before, so
///    a typo'd scope wrote a row [`resolve`] would never read back — the setting just
///    silently didn't apply.
///  - The [`Settings`] blob is off-limits. It lives in this same table at
///    `app`/`settings`, so `set_setting("app", "settings", …)` would replace the whole
///    typed Settings object with an arbitrary string. It has its own command
///    ([`set_settings`]).
pub fn validate_user_scope(scope: &str, key: &str) -> Result<()> {
    let repo_scoped = scope
        .strip_prefix("repo:")
        .is_some_and(|name| !name.is_empty());
    if scope != "app" && !repo_scoped {
        anyhow::bail!("invalid settings scope {scope:?} (expected \"app\" or \"repo:<name>\")");
    }
    if key == SETTINGS_KEY {
        anyhow::bail!("the {SETTINGS_KEY:?} blob must be written through save_settings");
    }
    Ok(())
}

/// Read a setting for an exact scope (`"app"` or `"repo:<name>"`).
pub async fn get(db: &Db, scope: &str, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM settings WHERE scope = ? AND key = ?")
            .bind(scope)
            .bind(key)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(v,)| v))
}

/// Upsert (`Some`) or clear (`None`) a setting for a scope.
pub async fn set(db: &Db, scope: &str, key: &str, value: Option<String>) -> Result<()> {
    match value {
        Some(v) => {
            sqlx::query(
                "INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)
                 ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value",
            )
            .bind(scope)
            .bind(key)
            .bind(v)
            .execute(db)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM settings WHERE scope = ? AND key = ?")
                .bind(scope)
                .bind(key)
                .execute(db)
                .await?;
        }
    }
    Ok(())
}

/// Delete a key across *every* scope (app + all repos). Used when a setting's
/// underlying entity is removed (e.g. deleting a custom prompt block), so no
/// orphaned per-repo overrides linger.
pub async fn clear_all_scopes(db: &Db, key: &str) -> Result<()> {
    sqlx::query("DELETE FROM settings WHERE key = ?")
        .bind(key)
        .execute(db)
        .await?;
    Ok(())
}

/// Resolve a repo-scoped setting: the repo's own override, else the app value.
/// Both candidate rows come back in one round-trip; the repo scope wins when present.
pub async fn resolve(db: &Db, repo: &str, key: &str) -> Result<Option<String>> {
    let repo_scope = format!("repo:{repo}");
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT scope, value FROM settings WHERE key = ? AND scope IN (?, 'app')")
            .bind(key)
            .bind(&repo_scope)
            .fetch_all(db)
            .await?;
    let pick = |scope: &str| {
        rows.iter()
            .find(|(s, _)| s == scope)
            .map(|(_, v)| v.clone())
    };
    Ok(pick(&repo_scope).or_else(|| pick("app")))
}

/// The user's settings: the persisted blob when present, else the seeded
/// defaults. A corrupt blob falls back to defaults rather than erroring.
pub async fn get_settings(db: &Db) -> Result<Settings> {
    match get(db, "app", SETTINGS_KEY).await? {
        Some(json) => Ok(serde_json::from_str(&json).unwrap_or_else(|e| {
            log::warn!("settings blob failed to parse; using defaults: {e}");
            config::default_settings()
        })),
        None => Ok(config::default_settings()),
    }
}

/// Persist the full settings blob (integration toggles, agent execs/models, …).
pub async fn set_settings(db: &Db, settings: &Settings) -> Result<()> {
    let json = serde_json::to_string(settings)?;
    set(db, "app", SETTINGS_KEY, Some(json)).await
}

/// Claude commands available to a scope: always the global set, plus the repo's
/// own when a `repo_path` is given.
pub fn commands(repo_path: Option<&str>) -> ClaudeCommands {
    let global = global_commands_dir()
        .map(|d| scan_commands(&d))
        .unwrap_or_default();
    let repo = repo_path
        .map(|p| scan_commands(&Path::new(p).join(".claude").join("commands")))
        .unwrap_or_default();
    ClaudeCommands { global, repo }
}

/// The CLI binary name probed on PATH for each harness.
fn agent_binary(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Cursor => "cursor-agent",
        AgentKind::Opencode => "opencode",
    }
}

/// An agent harness's authentication / subscription status. For Claude this is
/// read live from `~/.claude.json`; the others are work-in-progress placeholders.
/// Every harness reports the executable discovered on PATH.
pub fn agent_auth(kind: AgentKind) -> AgentAuth {
    let detected_exec = discover_binary(agent_binary(kind)).unwrap_or_default();
    match kind {
        AgentKind::Claude => {
            let account = claude_account();
            let connected = account.is_some();
            let (account, org, plan) = account
                .unwrap_or_else(|| ("Not signed in".to_string(), String::new(), String::new()));
            AgentAuth {
                connected,
                method: "CLI".into(),
                provider: "Anthropic API".into(),
                plan,
                org,
                account,
                settings_path: "~/.claude/settings.json".into(),
                login_cmd: "claude /login".into(),
                detected_exec,
            }
        }
        AgentKind::Codex => wip_auth(
            "OpenAI",
            "~/.codex/config.toml",
            "codex login",
            detected_exec,
        ),
        AgentKind::Cursor => wip_auth(
            "Cursor",
            "~/.cursor/cli-config.json",
            "cursor-agent login",
            detected_exec,
        ),
        AgentKind::Opencode => wip_auth(
            "opencode zen",
            "~/.config/opencode/opencode.json",
            "opencode auth login",
            detected_exec,
        ),
    }
}

/// A not-yet-wired harness's auth placeholder.
fn wip_auth(provider: &str, settings: &str, login: &str, detected_exec: String) -> AgentAuth {
    AgentAuth {
        connected: false,
        method: "CLI".into(),
        provider: provider.into(),
        plan: "—".into(),
        org: "—".into(),
        account: "Not connected".into(),
        settings_path: settings.into(),
        login_cmd: login.into(),
        detected_exec,
    }
}

/// Read the signed-in Claude account from `~/.claude.json` → returns
/// (account email, organization name, plan label). `None` when not signed in.
fn claude_account() -> Option<(String, String, String)> {
    let home = std::env::var_os("HOME")?;
    let raw = std::fs::read_to_string(PathBuf::from(home).join(".claude.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let acc = json.get("oauthAccount")?;
    let email = acc.get("emailAddress")?.as_str()?.to_string();
    let org = acc
        .get("organizationName")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let plan = acc
        .get("organizationType")
        .and_then(|v| v.as_str())
        .map(plan_label)
        .unwrap_or_default();
    Some((email, org, plan))
}

/// Turn an `organizationType` like `claude_max` into a display plan like `Max`.
fn plan_label(org_type: &str) -> String {
    let t = org_type.strip_prefix("claude_").unwrap_or(org_type);
    let mut chars = t.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Process-wide cache of resolved binary paths. Each lookup spawns a login shell
/// (tens of ms); the agent settings cards re-resolve on every render, so hits are
/// memoised for the app's lifetime — a binary's location doesn't move while the
/// app is running. Only *hits* are cached: a binary installed mid-session would
/// otherwise stay "not detected" until restart, so misses are re-probed.
static BINARY_CACHE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Resolve a CLI binary the way the user's terminal would: through their login
/// shell, so PATH matches a real terminal (macOS GUI apps inherit a minimal PATH
/// that usually misses Homebrew, version managers, etc.). Returns the absolute
/// path, or `None` when the binary isn't found. Hits are memoised (see [`BINARY_CACHE`]).
pub fn discover_binary(name: &str) -> Option<String> {
    if let Some(hit) = BINARY_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(name)
        .cloned()
    {
        return Some(hit);
    }
    let resolved = resolve_binary(name);
    if let Some(path) = &resolved {
        BINARY_CACHE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name.to_string(), path.clone());
    }
    resolved
}

/// Whether `name` is safe to interpolate into [`resolve_binary`]'s shell command.
/// Enforced at the sink rather than trusted from callers: everything else in a
/// `$SHELL -lc "…"` string is quoting-sensitive, and a binary name only ever needs
/// these characters.
fn safe_binary_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The uncached login-shell PATH probe behind [`discover_binary`].
fn resolve_binary(name: &str) -> Option<String> {
    if !safe_binary_name(name) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-lc", &format!("command -v {name}")])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // A login shell may print extra lines; the resolved path is the last one.
    let path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())?
        .to_string();
    Some(path)
}

/// The user's PATH as a real login shell sees it — recovered by running
/// `$SHELL -lc 'printf …$PATH'`. A Finder-launched macOS bundle inherits a minimal
/// PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that misses Homebrew, version managers,
/// `direnv`, etc.; this returns the PATH a terminal would have. `None` if the
/// probe fails or yields nothing.
///
/// A sentinel marks the PATH line so noisy rc files (which print to stdout on
/// login-shell startup) can't corrupt the result.
pub fn login_shell_path() -> Option<String> {
    const MARK: &str = "__santree_path__=";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-lc", &format!("printf '%s%s\\n' '{MARK}' \"$PATH\"")])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|l| l.strip_prefix(MARK))
        .map(str::to_string)
        .filter(|p| !p.is_empty())
}

/// The user's global Claude commands directory (`~/.claude/commands`).
fn global_commands_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".claude").join("commands"))
}

/// Scan a `.claude/commands` directory for top-level `*.md` command files,
/// returning each command's invocation name and `description:` frontmatter,
/// sorted by name. A missing directory yields an empty list.
fn scan_commands(dir: &Path) -> Vec<ClaudeCommand> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut cmds: Vec<ClaudeCommand> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("md") {
                return None;
            }
            let name = path.file_stem()?.to_str()?.to_string();
            Some(ClaudeCommand {
                description: read_description(&path),
                name,
            })
        })
        .collect();
    cmds.sort_by(|a, b| a.name.cmp(&b.name));
    cmds
}

/// Validate an IPC-supplied command name is a single safe filename component
/// before it's joined into a `.claude/commands` path. Rejects anything with a
/// path separator, a leading dash/dot, or characters outside `[A-Za-z0-9._-]` —
/// so it can only ever name a plain `<name>.md` file in the commands dir, never
/// escape it (see the security invariants in CLAUDE.md).
fn safe_command_name(name: &str) -> Result<&str> {
    let ok = !name.is_empty()
        && !name.starts_with(['-', '.'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(name)
    } else {
        Err(anyhow::anyhow!("invalid command name: {name:?}"))
    }
}

/// A repo's `.claude/commands/<name>.md`, when it exists — the file Claude would
/// actually run in that repo (repo shadows global).
fn repo_command_path(repo_path: &str, name: &str) -> PathBuf {
    Path::new(repo_path)
        .join(".claude")
        .join("commands")
        .join(format!("{name}.md"))
}

/// Read the *effective* backing file for slash-command `name`: the repo's own copy
/// when present, else the global one. `repo_path` is the repo's filesystem root (or
/// `None` for the app scope, which only ever sees global commands).
pub fn read_command(repo_path: Option<&str>, name: &str) -> Result<ClaudeCommandFile> {
    let global = global_commands_dir().ok_or_else(|| anyhow::anyhow!("no home directory"))?;
    read_command_in(&global, repo_path, name)
}

/// [`read_command`] with the global commands dir injected, so tests can point it at
/// a fixture without mutating `HOME`.
fn read_command_in(
    global_dir: &Path,
    repo_path: Option<&str>,
    name: &str,
) -> Result<ClaudeCommandFile> {
    let name = safe_command_name(name)?;
    if let Some(repo) = repo_path {
        let p = repo_command_path(repo, name);
        if p.is_file() {
            let content = std::fs::read_to_string(&p)?;
            return Ok(ClaudeCommandFile {
                name: name.to_string(),
                source: CommandSource::Repo,
                path: p.display().to_string(),
                content,
            });
        }
    }
    let p = global_dir.join(format!("{name}.md"));
    let content = std::fs::read_to_string(&p)
        .map_err(|e| anyhow::anyhow!("can't read command '{name}': {e}"))?;
    Ok(ClaudeCommandFile {
        name: name.to_string(),
        source: CommandSource::Global,
        path: p.display().to_string(),
        content,
    })
}

/// Overwrite the backing file for slash-command `name` in the given `source`
/// (creating the commands dir if needed). `source` is taken from the matching
/// [`read_command`] so an edit always lands on the exact file that was loaded.
pub fn write_command(
    repo_path: Option<&str>,
    name: &str,
    source: CommandSource,
    content: &str,
) -> Result<()> {
    let global = global_commands_dir().ok_or_else(|| anyhow::anyhow!("no home directory"))?;
    write_command_in(&global, repo_path, name, source, content)
}

/// [`write_command`] with the global commands dir injected (see [`read_command_in`]).
fn write_command_in(
    global_dir: &Path,
    repo_path: Option<&str>,
    name: &str,
    source: CommandSource,
    content: &str,
) -> Result<()> {
    let name = safe_command_name(name)?;
    let dir = match source {
        CommandSource::Repo => {
            let repo =
                repo_path.ok_or_else(|| anyhow::anyhow!("a repo command needs a repo scope"))?;
            Path::new(repo).join(".claude").join("commands")
        }
        CommandSource::Global => global_dir.to_path_buf(),
    };
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(format!("{name}.md")), content)?;
    Ok(())
}

/// Pull the `description:` value from a command file's YAML frontmatter, if any.
fn read_description(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix("description:") {
            let val = rest.trim().trim_matches(['"', '\'']).trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use santree_core::domain::{AgentKind, AgentSetting, Integrations};
    use uuid::Uuid;

    use super::*;

    #[test]
    fn validate_user_scope_accepts_only_real_scopes() {
        assert!(validate_user_scope("app", "work_model").is_ok());
        assert!(validate_user_scope("repo:acme/app", "work_model").is_ok());

        // A typo'd scope used to write a row `resolve` would never read back.
        assert!(validate_user_scope("repo", "work_model").is_err());
        assert!(validate_user_scope("repo:", "work_model").is_err());
        assert!(validate_user_scope("App", "work_model").is_err());
        assert!(validate_user_scope("", "work_model").is_err());
        // An internal scope isn't reachable from the generic IPC surface.
        assert!(validate_user_scope("price_cache", "attempt_ms").is_err());
    }

    #[test]
    fn the_settings_blob_cannot_be_written_through_the_generic_surface() {
        assert!(validate_user_scope("app", SETTINGS_KEY).is_err());
        assert!(validate_user_scope("repo:acme/app", SETTINGS_KEY).is_err());
    }

    /// A real (temp-file-backed) SQLite pool, isolated per test — same pattern
    /// as `session::tests`. Each test gets its own fresh directory: `db::init`
    /// chmods the db's parent, which fails on the shared system temp root.
    async fn test_db() -> Db {
        let dir = std::env::temp_dir().join(format!("santree-settings-{}", Uuid::new_v4()));
        crate::db::init(dir.join("test.db")).await.unwrap()
    }

    #[tokio::test]
    async fn resolve_prefers_repo_override_then_falls_back_to_app_default() {
        let db = test_db().await;

        // No value anywhere yet.
        assert_eq!(resolve(&db, "canary", "theme").await.unwrap(), None);

        // App-scope default is used when there's no repo override.
        set(&db, "app", "theme", Some("dark".into())).await.unwrap();
        assert_eq!(
            resolve(&db, "canary", "theme").await.unwrap(),
            Some("dark".into())
        );

        // A repo override wins over the app default.
        set(&db, "repo:canary", "theme", Some("light".into()))
            .await
            .unwrap();
        assert_eq!(
            resolve(&db, "canary", "theme").await.unwrap(),
            Some("light".into())
        );
        // Other repos are unaffected.
        assert_eq!(
            resolve(&db, "other", "theme").await.unwrap(),
            Some("dark".into())
        );

        // Clearing the override (set to None) falls back to the app value again.
        set(&db, "repo:canary", "theme", None).await.unwrap();
        assert_eq!(
            resolve(&db, "canary", "theme").await.unwrap(),
            Some("dark".into())
        );
        assert_eq!(get(&db, "repo:canary", "theme").await.unwrap(), None);
    }

    #[tokio::test]
    async fn get_settings_defaults_to_config_when_unset() {
        let db = test_db().await;
        assert_eq!(get_settings(&db).await.unwrap(), config::default_settings());
    }

    #[tokio::test]
    async fn set_settings_round_trips_the_full_blob() {
        let db = test_db().await;

        let settings = Settings {
            default_agent: AgentKind::Codex,
            integrations: Integrations {
                linear: false,
                triage: true,
            },
            agents: vec![AgentSetting {
                key: AgentKind::Codex,
                exec: "/usr/local/bin/codex".into(),
                model: "gpt-5-codex".into(),
            }],
        };

        set_settings(&db, &settings).await.unwrap();
        assert_eq!(get_settings(&db).await.unwrap(), settings);

        // Overwriting persists the new value, not a merge of old + new.
        let updated = Settings {
            default_agent: AgentKind::Claude,
            ..settings
        };
        set_settings(&db, &updated).await.unwrap();
        assert_eq!(get_settings(&db).await.unwrap(), updated);
    }

    /// Simulates a settings blob stored before a field existed: `integrations`
    /// is missing `triage` entirely, and the top-level `agents` array is
    /// missing altogether. `#[serde(default)]` on `Settings`/`Integrations`
    /// must backfill just the missing pieces (from their `Default` impls,
    /// seeded from `config::default_settings()`) rather than the whole blob
    /// falling back to `config::default_settings()` wholesale and discarding
    /// the fields that ARE present.
    #[test]
    fn settings_deserialize_backfills_missing_fields_per_field_not_wholesale() {
        let json = r#"{
            "defaultAgent": "Codex",
            "integrations": { "linear": false }
        }"#;
        let settings: Settings = serde_json::from_str(json).unwrap();

        assert_eq!(
            settings.default_agent,
            AgentKind::Codex,
            "present top-level field is preserved"
        );
        assert!(
            !settings.integrations.linear,
            "present nested field is preserved"
        );
        assert!(
            settings.integrations.triage,
            "missing nested field falls back to its own default, not to a bare `false`"
        );
        assert_eq!(
            settings.agents,
            config::default_settings().agents,
            "missing top-level field falls back to the canonical agent catalog"
        );
    }

    /// `resolve_binary` interpolates the name into a `$SHELL -lc` string, so anything
    /// that could break out of it (or inject a flag) must never reach the shell.
    #[test]
    fn safe_binary_name_rejects_shell_metacharacters() {
        assert!(safe_binary_name("claude"));
        assert!(safe_binary_name("cursor-agent"));
        assert!(safe_binary_name("node_18.x"));
        assert!(!safe_binary_name("gh; rm -rf ~"));
        assert!(!safe_binary_name("$(id)"));
        assert!(!safe_binary_name("gh `id`"));
        assert!(!safe_binary_name("/usr/bin/gh"));
        assert!(!safe_binary_name(""));
        // Rejected names take the not-found path instead of shelling out.
        assert_eq!(resolve_binary("gh; touch /tmp/santree-pwned"), None);
    }

    #[test]
    fn safe_command_name_rejects_traversal_and_separators() {
        assert!(safe_command_name("investigate-ticket").is_ok());
        assert!(safe_command_name("fix_ci.v2").is_ok());
        // Anything that could escape the commands dir or inject a flag is refused.
        assert!(safe_command_name("../etc/passwd").is_err());
        assert!(safe_command_name("a/b").is_err());
        assert!(safe_command_name(".hidden").is_err());
        assert!(safe_command_name("-rf").is_err());
        assert!(safe_command_name("").is_err());
        assert!(safe_command_name("has space").is_err());
    }

    #[test]
    fn read_write_command_resolves_repo_over_global_in_place() {
        let dir = std::env::temp_dir().join(format!("santree-cmd-{}", Uuid::new_v4()));
        let global = dir.join("home").join(".claude").join("commands");
        let repo = dir.join("repo");
        std::fs::create_dir_all(&global).unwrap();
        std::fs::create_dir_all(repo.join(".claude").join("commands")).unwrap();
        std::fs::write(global.join("inv.md"), "GLOBAL").unwrap();
        let repo_path = repo.to_str().unwrap();

        // No repo copy yet → the global file is the effective one.
        let f = read_command_in(&global, Some(repo_path), "inv").unwrap();
        assert_eq!(f.source, CommandSource::Global);
        assert_eq!(f.content, "GLOBAL");

        // Writing a repo-scoped copy lands in the repo, leaving global untouched.
        write_command_in(&global, Some(repo_path), "inv", CommandSource::Repo, "REPO").unwrap();
        assert_eq!(
            std::fs::read_to_string(global.join("inv.md")).unwrap(),
            "GLOBAL",
            "global file is not clobbered by a repo-scoped write"
        );

        // Now the repo copy shadows global (Claude's own resolution).
        let f = read_command_in(&global, Some(repo_path), "inv").unwrap();
        assert_eq!(f.source, CommandSource::Repo);
        assert_eq!(f.content, "REPO");

        // Editing that in place updates the repo file.
        write_command_in(
            &global,
            Some(repo_path),
            "inv",
            CommandSource::Repo,
            "REPO2",
        )
        .unwrap();
        assert_eq!(
            read_command_in(&global, Some(repo_path), "inv")
                .unwrap()
                .content,
            "REPO2"
        );

        // App scope only ever sees the global file.
        let f = read_command_in(&global, None, "inv").unwrap();
        assert_eq!(f.source, CommandSource::Global);
        assert_eq!(f.content, "GLOBAL");
    }
}
