//! User-configured environment for santree-spawned terminals.
//!
//! The Environment settings let the user define variables (and reference `.env`
//! files) that santree injects into every terminal it spawns — triage
//! investigations, worktree agents, the Terminal tab, and extra Claude tabs.
//! This is the user's *own* project environment (a `DATABASE_URL`, a service key
//! their code needs), exactly what an IDE's integrated terminal provides. It is
//! explicitly NOT a channel for an agent CLI's auth tokens — see COMPLIANCE.md.
//!
//! Values are stored plaintext in the generic `settings` table (scope `app` or
//! `repo:<name>`) as JSON, alongside every other preference. Resolution happens
//! here, server-side, so raw values are applied to the spawn without the frontend
//! having to thread them through the terminal chain.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

use crate::db::Db;

/// Settings key holding the JSON array of `{name, value}` variables for a scope.
pub const ENV_VARS_KEY: &str = "env_vars";
/// Settings key holding the JSON array of `.env` file paths for a scope.
pub const ENV_FILES_KEY: &str = "env_files";

#[derive(Debug, Deserialize)]
struct EnvVar {
    name: String,
    value: String,
}

/// The final environment to inject for a spawn in `cwd`: the app-scoped config
/// merged with the config of the repo `cwd` belongs to (repo wins), with explicit
/// variables taking precedence over `.env` file contents. Never errors — a bad
/// value or unreadable file just contributes nothing, so it can't block a spawn.
///
/// Precedence, lowest → highest (later overrides earlier on a name clash):
/// app env files → repo env files → app variables → repo variables.
pub async fn resolve_env(db: &Db, cwd: Option<&str>) -> Vec<(String, String)> {
    let repo = match cwd {
        Some(c) => repo_scope_for_cwd(db, c).await,
        None => None,
    };

    // All four settings blobs (both keys × both scopes) in one round-trip — this runs
    // on every terminal spawn. When there's no repo the scope binding collapses onto
    // `app`, which just yields the app rows.
    let repo_scope = repo.as_deref().unwrap_or("app");
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT scope, key, value FROM settings WHERE key IN (?, ?) AND scope IN ('app', ?)",
    )
    .bind(ENV_VARS_KEY)
    .bind(ENV_FILES_KEY)
    .bind(repo_scope)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    let blob = |scope: &str, key: &str| {
        rows.iter()
            .find(|(s, k, _)| s == scope && k == key)
            .map(|(_, _, v)| v.as_str())
    };

    let mut merged: HashMap<String, String> = HashMap::new();
    let mut apply = |pairs: Vec<(String, String)>| {
        for (k, v) in pairs {
            merged.insert(k, v);
        }
    };

    apply(files_env(blob("app", ENV_FILES_KEY)));
    if repo.is_some() {
        apply(files_env(blob(repo_scope, ENV_FILES_KEY)));
    }
    apply(vars(blob("app", ENV_VARS_KEY)));
    if repo.is_some() {
        apply(vars(blob(repo_scope, ENV_VARS_KEY)));
    }

    // Sorted for a deterministic order (env order is otherwise irrelevant).
    let mut out: Vec<(String, String)> = merged.into_iter().collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// The `repo:<name>` settings scope for the repo whose local path is the longest
/// prefix of `cwd` (a worktree lives at `<repo>/.santree/worktrees/<id>`, so its
/// cwd is always under the repo path). `None` when no registered repo contains it.
async fn repo_scope_for_cwd(db: &Db, cwd: &str) -> Option<String> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT name, path FROM repos WHERE path IS NOT NULL")
            .fetch_all(db)
            .await
            .ok()?;

    let cwd = Path::new(cwd);
    let mut best: Option<(usize, String)> = None;
    for (name, path) in rows {
        // `starts_with` is component-wise, so `/a/b` doesn't match `/a/bc`.
        if cwd.starts_with(Path::new(&path)) {
            let len = path.len();
            if best.as_ref().is_none_or(|(l, _)| len > *l) {
                best = Some((len, name));
            }
        }
    }
    best.map(|(_, name)| format!("repo:{name}"))
}

/// The explicit `{name, value}` variables in a scope's [`ENV_VARS_KEY`] blob (empty
/// when unset or malformed — a corrupt blob must not break spawning).
fn vars(json: Option<&str>) -> Vec<(String, String)> {
    let Some(json) = json else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<EnvVar>>(json)
        .unwrap_or_default()
        .into_iter()
        .map(|e| (e.name, e.value))
        .collect()
}

/// Every variable loaded from the `.env` files in a scope's [`ENV_FILES_KEY`] blob,
/// in list order (later files override earlier ones on a name clash).
fn files_env(json: Option<&str>) -> Vec<(String, String)> {
    let Some(json) = json else {
        return Vec::new();
    };
    let paths: Vec<String> = serde_json::from_str(json).unwrap_or_default();
    paths.iter().flat_map(|p| parse_env_file(p)).collect()
}

/// Parse a `.env` file into KEY=VALUE pairs *without* mutating our own process
/// env (`dotenvy::from_path_iter`, not `from_path`). Unreadable/malformed lines
/// are skipped; a missing file yields nothing.
pub fn parse_env_file(path: &str) -> Vec<(String, String)> {
    match dotenvy::from_path_iter(path) {
        Ok(iter) => iter.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

/// The variable names an `.env` file defines — for the settings UI's
/// "N variables loaded" readout. Empty when the file is missing/unreadable.
pub fn env_file_var_names(path: &str) -> Vec<String> {
    parse_env_file(path).into_iter().map(|(k, _)| k).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_env(tag: &str, body: &str) -> String {
        let path =
            std::env::temp_dir().join(format!("santree-env-{}-{tag}.env", std::process::id()));
        std::fs::write(&path, body).unwrap();
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn parses_env_file_and_skips_comments() {
        let p = write_env(
            "basic",
            "# a comment\nFOO=bar\nBAZ=\"quoted value\"\n\nEMPTY=\n",
        );
        let vars = parse_env_file(&p);
        assert_eq!(vars.iter().find(|(k, _)| k == "FOO").unwrap().1, "bar");
        assert_eq!(
            vars.iter().find(|(k, _)| k == "BAZ").unwrap().1,
            "quoted value"
        );
        assert!(vars.iter().any(|(k, _)| k == "EMPTY"));
        assert_eq!(env_file_var_names(&p).len(), 3);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn missing_file_yields_nothing() {
        assert!(parse_env_file("/no/such/santree-env.env").is_empty());
    }

    /// The precedence the doc-comment promises, end to end:
    /// app files → repo files → app vars → repo vars.
    #[tokio::test]
    async fn resolve_env_layers_app_under_repo_and_files_under_vars() {
        let dir = std::env::temp_dir().join(format!("santree-env-{}", uuid::Uuid::new_v4()));
        let repo_dir = dir.join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        let repo_path = repo_dir.to_str().unwrap();
        let db = crate::db::init(dir.join("test.db")).await.unwrap();

        sqlx::query("INSERT INTO repos (name, path) VALUES ('acme', ?)")
            .bind(repo_path)
            .execute(&db)
            .await
            .unwrap();

        let env_file = dir.join("app.env");
        std::fs::write(&env_file, "FROM_FILE=file\nBOTH=file\n").unwrap();
        let files_json = serde_json::to_string(&[env_file.to_str().unwrap()]).unwrap();
        crate::settings::set(&db, "app", ENV_FILES_KEY, Some(files_json))
            .await
            .unwrap();
        crate::settings::set(
            &db,
            "app",
            ENV_VARS_KEY,
            Some(r#"[{"name":"BOTH","value":"app"},{"name":"SCOPED","value":"app"}]"#.into()),
        )
        .await
        .unwrap();
        crate::settings::set(
            &db,
            "repo:acme",
            ENV_VARS_KEY,
            Some(r#"[{"name":"SCOPED","value":"repo"}]"#.into()),
        )
        .await
        .unwrap();

        // A cwd inside the repo picks up the repo scope on top of the app scope.
        let env: HashMap<_, _> = resolve_env(&db, Some(repo_path))
            .await
            .into_iter()
            .collect();
        assert_eq!(env.get("FROM_FILE").unwrap(), "file");
        assert_eq!(env.get("BOTH").unwrap(), "app", "vars override files");
        assert_eq!(env.get("SCOPED").unwrap(), "repo", "repo overrides app");

        // Outside any registered repo, only the app scope applies.
        let env: HashMap<_, _> = resolve_env(&db, Some("/elsewhere"))
            .await
            .into_iter()
            .collect();
        assert_eq!(env.get("SCOPED").unwrap(), "app");

        std::fs::remove_dir_all(&dir).ok();
    }
}
