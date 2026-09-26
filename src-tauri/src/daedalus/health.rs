//! The Daedalus health check: each stage of reaching the server, in order —
//! the API, ssh, then `santree-remote` — so "ssh works but the daemon isn't
//! there" reads as exactly that rather than as one "unreachable".
//!
//! A stage that can't run because an earlier one failed is `Skipped` with the
//! reason. ssh needs only the cached connection info, never a live API: once
//! Daedalus has reported it, ssh can be checked while the API is down.

use std::future::Future;
use std::time::Duration;

use anyhow::Result;

use santree_core::domain::{
    DaedalusApiCheck, DaedalusDaemonCheck, DaedalusHealth, DaedalusReach, DaedalusSshCheck,
    DaemonReach,
};
use santree_remote_client::proto::PROTOCOL_VERSION;
use santree_remote_client::{ssh_probe, ProbeOutcome, SshTarget};

use super::host::{self, DaedalusHost};
use crate::db::Db;

/// How long the check waits for the link to settle after asking it to retry:
/// past one `hello` timeout, so a slow first connect still gets its answer.
const DAEMON_WAIT: Duration = Duration::from_secs(12);

/// Run every stage against the real API, ssh and link.
pub async fn check(db: &Db, link: &DaedalusHost) -> Result<DaedalusHealth> {
    // The status read also refreshes the cached connection info the ssh stage
    // uses, so the link follows it before anything asks the link.
    let api = api_check(super::status(db).await?);
    link.sync(db).await;
    let target = super::load(db).await?.as_ref().and_then(host::target);
    let app_dir = link.app_dir();
    Ok(staged(
        api,
        target.as_ref(),
        |target| ssh_probe(target, app_dir),
        || async {
            link.retry_now();
            link.settled_reach(DAEMON_WAIT).await
        },
    )
    .await)
}

fn api_check(reach: DaedalusReach) -> DaedalusApiCheck {
    match reach {
        DaedalusReach::NotConfigured => DaedalusApiCheck::NotConfigured,
        DaedalusReach::ApiUnreachable { reason } => DaedalusApiCheck::Unreachable { reason },
        DaedalusReach::Unauthorized => DaedalusApiCheck::Unauthorized,
        DaedalusReach::ApiReachable => DaedalusApiCheck::Ok,
    }
}

/// The stages after the API's, given its answer and the ssh target on file.
/// `probe` is one ssh round trip; `daemon` asks the live link how it is.
async fn staged<'t, P, PF, D, DF>(
    api: DaedalusApiCheck,
    target: Option<&'t SshTarget>,
    probe: P,
    daemon: D,
) -> DaedalusHealth
where
    P: FnOnce(&'t SshTarget) -> PF,
    PF: Future<Output = ProbeOutcome>,
    D: FnOnce() -> DF,
    DF: Future<Output = DaemonReach>,
{
    let checked_at = || chrono::Utc::now().to_rfc3339();
    let skipped = |ssh: &str, daemon: &str| DaedalusHealth {
        ssh: DaedalusSshCheck::Skipped { reason: ssh.into() },
        daemon: DaedalusDaemonCheck::Skipped {
            reason: daemon.into(),
        },
        api: api.clone(),
        checked_at: checked_at(),
    };
    if api == DaedalusApiCheck::NotConfigured {
        return skipped("Connect Daedalus first.", "Connect Daedalus first.");
    }
    let Some(target) = target else {
        return skipped(
            "Waiting for Daedalus's connection info.",
            "Needs SSH access first.",
        );
    };

    let destination = format!("{}@{}", target.user, target.host);
    let daemon = match probe(target).await {
        ProbeOutcome::SshFailed { reason } => {
            return DaedalusHealth {
                ssh: DaedalusSshCheck::Failed {
                    reason,
                    target: destination,
                },
                daemon: DaedalusDaemonCheck::Skipped {
                    reason: "Needs SSH access first.".into(),
                },
                api,
                checked_at: checked_at(),
            };
        }
        ProbeOutcome::DaemonMissing => DaedalusDaemonCheck::NotInstalled,
        ProbeOutcome::Installed { protocol, .. } => match daemon().await {
            DaemonReach::Connected { version } => DaedalusDaemonCheck::Connected { version },
            DaemonReach::VersionMismatch { theirs } => {
                DaedalusDaemonCheck::VersionMismatch { theirs }
            }
            // The link can't say, but the binary told us which protocol it speaks.
            _ if protocol.is_some_and(|p| p != PROTOCOL_VERSION) => {
                DaedalusDaemonCheck::VersionMismatch { theirs: protocol }
            }
            DaemonReach::Unreachable { reason } => DaedalusDaemonCheck::NotRunning { reason },
            DaemonReach::Connecting | DaemonReach::NotConfigured => {
                DaedalusDaemonCheck::NotRunning {
                    reason: "santree-remote didn't answer.".into(),
                }
            }
        },
    };
    DaedalusHealth {
        api,
        ssh: DaedalusSshCheck::Ok {
            target: destination,
        },
        daemon,
        checked_at: checked_at(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> SshTarget {
        SshTarget {
            user: "santiago".into(),
            host: "s2.example.org".into(),
            port: 22,
            identity_file: None,
        }
    }

    fn api_404() -> DaedalusApiCheck {
        DaedalusApiCheck::Unreachable {
            reason: "This Daedalus doesn't serve santree's API yet. Update Daedalus.".into(),
        }
    }

    async fn never_asked() -> DaemonReach {
        panic!("the link was asked about a daemon that isn't installed")
    }

    /// Today's expected state: the API isn't served yet, ssh works, and
    /// santree-remote isn't on the server. Each stage says exactly that — the
    /// API's failure doesn't stop the ssh check.
    #[tokio::test]
    async fn api_down_ssh_up_daemon_missing() {
        let target = target();
        let health = staged(
            api_404(),
            Some(&target),
            |t| {
                assert_eq!(t.host, "s2.example.org");
                async { ProbeOutcome::DaemonMissing }
            },
            never_asked,
        )
        .await;
        assert_eq!(health.api, api_404());
        assert_eq!(
            health.ssh,
            DaedalusSshCheck::Ok {
                target: "santiago@s2.example.org".into()
            }
        );
        assert_eq!(health.daemon, DaedalusDaemonCheck::NotInstalled);
    }

    #[tokio::test]
    async fn an_installed_daemon_is_judged_by_the_link() {
        let target = target();
        let health = staged(
            DaedalusApiCheck::Ok,
            Some(&target),
            |_| async {
                ProbeOutcome::Installed {
                    version_line: "santree-remote 0.1.0 protocol 1".into(),
                    version: Some("0.1.0".into()),
                    protocol: Some(1),
                }
            },
            || async {
                DaemonReach::Connected {
                    version: "0.1.0".into(),
                }
            },
        )
        .await;
        assert_eq!(
            health.ssh,
            DaedalusSshCheck::Ok {
                target: "santiago@s2.example.org".into()
            }
        );
        assert_eq!(
            health.daemon,
            DaedalusDaemonCheck::Connected {
                version: "0.1.0".into()
            }
        );
    }

    #[tokio::test]
    async fn an_ssh_failure_names_the_target_and_skips_the_daemon() {
        let target = target();
        let health = staged(
            DaedalusApiCheck::Ok,
            Some(&target),
            |_| async {
                ProbeOutcome::SshFailed {
                    reason: "ssh: connection timed out".into(),
                }
            },
            never_asked,
        )
        .await;
        assert_eq!(
            health.ssh,
            DaedalusSshCheck::Failed {
                reason: "ssh: connection timed out".into(),
                target: "santiago@s2.example.org".into(),
            }
        );
        assert!(matches!(health.daemon, DaedalusDaemonCheck::Skipped { .. }));
    }

    /// Installed but the link can't complete: the service isn't running. A
    /// binary that names another protocol is a mismatch even so.
    #[tokio::test]
    async fn installed_but_unlinked_is_not_running_or_a_mismatch() {
        let target = target();
        let installed = |protocol| ProbeOutcome::Installed {
            version_line: String::new(),
            version: None,
            protocol,
        };
        let unreachable = || async {
            DaemonReach::Unreachable {
                reason: "ssh: santree-remote: no daemon socket".into(),
            }
        };
        let health = staged(
            DaedalusApiCheck::Ok,
            Some(&target),
            |_| async move { installed(Some(PROTOCOL_VERSION)) },
            unreachable,
        )
        .await;
        assert_eq!(
            health.daemon,
            DaedalusDaemonCheck::NotRunning {
                reason: "ssh: santree-remote: no daemon socket".into()
            }
        );
        let health = staged(
            DaedalusApiCheck::Ok,
            Some(&target),
            |_| async move { installed(Some(PROTOCOL_VERSION + 1)) },
            unreachable,
        )
        .await;
        assert_eq!(
            health.daemon,
            DaedalusDaemonCheck::VersionMismatch {
                theirs: Some(PROTOCOL_VERSION + 1)
            }
        );
    }

    #[tokio::test]
    async fn nothing_to_try_is_skipped_with_what_is_missing() {
        let health = staged(
            api_404(),
            None,
            |_| async { unreachable!("no target to probe") },
            never_asked,
        )
        .await;
        assert_eq!(
            health.ssh,
            DaedalusSshCheck::Skipped {
                reason: "Waiting for Daedalus's connection info.".into()
            }
        );
        let target = target();
        let health = staged(
            DaedalusApiCheck::NotConfigured,
            Some(&target),
            |_| async { unreachable!("not configured") },
            never_asked,
        )
        .await;
        assert!(matches!(health.ssh, DaedalusSshCheck::Skipped { .. }));
        assert!(matches!(health.daemon, DaedalusDaemonCheck::Skipped { .. }));
    }
}
