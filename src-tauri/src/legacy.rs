//! Adoption of santree-CLI configuration when a repo is opened.
//!
//! The predecessor CLI kept per-repo state in `<repo>/.santree/`
//! (`metadata.json` — Linear workspace, per-issue sessions) and its Linear
//! OAuth credential in a global plaintext auth store,
//! `$XDG_CONFIG_HOME/santree/auth.json`. The app already shares the CLI's
//! on-disk layout for worktrees (`.santree/worktrees/`) and the setup script
//! (`.santree/init.sh`), so the one thing left to migrate is the Linear
//! connection: [`probe`] detects an importable workspace right after a repo is
//! added, [`migrate`] moves its credential into the OS keychain (via a
//! validating token refresh — see `linear::import_cli_credential`) and links
//! the repo to the workspace. Tokens are read from disk on the Rust side only;
//! they never cross the IPC boundary.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;

use santree_core::domain::{LegacyCliMigration, LinearOrg};

use crate::db::Db;
use crate::linear;
use crate::repo;

/// The CLI's global config dir: `$XDG_CONFIG_HOME/santree`, defaulting to
/// `~/.config/santree` — the same resolution the CLI uses.
fn cli_config_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(xdg).join("santree"));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config").join("santree"))
}

/// One org's entry in the CLI's `auth.json` (unknown fields — `access_token`,
/// `expires_at` — are ignored: the import spends the refresh token regardless,
/// since the CLI's access token is typically long expired).
#[derive(Deserialize)]
struct CliTokens {
    refresh_token: String,
    #[serde(default)]
    org_name: Option<String>,
}

/// A slug read from the CLI's files becomes a keychain account name and a DB
/// key, so hold it to Linear's actual url-key shape before it crosses that line.
fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The CLI's Linear workspace for a repo, from `.santree/metadata.json`'s
/// `_linear.org` key. `None` when the file or key is absent — or unparseable:
/// a corrupt file means nothing importable, not an error worth surfacing.
fn metadata_org(repo_root: &Path) -> Option<String> {
    #[derive(Deserialize)]
    struct Meta {
        #[serde(rename = "_linear")]
        linear: Option<MetaLinear>,
    }
    #[derive(Deserialize)]
    struct MetaLinear {
        org: Option<String>,
    }
    let raw = std::fs::read_to_string(repo_root.join(".santree").join("metadata.json")).ok()?;
    let meta: Meta = serde_json::from_str(&raw).ok()?;
    meta.linear?.org.filter(|s| valid_slug(s))
}

/// The CLI credential stored for `slug` in `<dir>/auth.json`. Handles both the
/// current store shape (`{version: 2, linear: {slug: …}}`) and the flat pre-v2
/// map (`{slug: …}`) the CLI still reads.
fn cli_tokens(dir: &Path, slug: &str) -> Option<CliTokens> {
    let raw = std::fs::read_to_string(dir.join("auth.json")).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let by_org = if val.get("version").and_then(|v| v.as_i64()) == Some(2) {
        val.get("linear")?
    } else {
        &val
    };
    serde_json::from_value(by_org.get(slug)?.clone()).ok()
}

/// What the CLI's files say about a repo: its workspace slug, and the stored
/// credential for it when the global auth store has one.
fn read_cli_config(
    repo_root: &Path,
    config_dir: Option<&Path>,
) -> Option<(String, Option<CliTokens>)> {
    let slug = metadata_org(repo_root)?;
    let tokens = config_dir.and_then(|d| cli_tokens(d, &slug));
    Some((slug, tokens))
}

/// santree-CLI configuration left in a registered repo, when acting on it is
/// possible: `already_connected` when the workspace is connected and the repo
/// just needs linking, otherwise an importable credential exists. `None` when
/// there's no legacy config, no usable credential, or the repo already has an
/// explicit workspace link (nothing to adopt — which is also what keeps
/// re-adding an already-migrated repo quiet).
pub async fn probe(db: &Db, repo: &str) -> Result<Option<LegacyCliMigration>> {
    let Some(path) = repo::path(db, repo).await? else {
        bail!("repo '{repo}' is not registered");
    };
    let linked: Option<Option<String>> =
        sqlx::query_scalar("SELECT linear_org_slug FROM repos WHERE name = ?")
            .bind(repo)
            .fetch_optional(db)
            .await?;
    if linked.flatten().is_some() {
        return Ok(None);
    }
    let found = tokio::task::spawn_blocking(move || {
        read_cli_config(Path::new(&path), cli_config_dir().as_deref())
    })
    .await
    .context("legacy config probe")?;
    let Some((slug, tokens)) = found else {
        return Ok(None);
    };
    // For a connected org the app's stored name is the truth (the frontend
    // names it in the "linked to <workspace>" toast); the CLI's stored name
    // only labels the import dialog.
    let connected_name = linear::connected_org_name(db, &slug).await?;
    let already_connected = connected_name.is_some();
    if !already_connected && tokens.is_none() {
        return Ok(None);
    }
    let org_name = connected_name
        .or_else(|| tokens.and_then(|t| t.org_name))
        .unwrap_or_else(|| slug.clone());
    Ok(Some(LegacyCliMigration {
        org_slug: slug,
        org_name,
        already_connected,
    }))
}

/// Import the CLI's Linear credential for `repo`'s workspace and link the repo
/// to it. The CLI's files are re-read here (nothing IPC-supplied beyond the
/// repo name is trusted) and the credential is persisted through the same
/// keychain path as an OAuth connect. On success the org's entry is scrubbed
/// from the plaintext `auth.json` — the dialog promises the sign-in *moves*
/// into the keychain, and while the import spends the refresh token, the
/// access token beside it could still have residual life on disk.
pub async fn migrate(db: &Db, repo: &str) -> Result<LinearOrg> {
    let Some(path) = repo::path(db, repo).await? else {
        bail!("repo '{repo}' is not registered");
    };
    let (slug, tokens) = tokio::task::spawn_blocking(move || {
        read_cli_config(Path::new(&path), cli_config_dir().as_deref())
            .ok_or_else(|| anyhow!("this repo has no santree CLI Linear workspace recorded"))
    })
    .await
    .context("legacy config read")??;
    let tokens = tokens.ok_or_else(|| {
        anyhow!("the santree CLI auth store has no credential for workspace '{slug}'")
    })?;
    let org = linear::import_cli_credential(db, &slug, tokens.refresh_token).await?;
    linear::set_repo_org(db, repo, Some(org.slug.clone())).await?;
    tokio::task::spawn_blocking(move || {
        if let Some(dir) = cli_config_dir() {
            scrub_cli_tokens(&dir, &slug);
        }
    })
    .await
    .context("auth store scrub")?;
    Ok(org)
}

/// Best-effort removal of one org's entry from the CLI's plaintext auth store
/// after its credential moved into the keychain. Other orgs' entries (and the
/// rest of the file) are preserved; the file is re-read fresh so a concurrent
/// CLI write isn't clobbered wholesale. Failures only log — the migration
/// itself already succeeded.
fn scrub_cli_tokens(dir: &Path, slug: &str) {
    let path = dir.join("auth.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return;
    };
    let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let entries = if val.get("version").and_then(|v| v.as_i64()) == Some(2) {
        val.get_mut("linear").and_then(|l| l.as_object_mut())
    } else {
        val.as_object_mut()
    };
    let Some(entries) = entries else { return };
    if entries.remove(slug).is_none() {
        return;
    }
    match serde_json::to_string_pretty(&val) {
        Ok(out) => match std::fs::write(&path, out + "\n") {
            Ok(()) => {
                log::info!("scrubbed the migrated workspace '{slug}' from the CLI auth store")
            }
            Err(e) => {
                log::warn!("couldn't rewrite the CLI auth store after migrating '{slug}': {e}")
            }
        },
        Err(e) => log::warn!("couldn't re-encode the CLI auth store after migrating '{slug}': {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("santree-legacy-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn slug_validation_rejects_path_shaped_input() {
        assert!(valid_slug("canary-technologies"));
        assert!(valid_slug("org_2"));
        assert!(!valid_slug(""));
        assert!(!valid_slug("../escape"));
        assert!(!valid_slug("a/b"));
        assert!(!valid_slug("linear:x"));
        assert!(!valid_slug(&"x".repeat(65)));
    }

    #[test]
    fn metadata_org_reads_the_cli_shape_and_ignores_issue_entries() {
        let root = temp_dir("meta");
        write(
            &root.join(".santree/metadata.json"),
            r#"{"_linear":{"org":"acme"},"_triage":{"skill_name":"x"},"AK-1":{"session_id":"s"}}"#,
        );
        assert_eq!(metadata_org(&root).as_deref(), Some("acme"));

        write(
            &root.join(".santree/metadata.json"),
            r#"{"AK-1":{"session_id":"s"}}"#,
        );
        assert_eq!(metadata_org(&root), None, "no _linear key");

        write(
            &root.join(".santree/metadata.json"),
            r#"{"_linear":{"org":"../x"}}"#,
        );
        assert_eq!(metadata_org(&root), None, "invalid slug is dropped");

        write(&root.join(".santree/metadata.json"), "not json");
        assert_eq!(metadata_org(&root), None, "corrupt file is not an error");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cli_tokens_reads_v2_and_flat_pre_v2_stores() {
        let dir = temp_dir("auth");
        write(
            &dir.join("auth.json"),
            r#"{"version":2,"linear":{"acme":{"access_token":"a","refresh_token":"r","expires_at":1,"org_name":"Acme Inc"}},"github":{}}"#,
        );
        let t = cli_tokens(&dir, "acme").unwrap();
        assert_eq!(t.refresh_token, "r");
        assert_eq!(t.org_name.as_deref(), Some("Acme Inc"));
        assert!(cli_tokens(&dir, "other").is_none());

        write(
            &dir.join("auth.json"),
            r#"{"acme":{"access_token":"a","refresh_token":"r2","expires_at":1,"org_name":"Acme"}}"#,
        );
        assert_eq!(cli_tokens(&dir, "acme").unwrap().refresh_token, "r2");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scrub_removes_only_the_migrated_org() {
        let dir = temp_dir("scrub");
        write(
            &dir.join("auth.json"),
            r#"{"version":2,"linear":{"acme":{"access_token":"a","refresh_token":"r"},"other":{"access_token":"b","refresh_token":"s"}},"github":{}}"#,
        );
        scrub_cli_tokens(&dir, "acme");
        let val: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("auth.json")).unwrap()).unwrap();
        assert!(val["linear"].get("acme").is_none(), "migrated org removed");
        assert_eq!(
            val["linear"]["other"]["refresh_token"], "s",
            "other org kept"
        );
        assert!(val.get("github").is_some(), "unrelated keys kept");

        // Flat pre-v2 shape, and a missing file, are both handled quietly.
        write(&dir.join("auth.json"), r#"{"acme":{"refresh_token":"r"}}"#);
        scrub_cli_tokens(&dir, "acme");
        let val: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("auth.json")).unwrap()).unwrap();
        assert!(val.get("acme").is_none());
        scrub_cli_tokens(&dir.join("nope"), "acme");

        let _ = std::fs::remove_dir_all(&dir);
    }

    async fn seed_repo(db: &Db, name: &str, path: &Path) {
        sqlx::query("INSERT INTO repos (name, tracker, path) VALUES (?, 'Local git', ?)")
            .bind(name)
            .bind(path.to_string_lossy().as_ref())
            .execute(db)
            .await
            .unwrap();
    }

    /// The db-level decision matrix: no metadata → None; an explicit repo link →
    /// None even with metadata; metadata naming a connected org → Some with
    /// `already_connected` (no CLI credential needed); metadata naming an
    /// unconnected org with no stored credential → None. (The credential-found
    /// arm is covered by `cli_tokens_…` above — the global-store lookup itself
    /// isn't re-pointed here to keep the test env-independent.)
    #[tokio::test]
    async fn probe_decision_matrix() {
        let base = temp_dir("probe");
        let db = crate::db::init(base.join("test.db")).await.unwrap();

        let bare = base.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        seed_repo(&db, "bare", &bare).await;
        assert_eq!(probe(&db, "bare").await.unwrap(), None);

        // A slug that must not exist in any real ~/.config/santree/auth.json.
        let slug = "santree-app-test-org";
        let legacy = base.join("legacy");
        write(
            &legacy.join(".santree/metadata.json"),
            &format!(r#"{{"_linear":{{"org":"{slug}"}}}}"#),
        );
        seed_repo(&db, "legacy", &legacy).await;
        assert_eq!(
            probe(&db, "legacy").await.unwrap(),
            None,
            "unconnected org with no stored credential: nothing actionable"
        );

        sqlx::query("INSERT INTO linear_orgs (slug, name, expires_at) VALUES (?, 'Test Org', 0)")
            .bind(slug)
            .execute(&db)
            .await
            .unwrap();
        let hit = probe(&db, "legacy").await.unwrap().unwrap();
        assert!(hit.already_connected);
        assert_eq!(hit.org_slug, slug);

        sqlx::query("UPDATE repos SET linear_org_slug = ? WHERE name = 'legacy'")
            .bind(slug)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            probe(&db, "legacy").await.unwrap(),
            None,
            "an explicitly linked repo has nothing left to adopt"
        );

        assert!(
            probe(&db, "ghost").await.is_err(),
            "unregistered repo is an error"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
