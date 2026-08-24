//! Provider adapters for interactive agent sessions.
//!
//! Workflows validate their target and choose a [`SessionSurface`] before this
//! boundary. Providers own only vendor-specific session lifecycle. Adding a
//! provider must not require a new branch in Trees, Triage, or Reviews: register
//! an adapter here and implement the frontend launch contract with the same kind.

use std::path::{Path, PathBuf};

use anyhow::{bail, Result};
use async_trait::async_trait;
use santree_core::domain::{AgentKind, AgentSession};

use crate::codex::{CodexProfile, CodexRuntime};
use crate::db::Db;
use crate::session;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionSurface {
    Work,
    Investigate,
    AskAi,
    Review,
    FixCi,
}

impl SessionSurface {
    pub fn codex_profile(self) -> CodexProfile {
        match self {
            Self::Work => CodexProfile::Work,
            Self::Review => CodexProfile::Review,
            Self::Investigate | Self::AskAi => CodexProfile::ReadOnly,
            Self::FixCi => CodexProfile::FixCi,
        }
    }

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
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub surface: SessionSurface,
    pub allow_fresh: bool,
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

struct CodexProvider<'a> {
    runtime: &'a CodexRuntime,
    executable: String,
}

#[async_trait]
impl AgentProvider for CodexProvider<'_> {
    fn kind(&self) -> AgentKind {
        AgentKind::Codex
    }

    async fn resolve_session(&self, request: SessionRequest<'_>) -> Result<AgentSession> {
        session::resolve_codex(
            request.db,
            self.runtime,
            session::CodexSessionOpts {
                executable: &self.executable,
                repo: request.repo,
                term_key: request.term_key,
                cwd: request.cwd,
                model: request.model,
                effort: request.effort,
                profile: request.surface.codex_profile(),
                allow_fresh: request.allow_fresh,
                review_mcp_config: request.review_mcp_config,
            },
        )
        .await
    }
}

pub fn provider<'a>(
    kind: AgentKind,
    runtime: &'a CodexRuntime,
    executable: String,
) -> Result<Box<dyn AgentProvider + 'a>> {
    match kind {
        AgentKind::Claude => Ok(Box::new(ClaudeProvider {
            home: std::env::var_os("HOME").map(PathBuf::from),
            executable,
        })),
        AgentKind::Codex => Ok(Box::new(CodexProvider {
            runtime,
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
    fn every_surface_has_an_explicit_security_profile_and_settings_family() {
        assert_eq!(SessionSurface::Work.codex_profile(), CodexProfile::Work);
        assert_eq!(SessionSurface::FixCi.codex_profile(), CodexProfile::FixCi);
        assert_eq!(SessionSurface::Review.codex_profile(), CodexProfile::Review);
        assert_eq!(
            SessionSurface::Investigate.codex_profile(),
            CodexProfile::ReadOnly
        );
        assert_eq!(SessionSurface::AskAi.setting_keys().0, "review_model");
        assert_eq!(SessionSurface::Review.setting_keys().0, "review_model");
    }

    #[test]
    fn unsupported_providers_do_not_fall_through_to_claude() {
        let runtime = CodexRuntime::new(Path::new("/tmp/santree-provider-test"));
        for kind in [AgentKind::Cursor, AgentKind::Opencode] {
            let error = match provider(kind, &runtime, "/bin/false".into()) {
                Ok(_) => panic!("unsupported provider unexpectedly resolved"),
                Err(error) => error,
            };
            assert!(error.to_string().contains("not supported"));
        }
    }
}
