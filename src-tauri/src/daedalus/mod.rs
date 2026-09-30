//! Daedalus — the user's home server, where Daedalus projects live and run
//! (docs/remote.md). santree reaches it only through the Daedalus agent on
//! this machine: [`host`] is that live link and the hook relay. This module
//! answers the health check, lists the server's checkouts over the link, and
//! registers one of them as a santree project.
//!
//! Unreachable is normal. Every read here answers with a [`DaedalusLink`] as
//! a plain value; only genuinely broken local state (the database) is an
//! `Err`, because an `Err` becomes a red toast.

pub mod host;

use std::path::{Component, Path};
use std::time::Duration;

use anyhow::{bail, Result};

use santree_core::domain::{
    DaedalusHealth, DaedalusLink, DaedalusSync, DaedalusWorkspace, DaedalusWorkspaceList, Repo,
};
use santree_remote_client::proto::{m, Empty, Workspace, WorkspacesResult};

use crate::db::Db;
use crate::repo;
use host::{DaedalusHost, NotConnected};

/// How long the health check waits for a fresh attempt to settle: past one
/// attempt's own limit (`HostOptions::hello_timeout`).
const CHECK_WAIT: Duration = Duration::from_secs(30);

/// Try the link now, skipping its backoff, and report how it settled.
pub async fn check(link: &DaedalusHost) -> DaedalusHealth {
    link.retry_now();
    DaedalusHealth {
        link: link.settled(CHECK_WAIT).await,
        checked_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// The server's checkouts, each marked with whether santree has it
/// registered. Empty, with the link saying why, whenever the host can't list.
pub async fn workspaces(db: &Db, link: &DaedalusHost) -> Result<DaedalusWorkspaceList> {
    let listed = match list(link).await {
        Ok(listed) => listed,
        Err(unlisted) => return Ok(unlisted),
    };
    let registered = repo::daedalus_paths(db).await?;
    let workspaces = listed
        .workspaces
        .into_iter()
        .map(|w| {
            let is_registered = registered.contains(&w.path);
            workspace(w, is_registered)
        })
        .collect();
    Ok(DaedalusWorkspaceList {
        link: link.state(),
        host_outdated: false,
        generated_at: listed.generated_at,
        workspaces,
    })
}

/// `workspaces.list` over the live link, or the empty answer that says why
/// there is none.
async fn list(link: &DaedalusHost) -> Result<WorkspacesResult, DaedalusWorkspaceList> {
    let unlisted = |link: DaedalusLink, host_outdated: bool| DaedalusWorkspaceList {
        link,
        host_outdated,
        generated_at: None,
        workspaces: vec![],
    };
    let client = link
        .client_within(host::CONNECT_WAIT)
        .await
        .map_err(|NotConnected { link }| unlisted(link, false))?;
    if !link
        .hello()
        .is_some_and(|hello| hello.supports::<m::WorkspacesList>())
    {
        return Err(unlisted(link.state(), true));
    }
    client.call::<m::WorkspacesList>(&Empty).await.map_err(|e| {
        unlisted(
            DaedalusLink::Unavailable {
                reason: format!("the session host didn't list its projects: {e}"),
            },
            false,
        )
    })
}

/// A `workspaces.list` row, with santree's own `registered` mark.
fn workspace(w: Workspace, registered: bool) -> DaedalusWorkspace {
    let sync = w.sync.map_or_else(DaedalusSync::default, |s| DaedalusSync {
        result: Some(s.result),
        detail: Some(s.detail),
        at: Some(s.at),
    });
    DaedalusWorkspace {
        name: w.name,
        path: w.path,
        remote: w.remote,
        branch: w.branch,
        head: w.head,
        head_at: w.head_at,
        dirty: w.dirty,
        ahead: w.ahead.unwrap_or(0),
        behind: w.behind.unwrap_or(0),
        sync,
        registered,
    }
}

/// Register one of the server's checkouts as a santree project. `name` only
/// selects: the path and remote come from a fresh read of the server's own
/// list.
pub async fn add_repo(db: &Db, link: &DaedalusHost, name: &str) -> Result<Repo> {
    validate_workspace_name(name)?;
    let listed = match list(link).await {
        Ok(listed) => listed,
        Err(unlisted) if unlisted.host_outdated => {
            bail!("Daedalus's session host is too old to list its projects. Update Daedalus.")
        }
        Err(unlisted) => bail!("{}", host::describe(&unlisted.link)),
    };
    let workspace = listed
        .workspaces
        .into_iter()
        .find(|w| w.name == name)
        .ok_or_else(|| anyhow::anyhow!("Daedalus has no project called {name}."))?;
    validate_server_path(&workspace.path, name)?;
    repo::add_daedalus(db, &workspace.path, workspace.remote.as_deref()).await
}

/// A workspace name is one directory under the projects root: a single normal
/// path component that can't be read as a flag.
fn validate_workspace_name(name: &str) -> Result<()> {
    let mut components = Path::new(name).components();
    let single = matches!(components.next(), Some(Component::Normal(c)) if c == name)
        && components.next().is_none();
    if !single
        || name.len() > 255
        || name.starts_with('-')
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        bail!("invalid Daedalus project name");
    }
    Ok(())
}

/// The server's own path for the workspace, checked before it is stored as the
/// repo's path (and so, later, used as a cwd on the server): absolute, no `..`,
/// and ending in the workspace's name.
fn validate_server_path(path: &str, name: &str) -> Result<()> {
    let p = Path::new(path);
    if !p.is_absolute()
        || p.components().any(|c| matches!(c, Component::ParentDir))
        || p.file_name().and_then(|n| n.to_str()) != Some(name)
    {
        bail!("Daedalus reported an unexpected path for {name}.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use santree_remote_client::fake::{FakeAgent, FakeDaemon, FakeOptions};
    use santree_remote_client::proto::WorkspaceSync;
    use santree_remote_client::{ClientOptions, HostOptions};

    use super::*;

    #[test]
    fn workspace_names_are_single_components() {
        for good in ["web", "santree-app", "my.project", "a_b"] {
            assert!(validate_workspace_name(good).is_ok(), "{good}");
        }
        for bad in [
            "", ".", "..", "a/b", "/abs", "../up", "-rf", "a\\b", "a\nb", "web/",
        ] {
            assert!(validate_workspace_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn server_paths_must_be_absolute_and_end_in_the_name() {
        assert!(validate_server_path("/srv/projects/web", "web").is_ok());
        assert!(validate_server_path("srv/projects/web", "web").is_err());
        assert!(validate_server_path("/srv/projects/../web", "web").is_err());
        assert!(validate_server_path("/srv/projects/other", "web").is_err());
    }

    /// Registering a Daedalus repo never touches the local filesystem, derives
    /// its identity from the remote, and is idempotent — and every local-only
    /// read then treats it as having no local path.
    #[tokio::test]
    async fn a_daedalus_repo_registers_without_a_local_checkout() {
        let base =
            std::env::temp_dir().join(format!("santree-daedalus-add-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();

        let server_path = "/srv/does-not-exist-here/web";
        let repo = repo::add_daedalus(&db, server_path, Some("git@github.com:acme/web.git"))
            .await
            .unwrap();
        assert_eq!(repo.name, "acme/web");
        assert_eq!(repo.location, santree_core::domain::RepoLocation::Daedalus);
        assert_eq!(repo.path.as_deref(), Some(server_path));

        let again = repo::add_daedalus(&db, server_path, Some("git@github.com:acme/web.git"))
            .await
            .unwrap();
        assert_eq!(again.name, "acme/web");
        let listed = repo::list(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].location,
            santree_core::domain::RepoLocation::Daedalus
        );

        assert_eq!(repo::path(&db, "acme/web").await.unwrap(), None);
        assert!(repo::registered(&db).await.unwrap().is_empty());
        assert_eq!(
            repo::daedalus_paths(&db).await.unwrap(),
            vec![server_path.to_string()]
        );
        assert!(crate::worktree::list(&db, "acme/web")
            .await
            .unwrap()
            .is_empty());
        assert!(crate::worktree::base_worktree(&db, "acme/web")
            .await
            .unwrap()
            .is_none());
        assert!(
            !crate::worktree::init_script(&db, "acme/web")
                .await
                .unwrap()
                .exists
        );

        // No remote: named for its folder.
        let bare = repo::add_daedalus(&db, "/srv/x/notes", None).await.unwrap();
        assert_eq!(bare.name, "notes");

        let _ = std::fs::remove_dir_all(&base);
    }

    fn fast() -> HostOptions {
        HostOptions {
            backoff_min: Duration::from_millis(20),
            backoff_max: Duration::from_millis(200),
            hello_timeout: Duration::from_secs(5),
            client: ClientOptions::default(),
        }
    }

    fn row(name: &str) -> Workspace {
        Workspace {
            name: name.into(),
            path: format!("/srv/projects/{name}"),
            remote: Some(format!("git@github.com:acme/{name}.git")),
            branch: Some("main".into()),
            head: Some("abc123".into()),
            head_at: None,
            dirty: true,
            ahead: Some(2),
            behind: None,
            sync: Some(WorkspaceSync {
                result: "ok".into(),
                detail: "fast-forwarded".into(),
                at: "2026-09-30T10:00:00Z".into(),
            }),
        }
    }

    /// Every state the health check can settle in, from what the agent's
    /// socket says (or doesn't): no agent, an old one, each refusal, and a
    /// connected link.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_health_check_names_each_agent_state() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("santree.sock");

        // No socket at all.
        let missing = DaedalusHost::with_connector(
            Arc::new(santree_remote_client::AgentConnector::at(&socket, 0)),
            fast(),
        );
        missing.resume(None);
        assert_eq!(check(&missing).await.link, DaedalusLink::AgentMissing);
        // The agent's own socket, and none for santree: an old agent.
        std::fs::write(dir.path().join("agent.sock"), b"").unwrap();
        assert_eq!(check(&missing).await.link, DaedalusLink::AgentOutdated);
        std::fs::remove_file(dir.path().join("agent.sock")).unwrap();

        let agent = FakeAgent::serve(&socket, FakeDaemon::new()).unwrap();
        let link = DaedalusHost::with_connector(Arc::new(agent.connector()), fast());
        link.resume(None);
        agent.refuse("santree_off", "santree is off for this machine");
        assert_eq!(check(&link).await.link, DaedalusLink::SantreeOff);
        agent.refuse("host_key_changed", "another key");
        assert_eq!(
            check(&link).await.link,
            DaedalusLink::HostKeyChanged {
                reason: "another key".into()
            }
        );
        for code in ["unavailable", "forbidden", "busy"] {
            agent.refuse(code, "the agent's reason");
            assert_eq!(
                check(&link).await.link,
                DaedalusLink::Unavailable {
                    reason: "the agent's reason".into()
                },
                "{code}"
            );
        }
        agent.admit();
        let health = check(&link).await;
        assert_eq!(
            health.link,
            DaedalusLink::Connected {
                hostname: FakeOptions::default().hostname,
                version: FakeOptions::default().version,
                projects_root: FakeOptions::default().projects_root,
                agent: Some(FakeAgent::VERSION.into()),
            }
        );
        assert!(!health.checked_at.is_empty());
    }

    /// The add-project dialog's list comes over the link, marked with what is
    /// already registered, and adding re-reads it; a host too old to list,
    /// and a link that is down, answer empty with why.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workspaces_come_over_the_link() {
        let base = std::env::temp_dir().join(format!("santree-daedalus-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let db = crate::db::init(base.join("test.db")).await.unwrap();
        let dir = tempfile::tempdir().unwrap();
        let daemon = FakeDaemon::with_options(FakeOptions {
            workspaces_generated_at: Some("2026-09-30T10:00:00Z".into()),
            workspaces: vec![row("web"), row("infra")],
            ..Default::default()
        });
        let agent = FakeAgent::serve(dir.path().join("santree.sock"), daemon).unwrap();
        agent.refuse("santree_off", "off");
        let link = DaedalusHost::with_connector(Arc::new(agent.connector()), fast());
        link.resume(None);

        let off = workspaces(&db, &link).await.unwrap();
        assert_eq!(off.link, DaedalusLink::SantreeOff);
        assert!(off.workspaces.is_empty() && !off.host_outdated);
        assert!(add_repo(&db, &link, "web").await.is_err());

        agent.admit();
        link.retry_now();
        let listed = workspaces(&db, &link).await.unwrap();
        assert!(matches!(listed.link, DaedalusLink::Connected { .. }));
        assert_eq!(listed.generated_at.as_deref(), Some("2026-09-30T10:00:00Z"));
        let web = &listed.workspaces[0];
        assert_eq!(
            (web.name.as_str(), web.ahead, web.behind, web.registered),
            ("web", 2, 0, false)
        );
        assert_eq!(web.sync.detail.as_deref(), Some("fast-forwarded"));

        let repo = add_repo(&db, &link, "web").await.unwrap();
        assert_eq!(repo.path.as_deref(), Some("/srv/projects/web"));
        assert!(add_repo(&db, &link, "nope").await.is_err());
        let after = workspaces(&db, &link).await.unwrap();
        let marks: Vec<_> = after
            .workspaces
            .iter()
            .map(|w| (w.name.as_str(), w.registered))
            .collect();
        assert_eq!(marks, [("web", true), ("infra", false)]);

        // A session host from before `workspaces.list`.
        let dir = tempfile::tempdir().unwrap();
        let old = FakeAgent::serve(
            dir.path().join("santree.sock"),
            FakeDaemon::with_options(FakeOptions {
                features: vec![],
                ..Default::default()
            }),
        )
        .unwrap();
        let old_link = DaedalusHost::with_connector(Arc::new(old.connector()), fast());
        old_link.resume(None);
        let outdated = workspaces(&db, &old_link).await.unwrap();
        assert!(outdated.host_outdated && outdated.workspaces.is_empty());

        let _ = std::fs::remove_dir_all(&base);
    }
}
