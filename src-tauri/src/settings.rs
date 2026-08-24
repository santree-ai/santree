//! Generic app/per-repo key-value settings (the `settings` table).
//!
//! `scope` is `"app"` or `"repo:<name>"`: a repo value overrides the app value
//! for the same key, and absence falls back to the app value (see [`resolve`]).

use std::path::{Path, PathBuf};

use anyhow::Result;

use santree_core::config;
use santree_core::domain::{AgentAuth, AgentKind, BinaryStatus, Settings};

use crate::db::Db;

/// The `settings` key under which the full [`Settings`] blob is persisted (scope `"app"`).
const SETTINGS_KEY: &str = "settings";
const CODEX_DEFAULT_MIGRATION_KEY: &str = "migration.codex_default_v1";
const HELPER_AGENTS_MIGRATION_KEY: &str = "migration.helper_agents_v1";

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
    // Binary paths get executed, so they go through `set_binary_path`, which
    // validates and refreshes the in-process override map. Written through here
    // they'd skip both — landing a row that never takes effect until restart, and
    // never gets checked at all.
    if key.starts_with("binary_path.") {
        anyhow::bail!("binary paths must be written through set_binary_path");
    }
    // The keep-awake hold is a live `caffeinate` child, not just a row: writing it
    // here would be remembered for the next launch without holding anything awake
    // now (and the toggle's icon would disagree with the machine). It has its own
    // command ([`set_keep_awake`]).
    if key == crate::awake::KEEP_AWAKE_KEY {
        anyhow::bail!("the keep-awake hold must be written through set_keep_awake");
    }
    Ok(())
}

/// Read a setting for an exact scope (`"app"` or `"repo:<name>"`).
///
/// [`env::ENV_VARS_KEY`](crate::env::ENV_VARS_KEY) is the one key whose stored
/// value isn't the whole story: its variable *values* are secrets and live in the
/// OS keychain, so it's reassembled by `env`. Dispatching here rather than at the
/// IPC layer makes this the single door every reader and writer goes through —
/// see `env`'s module docs.
pub async fn get(db: &Db, scope: &str, key: &str) -> Result<Option<String>> {
    if key == crate::env::ENV_VARS_KEY {
        return crate::env::vars_json(db, scope).await;
    }
    get_raw(db, scope, key).await
}

/// Upsert (`Some`) or clear (`None`) a setting for a scope. Dispatches
/// [`env::ENV_VARS_KEY`](crate::env::ENV_VARS_KEY) — see [`get`].
pub async fn set(db: &Db, scope: &str, key: &str, value: Option<String>) -> Result<()> {
    if key == crate::env::ENV_VARS_KEY {
        return crate::env::set_vars_json(db, scope, value).await;
    }
    set_raw(db, scope, key, value).await
}

/// The row exactly as stored, with no dispatch. Only `env` (which owns the split
/// [`get`] hides) should need this.
pub async fn get_raw(db: &Db, scope: &str, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM settings WHERE scope = ? AND key = ?")
            .bind(scope)
            .bind(key)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(v,)| v))
}

/// Write the row exactly as given, with no dispatch — the counterpart of [`get_raw`].
pub async fn set_raw(db: &Db, scope: &str, key: &str, value: Option<String>) -> Result<()> {
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
///
/// Raw rows, so *not* a way to read [`env::ENV_VARS_KEY`](crate::env::ENV_VARS_KEY)
/// (its values aren't in the table — see [`get`]). Env vars don't resolve like this
/// anyway: the two scopes merge per variable rather than one shadowing the other, in
/// `env::resolve_env`.
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

pub fn provider_setting_key(key: &str, agent: santree_core::domain::AgentKind) -> String {
    format!("{key}__{}", agent.as_str().to_ascii_lowercase())
}

pub(crate) fn legacy_value_matches_provider(key: &str, value: &str, agent: AgentKind) -> bool {
    if !key.ends_with("_model") {
        return true;
    }
    let claude_model = value.starts_with("claude-") || matches!(value, "opus" | "sonnet" | "haiku");
    match agent {
        AgentKind::Claude => claude_model,
        AgentKind::Codex => !claude_model,
        AgentKind::Cursor | AgentKind::Opencode => true,
    }
}

/// Resolve a provider-specific workflow profile. Legacy unsuffixed settings are
/// accepted only for the workflow's selected provider, so switching providers
/// can never feed one vendor's model id to another vendor's CLI.
pub async fn resolve_provider(
    db: &Db,
    repo: &str,
    key: &str,
    agent_key: &str,
    agent: santree_core::domain::AgentKind,
) -> Result<Option<String>> {
    if let Some(value) = resolve(db, repo, &provider_setting_key(key, agent)).await? {
        return Ok(Some(value));
    }
    let selected = resolve(db, repo, agent_key).await?;
    if selected.as_deref() == Some(agent.as_str()) {
        return Ok(resolve(db, repo, key)
            .await?
            .filter(|value| legacy_value_matches_provider(key, value, agent)));
    }
    Ok(None)
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
    set(db, "app", SETTINGS_KEY, Some(json)).await?;
    // An agent's `exec` feeds the override map, so a save that changes one has to
    // be reflected before the next lookup — otherwise it applies to interactive
    // launches immediately and to the headless helpers only after a restart.
    refresh_binary_overrides(db).await
}

/// One-time adoption of Codex defaults. Historical/custom Claude choices are
/// preserved: only the exact previously-shipped tuple (or an entirely unset
/// action tuple) moves. The marker prevents a later user choice from ever being
/// rewritten by another startup.
pub async fn migrate_codex_defaults(db: &Db) -> Result<()> {
    if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM settings WHERE scope = 'app' AND key = ?")
        .bind(CODEX_DEFAULT_MIGRATION_KEY)
        .fetch_one(db)
        .await?
        > 0
    {
        return migrate_helper_agents(db).await;
    }
    let mut tx = db.begin().await?;
    let stored: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE scope = 'app' AND key = ?")
            .bind(SETTINGS_KEY)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some(raw) = stored {
        if let Ok(mut settings) = serde_json::from_str::<Settings>(&raw) {
            let claude_is_shipped = settings
                .agents
                .iter()
                .find(|a| a.key == AgentKind::Claude)
                .is_some_and(|a| a.model == "sonnet" && a.exec.is_empty());
            let codex_is_shipped = settings
                .agents
                .iter()
                .find(|a| a.key == AgentKind::Codex)
                .is_some_and(|a| a.model == "gpt-5-codex" && a.exec.is_empty());
            if settings.default_agent == AgentKind::Claude && claude_is_shipped && codex_is_shipped
            {
                settings.default_agent = AgentKind::Codex;
                if let Some(codex) = settings
                    .agents
                    .iter_mut()
                    .find(|a| a.key == AgentKind::Codex)
                {
                    codex.model.clear();
                }
                sqlx::query("UPDATE settings SET value = ? WHERE scope = 'app' AND key = ?")
                    .bind(serde_json::to_string(&settings)?)
                    .bind(SETTINGS_KEY)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    for (agent_key, model_key, effort_key) in [
        ("work_agent", "work_model", "work_effort"),
        (
            "investigate_agent",
            "investigate_model",
            "investigate_effort",
        ),
    ] {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT key, value FROM settings WHERE scope = 'app' AND key IN (?, ?, ?)",
        )
        .bind(agent_key)
        .bind(model_key)
        .bind(effort_key)
        .fetch_all(&mut *tx)
        .await?;
        let value = |key: &str| rows.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str());
        let shipped_or_unset = value(agent_key).is_none_or(|v| v == "Claude")
            && value(model_key).is_none_or(|v| v.is_empty() || v == "sonnet")
            && value(effort_key).is_none_or(|v| v.is_empty());
        if shipped_or_unset {
            for (key, next) in [(agent_key, "Codex"), (model_key, ""), (effort_key, "")] {
                sqlx::query(
                    "INSERT INTO settings (scope, key, value) VALUES ('app', ?, ?)
                     ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
                )
                .bind(key)
                .bind(next)
                .execute(&mut *tx)
                .await?;
            }
        }
    }
    sqlx::query("INSERT INTO settings (scope, key, value) VALUES ('app', ?, 'done')")
        .bind(CODEX_DEFAULT_MIGRATION_KEY)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    migrate_helper_agents(db).await
}

/// Materialize the two helper assignments once so they remain independent when
/// Work's provider changes later. Existing explicit helper choices always win.
async fn migrate_helper_agents(db: &Db) -> Result<()> {
    if get(db, "app", HELPER_AGENTS_MIGRATION_KEY).await?.is_some() {
        return Ok(());
    }
    let settings = get_settings(db).await?;
    let fallback = get(db, "app", "work_agent")
        .await?
        .unwrap_or_else(|| settings.default_agent.as_str().to_string());
    let mut tx = db.begin().await?;
    for key in ["commit_message_agent", "pr_body_agent"] {
        sqlx::query(
            "INSERT INTO settings (scope, key, value) VALUES ('app', ?, ?)
             ON CONFLICT (scope, key) DO NOTHING",
        )
        .bind(key)
        .bind(&fallback)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("INSERT INTO settings (scope, key, value) VALUES ('app', ?, 'done')")
        .bind(HELPER_AGENTS_MIGRATION_KEY)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
/// The CLI binary name probed on PATH for each harness.
pub fn agent_binary(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
        AgentKind::Cursor => "cursor-agent",
        AgentKind::Opencode => "opencode",
    }
}

/// Resolve the exact executable for an interactive provider launch. The same
/// absolute path is returned to the terminal and used by any provider control
/// process, so a configured bare name cannot resolve to two different CLIs.
pub async fn agent_executable(db: &Db, kind: AgentKind) -> Result<String> {
    // The dedicated binary-path setting is the highest-precedence, validated
    // override. `refresh_binary_overrides` also places an absolute agent exec
    // here when no dedicated override exists.
    if let Some(path) = binary_override(agent_binary(kind)) {
        return Ok(std::fs::canonicalize(path)?.to_string_lossy().into_owned());
    }
    let settings = get_settings(db).await?;
    let configured = settings
        .agents
        .iter()
        .find(|agent| agent.key == kind)
        .map(|agent| agent.exec.trim())
        .filter(|exec| !exec.is_empty());
    let candidate = configured.unwrap_or_else(|| agent_binary(kind));
    if Path::new(candidate).is_absolute() {
        let resolved = std::fs::canonicalize(candidate).map_err(|_| {
            anyhow::anyhow!("{} executable {candidate:?} was not found", kind.as_str())
        })?;
        if !is_executable_file(&resolved) {
            anyhow::bail!(
                "{} executable {candidate:?} is not executable",
                kind.as_str()
            );
        }
        return Ok(resolved.to_string_lossy().into_owned());
    }
    discover_binary(candidate)
        .ok_or_else(|| anyhow::anyhow!("{} executable {candidate:?} was not found", kind.as_str()))
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

/// The settings key holding a user-set absolute path for `name` (scope `"app"`).
pub fn binary_path_key(name: &str) -> String {
    format!("binary_path.{name}")
}

/// User-set binary paths, mirrored out of the `settings` table.
///
/// [`discover_binary`] is sync and called from places with no `Db` handle, so the
/// overrides are loaded once at startup ([`load_binary_overrides`]) and updated in
/// place whenever one is written ([`set_binary_override`]) rather than read from
/// SQLite per lookup.
static BINARY_OVERRIDES: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, String>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Rebuild [`BINARY_OVERRIDES`] from the database. Call at startup and after any
/// write that could change it.
///
/// Two sources, in precedence order:
///  1. an agent's **`exec`**, when the user set it to an absolute path. Without
///     this, that setting only steered *interactive* launches (the frontend reads
///     it directly) while every headless helper — commit message, PR body, review
///     brief, English analysis — kept resolving `claude` on its own and silently
///     ran a different binary.
///  2. an explicit **`binary_path.<name>`**, which wins: it's the validated,
///     purpose-built override, and the only one that can name a binary no agent
///     corresponds to (`gh`).
pub async fn refresh_binary_overrides(db: &Db) -> Result<()> {
    let mut next: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for agent in get_settings(db).await?.agents {
        let exec = agent.exec.trim();
        // A bare name (the default, `"claude"`) is not an override — it's just the
        // thing discovery was going to look for anyway.
        if Path::new(exec).is_absolute() {
            next.insert(agent_binary(agent.key).to_string(), exec.to_string());
        }
    }

    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM settings WHERE scope = 'app' AND key LIKE ?")
            .bind("binary_path.%")
            .fetch_all(db)
            .await?;
    for (key, value) in rows {
        if let Some(name) = key.strip_prefix("binary_path.") {
            next.insert(name.to_string(), value);
        }
    }

    let mut map = BINARY_OVERRIDES.lock().unwrap_or_else(|e| e.into_inner());
    *map = next;
    drop(map);
    // Anything resolved under the previous set may now be wrong.
    BINARY_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    Ok(())
}

/// Set (or clear, with `None`) the override for `name` and drop any memoised
/// resolution for it, so the next lookup reflects the change without a restart.
pub fn set_binary_override(name: &str, path: Option<&str>) {
    let mut map = BINARY_OVERRIDES.lock().unwrap_or_else(|e| e.into_inner());
    match path {
        Some(p) => map.insert(name.to_string(), p.to_string()),
        None => map.remove(name),
    };
    BINARY_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(name);
}

/// The override for `name`, if the user set one and it's still executable. A
/// stale override (the binary was removed or moved) falls through to discovery
/// rather than failing every call — better to quietly find a working one than to
/// stay broken until the user notices the setting.
fn binary_override(name: &str) -> Option<String> {
    let path = BINARY_OVERRIDES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(name)
        .cloned()?;
    is_executable_file(Path::new(&path)).then_some(path)
}

/// Resolve a CLI binary the way the user's terminal would: through their login
/// shell, so PATH matches a real terminal (macOS GUI apps inherit a minimal PATH
/// that usually misses Homebrew, version managers, etc.). Returns the absolute
/// path, or `None` when the binary isn't found. Hits are memoised (see [`BINARY_CACHE`]).
///
/// A user-set path ([`set_binary_override`]) wins over discovery — it's the escape
/// hatch for installs no probe finds, and for choosing between several copies.
pub fn discover_binary(name: &str) -> Option<String> {
    if let Some(path) = binary_override(name) {
        return Some(path);
    }
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

/// What santree resolves `name` to right now, plus the override behind it and the
/// binary's own `--version`. Blocking (discovery may spawn a shell).
pub fn binary_status(name: &str) -> BinaryStatus {
    let override_path = BINARY_OVERRIDES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(name)
        .cloned();
    let path = discover_binary(name);
    let version = path.as_deref().and_then(probe_version);
    BinaryStatus {
        name: name.to_string(),
        path,
        override_path,
        version,
    }
}

/// First line of `<path> --version`, or `None` if it can't run or says nothing.
/// The path is executed directly — never through a shell, so nothing in it is
/// interpreted.
fn probe_version(path: &str) -> Option<String> {
    let out = std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// Persist a user-set path for `name` (or clear it with `None`) and return the
/// resulting status.
///
/// Validated at the sink, because this value is later **executed**: it has to be
/// an absolute path to a file with an execute bit. A relative path would resolve
/// against whatever cwd the caller happens to have, and a path to a directory or a
/// non-executable fails later, somewhere far less obvious than this input.
pub async fn set_binary_path(db: &Db, name: &str, path: Option<String>) -> Result<BinaryStatus> {
    if !safe_binary_name(name) {
        anyhow::bail!("invalid binary name {name:?}");
    }
    let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    if let Some(p) = &path {
        let candidate = Path::new(p);
        if !candidate.is_absolute() {
            anyhow::bail!("enter an absolute path (starting with /) — got {p:?}");
        }
        if !candidate.exists() {
            anyhow::bail!("nothing exists at {p}");
        }
        if !is_executable_file(candidate) {
            anyhow::bail!("{p} isn't an executable file");
        }
    }
    set(db, "app", &binary_path_key(name), path.clone()).await?;
    set_binary_override(name, path.as_deref());
    Ok(binary_status(name))
}

/// Whether `p` is something we could actually execute.
fn is_executable_file(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Directories to probe by hand when no shell reports the binary.
///
/// The shell probes below cover the usual cases, but they inherit whatever the
/// user's rc files happen to set — and package managers disagree about where that
/// belongs. Nix's macOS installer, for one, writes its hook into `/etc/zshrc`,
/// which zsh reads for *interactive* shells only: `zsh -lc` never sees it, so a
/// perfectly good `gh` in `~/.nix-profile/bin` reads as "not installed". Probing
/// the known roots directly is the backstop that doesn't care whose rc file it is.
fn well_known_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = &home {
        dirs.push(home.join(".nix-profile/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join("bin"));
    }
    dirs.extend(
        [
            "/nix/var/nix/profiles/default/bin",
            "/run/current-system/sw/bin", // nix-darwin / NixOS
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
        .map(PathBuf::from),
    );
    dirs
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

/// The uncached probe behind [`discover_binary`], in three tiers, cheapest first:
///
/// 1. `$SHELL -lc` — a **login, non-interactive** shell. Covers the common case
///    (Homebrew, version managers) in one spawn.
/// 2. `$SHELL -ilc` — login **and interactive**, which is what actually reads
///    `.zshrc` / `/etc/zshrc`. zsh sources those for interactive shells only, so
///    tier 1 is blind to anything configured there — Nix's macOS installer being
///    the case that prompted this. Only run on a tier-1 miss, since an interactive
///    rc file can be slow (prompt frameworks, completion init).
/// 3. [`well_known_dirs`] — a direct filesystem probe, for when the binary isn't
///    on any shell's PATH or `$SHELL` is something whose flags don't mean this
///    (fish, nushell). Costs no process at all.
fn resolve_binary(name: &str) -> Option<String> {
    if !safe_binary_name(name) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    for flags in ["-lc", "-ilc"] {
        if let Some(path) = shell_probe(&shell, flags, name) {
            return Some(path);
        }
    }
    well_known_dirs()
        .into_iter()
        .map(|d| d.join(name))
        .find(|p| is_executable_file(p))
        .map(|p| p.to_string_lossy().into_owned())
}

/// One `command -v` through `shell` with `flags`. `None` if the shell errors, the
/// binary isn't found, or what came back isn't an executable file — an rc file that
/// prints on startup can otherwise pass its own chatter off as a path.
fn shell_probe(shell: &str, flags: &str, name: &str) -> Option<String> {
    let output = std::process::Command::new(shell)
        .args([flags, &format!("command -v {name}")])
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
    is_executable_file(Path::new(&path)).then_some(path)
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
    let ask = |flags: &str| -> Option<String> {
        let output = std::process::Command::new(&shell)
            .args([flags, &format!("printf '%s%s\\n' '{MARK}' \"$PATH\"")])
            .output()
            .ok()?;
        output.status.success().then_some(())?;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .find_map(|l| l.strip_prefix(MARK))
            .map(str::to_string)
            .filter(|p| !p.is_empty())
    };

    // Both shells, then the known roots — for the same reason [`resolve_binary`]
    // has tiers: `-lc` never reads `.zshrc`/`/etc/zshrc`, where Nix (among others)
    // puts its PATH setup. These are *merged* rather than first-wins, because each
    // source legitimately contributes entries the others don't.
    let mut merged: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |entry: String| {
        if !entry.is_empty() && seen.insert(entry.clone()) {
            merged.push(entry);
        }
    };
    for flags in ["-lc", "-ilc"] {
        for entry in ask(flags).unwrap_or_default().split(':') {
            push(entry.to_string());
        }
    }
    for dir in well_known_dirs() {
        if dir.is_dir() {
            push(dir.to_string_lossy().into_owned());
        }
    }
    (!merged.is_empty()).then(|| merged.join(":"))
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

    /// Binary paths are executed, so they must not be reachable from the generic
    /// key-value surface — that route skips validation *and* the in-process map.
    #[test]
    fn binary_paths_cannot_be_written_through_the_generic_surface() {
        assert!(validate_user_scope("app", &binary_path_key("gh")).is_err());
        assert!(validate_user_scope("app", "binary_path.claude").is_err());
        // Neighbouring keys are unaffected.
        assert!(validate_user_scope("app", "binary_pathological").is_ok());
    }

    /// The backstop that fixes the Nix case: a binary on no shell's PATH is still
    /// found when it sits in a known root.
    #[test]
    fn well_known_dirs_cover_the_nix_install_roots() {
        let dirs: Vec<String> = well_known_dirs()
            .iter()
            .map(|d| d.to_string_lossy().into_owned())
            .collect();
        assert!(
            dirs.iter().any(|d| d.ends_with("/.nix-profile/bin")),
            "{dirs:?}"
        );
        assert!(
            dirs.iter()
                .any(|d| d == "/nix/var/nix/profiles/default/bin"),
            "{dirs:?}"
        );
        assert!(
            dirs.iter().any(|d| d == "/run/current-system/sw/bin"),
            "{dirs:?}"
        );
        assert!(dirs.iter().any(|d| d == "/opt/homebrew/bin"), "{dirs:?}");
    }

    #[test]
    fn only_executable_files_count_as_binaries() {
        let dir = std::env::temp_dir().join(format!("santree-bin-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("plain");
        std::fs::write(&plain, "#!/bin/sh\n").unwrap();

        // A readable file with no execute bit is not a binary — treating it as one
        // stores a path that fails at spawn time, far from this input.
        assert!(!is_executable_file(&plain));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(is_executable_file(&plain));
        }
        // A directory never counts, however executable it looks.
        assert!(!is_executable_file(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn a_manual_binary_path_must_be_absolute_and_executable() {
        let db = test_db().await;
        let dir = std::env::temp_dir().join(format!("santree-bin-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let not_exec = dir.join("gh");
        std::fs::write(&not_exec, "").unwrap();

        for bad in [
            "gh".to_string(),                   // relative — resolves against an unknown cwd
            "/nope/does/not/exist".to_string(), // absent
            not_exec.to_string_lossy().into_owned(), // present but not executable
        ] {
            assert!(
                set_binary_path(&db, "gh", Some(bad.clone())).await.is_err(),
                "should have rejected {bad:?}"
            );
        }
        // Rejected input leaves nothing behind.
        assert!(get(&db, "app", &binary_path_key("gh"))
            .await
            .unwrap()
            .is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn an_explicit_binary_path_outranks_an_agent_exec() {
        let db = test_db().await;
        let mut settings = config::default_settings();
        settings.agents = vec![AgentSetting {
            key: AgentKind::Claude,
            exec: "/usr/bin/true".into(),
            model: "opus".into(),
        }];
        set_settings(&db, &settings).await.unwrap();

        // The agent's absolute exec becomes the override, so the headless helpers
        // resolve the same binary the interactive launch uses.
        refresh_binary_overrides(&db).await.unwrap();
        assert_eq!(binary_override("claude").as_deref(), Some("/usr/bin/true"));

        // An explicit path wins — it's the validated, purpose-built one.
        set_binary_path(&db, "claude", Some("/bin/echo".into()))
            .await
            .unwrap();
        refresh_binary_overrides(&db).await.unwrap();
        assert_eq!(binary_override("claude").as_deref(), Some("/bin/echo"));
        assert_eq!(
            agent_executable(&db, AgentKind::Claude).await.unwrap(),
            std::fs::canonicalize("/bin/echo")
                .unwrap()
                .to_string_lossy()
        );

        // Clearing it falls back to the agent exec rather than to nothing.
        set_binary_path(&db, "claude", None).await.unwrap();
        refresh_binary_overrides(&db).await.unwrap();
        assert_eq!(binary_override("claude").as_deref(), Some("/usr/bin/true"));
        assert_eq!(
            agent_executable(&db, AgentKind::Claude).await.unwrap(),
            std::fs::canonicalize("/usr/bin/true")
                .unwrap()
                .to_string_lossy()
        );
    }

    /// A bare command name is what discovery would look for anyway, so it must not
    /// be stored as an override — doing so would short-circuit the probe with a
    /// path that isn't one.
    #[tokio::test]
    async fn a_bare_agent_exec_is_not_treated_as_an_override() {
        let db = test_db().await;
        let mut settings = config::default_settings();
        settings.agents = vec![AgentSetting {
            key: AgentKind::Claude,
            exec: "claude".into(),
            model: "opus".into(),
        }];
        set_settings(&db, &settings).await.unwrap();
        refresh_binary_overrides(&db).await.unwrap();
        assert_eq!(binary_override("claude"), None);
    }

    /// A real (temp-file-backed) SQLite pool, isolated per test — same pattern
    /// as `session::tests`. Each test gets its own fresh directory: `db::init`
    /// chmods the db's parent, which fails on the shared system temp root.
    async fn test_db() -> Db {
        let dir = std::env::temp_dir().join(format!("santree-settings-{}", Uuid::new_v4()));
        crate::db::init(dir.join("test.db")).await.unwrap()
    }

    /// Migration 0016, run against a database that looks like one 0015 has already
    /// pruned: the rows keyed on the deleted repo's *name* are gone, and everything
    /// belonging to a live repo — plus the `app` and `price_cache` scopes — survives.
    /// It executes the shipped `.sql` itself, so the test can't drift from it.
    #[tokio::test]
    async fn orphaned_repo_rows_are_swept_and_live_ones_are_not() {
        let db = test_db().await;

        sqlx::query("INSERT INTO repos (name, path) VALUES ('acme/live', '/repos/live')")
            .execute(&db)
            .await
            .unwrap();

        // Two of everything: one for the repo that still exists, one for a repo whose
        // row 0015 deleted (a second checkout that derived the same name).
        for (repo, note) in [("acme/live", "keep"), ("acme/gone", "drop")] {
            set(&db, &format!("repo:{repo}"), "theme", Some(note.into()))
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO task_notes (repo, task_id, body, updated_at)
                 VALUES (?, 'AK-1', ?, 0)",
            )
            .bind(repo)
            .bind(note)
            .execute(&db)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO commit_drafts (repo, issue_id, message, updated_at)
                 VALUES (?, 'AK-1', ?, 0)",
            )
            .bind(repo)
            .bind(note)
            .execute(&db)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO terminal_sessions (repo, term_key, cwd, session_id)
                 VALUES (?, 'tree:AK-1', '/tmp', ?)",
            )
            .bind(repo)
            .bind(note)
            .execute(&db)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO worktree_tabs (id, repo, worktree_id, kind, title, position)
                 VALUES (?, ?, 'AK-1', 'terminal', ?, 1)",
            )
            .bind(format!("tab-{repo}"))
            .bind(repo)
            .bind(note)
            .execute(&db)
            .await
            .unwrap();
        }
        // Scopes that aren't a repo's must be untouchable by this sweep.
        set(&db, "app", "theme", Some("keep".into())).await.unwrap();
        set_raw(&db, "price_cache", "attempt_ms", Some("keep".into()))
            .await
            .unwrap();

        sqlx::raw_sql(include_str!("../migrations/0016_orphaned_repo_rows.sql"))
            .execute(&db)
            .await
            .unwrap();

        let survivors = |table: &'static str, column: &'static str| {
            let db = db.clone();
            async move {
                sqlx::query_scalar::<_, String>(&format!("SELECT {column} FROM {table} ORDER BY 1"))
                    .fetch_all(&db)
                    .await
                    .unwrap()
            }
        };
        assert_eq!(
            survivors("settings", "scope").await,
            ["app", "price_cache", "repo:acme/live"],
            "only the dead repo's scope is swept"
        );
        for table in [
            "task_notes",
            "commit_drafts",
            "terminal_sessions",
            "worktree_tabs",
        ] {
            assert_eq!(
                survivors(table, "repo").await,
                ["acme/live"],
                "{table}: the live repo's row must survive and the orphan must not"
            );
        }
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
    async fn provider_profiles_are_independent_and_reject_cross_provider_legacy_models() {
        let db = test_db().await;
        set(&db, "app", "work_agent", Some("Claude".into()))
            .await
            .unwrap();
        set(&db, "app", "work_model", Some("gpt-5.6-sol".into()))
            .await
            .unwrap();

        assert_eq!(
            resolve_provider(&db, "repo", "work_model", "work_agent", AgentKind::Claude)
                .await
                .unwrap(),
            None
        );
        set(
            &db,
            "app",
            &provider_setting_key("work_model", AgentKind::Claude),
            Some("claude-opus-5".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            resolve_provider(&db, "repo", "work_model", "work_agent", AgentKind::Claude)
                .await
                .unwrap()
                .as_deref(),
            Some("claude-opus-5")
        );
        assert_eq!(
            resolve_provider(&db, "repo", "work_model", "work_agent", AgentKind::Codex)
                .await
                .unwrap(),
            None
        );
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

    #[tokio::test]
    async fn codex_default_migration_moves_only_the_shipped_tuple_once() {
        let db = test_db().await;
        let mut old = config::default_settings();
        old.default_agent = AgentKind::Claude;
        old.agents
            .iter_mut()
            .find(|a| a.key == AgentKind::Codex)
            .unwrap()
            .model = "gpt-5-codex".into();
        set_settings(&db, &old).await.unwrap();

        migrate_codex_defaults(&db).await.unwrap();
        let migrated = get_settings(&db).await.unwrap();
        assert_eq!(migrated.default_agent, AgentKind::Codex);
        assert_eq!(
            migrated
                .agents
                .iter()
                .find(|a| a.key == AgentKind::Codex)
                .unwrap()
                .model,
            ""
        );
        assert_eq!(
            get(&db, "app", "work_agent").await.unwrap().as_deref(),
            Some("Codex")
        );
        assert_eq!(
            get(&db, "app", "investigate_agent")
                .await
                .unwrap()
                .as_deref(),
            Some("Codex")
        );

        let mut user_choice = migrated;
        user_choice.default_agent = AgentKind::Claude;
        set_settings(&db, &user_choice).await.unwrap();
        migrate_codex_defaults(&db).await.unwrap();
        assert_eq!(
            get_settings(&db).await.unwrap().default_agent,
            AgentKind::Claude
        );
    }

    #[tokio::test]
    async fn codex_default_migration_preserves_custom_claude_actions() {
        let db = test_db().await;
        set(&db, "app", "work_agent", Some("Claude".into()))
            .await
            .unwrap();
        set(&db, "app", "work_model", Some("opus".into()))
            .await
            .unwrap();
        migrate_codex_defaults(&db).await.unwrap();
        assert_eq!(
            get(&db, "app", "work_agent").await.unwrap().as_deref(),
            Some("Claude")
        );
        assert_eq!(
            get(&db, "app", "work_model").await.unwrap().as_deref(),
            Some("opus")
        );
    }

    #[tokio::test]
    async fn helper_agent_migration_materializes_independent_choices_once() {
        let db = test_db().await;
        set(&db, "app", "work_agent", Some("Claude".into()))
            .await
            .unwrap();
        set(&db, "app", "commit_message_agent", Some("Codex".into()))
            .await
            .unwrap();

        migrate_helper_agents(&db).await.unwrap();
        assert_eq!(
            get(&db, "app", "commit_message_agent")
                .await
                .unwrap()
                .as_deref(),
            Some("Codex")
        );
        assert_eq!(
            get(&db, "app", "pr_body_agent").await.unwrap().as_deref(),
            Some("Claude")
        );

        set(&db, "app", "work_agent", Some("Codex".into()))
            .await
            .unwrap();
        migrate_helper_agents(&db).await.unwrap();
        assert_eq!(
            get(&db, "app", "pr_body_agent").await.unwrap().as_deref(),
            Some("Claude")
        );
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
}
