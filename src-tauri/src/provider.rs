//! Provider adapters for interactive agent sessions.
//!
//! Workflows validate their target and choose a [`SessionSurface`] before this
//! boundary. Providers own only vendor-specific session lifecycle. Adding a
//! provider must not require a new branch in Trees, Triage, or Reviews: register
//! an adapter here and implement the frontend launch contract with the same kind.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use async_trait::async_trait;
use santree_core::domain::{AgentKind, AgentSession, AgentVersionStatus};
use serde::Deserialize;
use tokio::io::AsyncReadExt;

use crate::codex_config;
use crate::db::Db;
use crate::session;
use crate::settings;

const CLAUDE_LATEST_URL: &str = "https://registry.npmjs.org/@anthropic-ai%2Fclaude-code/latest";
const VERSION_RESPONSE_LIMIT: usize = 64 * 1024;
const VERSION_PROCESS_LIMIT: usize = 8 * 1024;
const VERSION_PROCESS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

#[derive(Deserialize)]
struct PublishedVersion {
    version: String,
}

/// Version discovery is provider-owned: workflow and Settings UI code only
/// consume the typed result. A registry outage never makes an installed CLI
/// unavailable; it only leaves the comparison unknown.
pub async fn version_status(db: &Db, kind: AgentKind) -> AgentVersionStatus {
    let installed = installed_version(db, kind).await;
    let latest = latest_version(kind).await;
    let update_available = match (&installed, &latest) {
        (Some(installed), Some(latest)) => version_parts(latest) > version_parts(installed),
        _ => false,
    };
    AgentVersionStatus {
        installed,
        latest,
        update_available,
    }
}

async fn installed_version(db: &Db, kind: AgentKind) -> Option<String> {
    let executable = settings::agent_executable(db, kind).await.ok()?;
    match probe_cli_version(&executable).await {
        Ok(version) => normalize_version(&version),
        Err(error) => {
            log::warn!(
                "could not check installed {} version: {error:#}",
                kind.as_str()
            );
            None
        }
    }
}

async fn probe_cli_version(executable: &str) -> Result<String> {
    let mut child = tokio::process::Command::new(executable)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("version process stdout was not captured"))?;
    let probe = async {
        let mut body = Vec::new();
        stdout
            .take((VERSION_PROCESS_LIMIT + 1) as u64)
            .read_to_end(&mut body)
            .await?;
        if body.len() > VERSION_PROCESS_LIMIT {
            bail!("version output exceeds {VERSION_PROCESS_LIMIT} bytes");
        }
        if !child.wait().await?.success() {
            bail!("version process exited unsuccessfully");
        }
        String::from_utf8(body)
            .map_err(Into::into)
            .and_then(|output| {
                output
                    .lines()
                    .next()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| anyhow::anyhow!("version process returned no output"))
            })
    };
    tokio::time::timeout(VERSION_PROCESS_TIMEOUT, probe)
        .await
        .map_err(|_| anyhow::anyhow!("version process timed out"))?
}

async fn latest_version(kind: AgentKind) -> Option<String> {
    let url = match kind {
        AgentKind::Claude => CLAUDE_LATEST_URL,
        AgentKind::Codex | AgentKind::Cursor | AgentKind::Opencode => return None,
    };
    match fetch_published_version(url).await {
        Ok(version) => Some(version),
        Err(error) => {
            log::warn!(
                "could not check latest {} version: {error:#}",
                kind.as_str()
            );
            None
        }
    }
}

async fn fetch_published_version(url: &str) -> Result<String> {
    let mut response = crate::gql::client()
        .get(url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await?
        .error_for_status()?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > VERSION_RESPONSE_LIMIT {
            bail!("version response exceeds {VERSION_RESPONSE_LIMIT} bytes");
        }
        body.extend_from_slice(&chunk);
    }
    let version = serde_json::from_slice::<PublishedVersion>(&body)?.version;
    normalize_version(&version)
        .ok_or_else(|| anyhow::anyhow!("registry returned an invalid version"))
}

fn normalize_version(raw: &str) -> Option<String> {
    raw.split_whitespace().find_map(|token| {
        let version = token.trim_start_matches('v');
        version_parts(version).map(|_| version.to_string())
    })
}

fn version_parts(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.split('.');
    let parsed = [
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ];
    parts.next().is_none().then_some(parsed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionSurface {
    Work,
    Investigate,
    AskAi,
    Review,
    FixCi,
}

impl SessionSurface {
    pub fn setting_keys(self) -> (&'static str, &'static str) {
        match self {
            Self::Investigate => ("investigate_model", "investigate_effort"),
            Self::AskAi | Self::Review => ("review_model", "review_effort"),
            Self::Work | Self::FixCi => ("work_model", "work_effort"),
        }
    }

    pub fn agent_key(self) -> &'static str {
        match self {
            Self::Investigate => "investigate_agent",
            Self::AskAi | Self::Review => "review_agent",
            Self::Work | Self::FixCi => "work_agent",
        }
    }
}

pub struct SessionRequest<'a> {
    pub db: &'a Db,
    pub repo: &'a str,
    pub term_key: &'a str,
    pub cwd: &'a Path,
    pub allow_fresh: bool,
    /// The resolved per-surface model and effort. Claude's launch line is still
    /// assembled in the frontend from the same settings; Codex's is built here,
    /// so that provider selection and launch configuration stay one decision
    /// rather than two that can disagree.
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub surface: SessionSurface,
    /// santree's review MCP config for this session, derived by the caller from
    /// the session's own row. `None` for every surface that has no review tools;
    /// a review that reaches [`CodexProvider`] without one fails to launch.
    pub review_mcp_config: Option<&'a Path>,
}

#[async_trait]
pub trait AgentProvider: Send + Sync {
    fn kind(&self) -> AgentKind;

    async fn resolve_session(&self, request: SessionRequest<'_>) -> Result<AgentSession>;
}

struct ClaudeProvider {
    home: Option<PathBuf>,
    executable: String,
}

#[async_trait]
impl AgentProvider for ClaudeProvider {
    fn kind(&self) -> AgentKind {
        AgentKind::Claude
    }

    async fn resolve_session(&self, request: SessionRequest<'_>) -> Result<AgentSession> {
        session::resolve(
            request.db,
            request.repo,
            request.term_key,
            &request.cwd.to_string_lossy(),
            self.home.as_deref(),
            &self.executable,
            request.allow_fresh,
        )
        .await
    }
}

struct CodexProvider {
    /// `$CODEX_HOME/sessions`, resolved once here the way `ClaudeProvider`
    /// resolves `HOME` — it is what decides whether a stored thread id is still
    /// resumable.
    sessions_root: Option<PathBuf>,
    executable: String,
}

#[async_trait]
impl AgentProvider for CodexProvider {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }

    /// Two steps, deliberately: `resolve_codex` decides *which* thread runs, and
    /// [`codex_config`] decides what it runs *under*. The second is attached to
    /// the session rather than left to the frontend because every Codex launch
    /// site takes an `AgentSession` and only some of them remembered to pass a
    /// sandbox — which is how an AI review came to launch with no tools at all.
    async fn resolve_session(&self, request: SessionRequest<'_>) -> Result<AgentSession> {
        let session = session::resolve_codex(
            request.db,
            session::CodexSessionOpts {
                executable: &self.executable,
                repo: request.repo,
                term_key: request.term_key,
                allow_fresh: request.allow_fresh,
                sessions_root: self.sessions_root.as_deref(),
            },
        )
        .await?;
        if matches!(session, AgentSession::Shell) {
            return Ok(session);
        }
        let flags = codex_config::launch_flags(&codex_config::LaunchConfig {
            surface: request.surface,
            fresh: matches!(session, AgentSession::Fresh { .. }),
            model: request.model,
            effort: request.effort,
            review_mcp_config: request.review_mcp_config,
        })?;
        // The CLI ignores a `-c` key it does not recognise, so "we passed it" is
        // not "it applied". Checked against this exact binary, once per launch,
        // in about 20ms — see `codex_config::validate_overrides`.
        codex_config::validate_overrides(&self.executable, &flags).await?;
        Ok(session.with_launch_flags(flags))
    }
}

pub fn provider(kind: AgentKind, executable: String) -> Result<Box<dyn AgentProvider>> {
    match kind {
        AgentKind::Claude => Ok(Box::new(ClaudeProvider {
            home: std::env::var_os("HOME").map(PathBuf::from),
            executable,
        })),
        AgentKind::Codex => Ok(Box::new(CodexProvider {
            sessions_root: crate::codex_rollouts::sessions_root(),
            executable,
        })),
        AgentKind::Cursor | AgentKind::Opencode => {
            bail!("{} interactive sessions are not supported", kind.as_str())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_surface_has_an_explicit_settings_family() {
        assert_eq!(SessionSurface::Work.setting_keys().0, "work_model");
        assert_eq!(SessionSurface::FixCi.setting_keys().0, "work_model");
        assert_eq!(
            SessionSurface::Investigate.setting_keys().0,
            "investigate_model"
        );
        assert_eq!(SessionSurface::AskAi.setting_keys().0, "review_model");
        assert_eq!(SessionSurface::Review.setting_keys().0, "review_model");
    }

    #[test]
    fn unsupported_providers_do_not_fall_through_to_claude() {
        for kind in [AgentKind::Cursor, AgentKind::Opencode] {
            let error = match provider(kind, "/bin/false".into()) {
                Ok(_) => panic!("unsupported provider unexpectedly resolved"),
                Err(error) => error,
            };
            assert!(error.to_string().contains("not supported"));
        }
    }

    #[test]
    fn cli_and_registry_versions_normalize_before_comparison() {
        assert_eq!(
            normalize_version("2.1.241 (Claude Code)"),
            Some("2.1.241".into())
        );
        assert_eq!(normalize_version("v2.2.0"), Some("2.2.0".into()));
        assert_eq!(
            normalize_version("codex-cli 0.149.0"),
            Some("0.149.0".into())
        );
        assert_eq!(normalize_version("not-a-version"), None);
        assert!(version_parts("2.2.0") > version_parts("2.1.241"));
    }
}
