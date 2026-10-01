//! The Daedalus agent's own socket, `agent.sock`: this machine's settings —
//! keeping it awake, Claude Remote Control, santree on the box — read and
//! asked for (docs/remote.md, "This Mac's settings").
//!
//! The box decides them: the agent never applies one. `settings.set` asks the
//! box over the agent's link and answers at once (`sent`); the settings read
//! back show it on its way (`pending`) until the box's policy carries it, or
//! why it didn't take (`failed`). santree ON is never sent: it grants a shell
//! on the box, so the agent answers the Daedalus page where an admin confirms
//! it (`confirm_url`), which the caller opens.
//!
//! A call is one request per connection, in the agent's envelope:
//! `{"id":1,"m":"<method>","p":…}` → `{"id":1,"ok":…}` or
//! `{"id":1,"err":{"code","msg"}}`, one line each way, then the agent closes.
//! The other end is checked as for santree's socket (root serves it and owns
//! the file, [`crate::agent::check_server`]). An agent from before 0.25 answers
//! `unknown_method`: [`ControlError::Outdated`].

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use crate::agent::{check_server, AGENT_SOCKET, RUN_DIR};
use crate::transport::ConnectError;

/// The longest answer line read. The settings are a few hundred bytes.
pub const ANSWER_MAX: usize = 16 * 1024;
/// A whole call, connect to answer. The agent answers these from memory.
pub const CALL_WAIT: Duration = Duration::from_secs(5);

/// The agent's own socket on this OS.
pub fn control_socket_path() -> PathBuf {
    Path::new(RUN_DIR).join(AGENT_SOCKET)
}

/// A setting this machine may ask the box for (the agent's `Key`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingKey {
    AwakeHold,
    ClaudeRemoteControl,
    Santree,
}

/// Where a request waits: on the box (the agent's link), or on an admin in the
/// browser (santree ON).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingVia {
    Box,
    Browser,
}

/// A request on its way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingSetting {
    pub key: SettingKey,
    pub want: bool,
    pub via: SettingVia,
}

/// A request that did not take, in the agent's words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailedSetting {
    pub key: SettingKey,
    pub want: bool,
    pub why: String,
}

/// `settings.get`'s answer (the agent's `settings::View`): the values the box
/// keeps, what is on its way, what failed, and whether the caller may change
/// them. Fields this santree doesn't know are ignored.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineSettings {
    pub node: Option<String>,
    pub fingerprint: Option<String>,
    pub fingerprint_short: Option<String>,
    /// The agent's link to the box is up and the box approved this machine.
    pub linked: bool,
    pub awake_hold: bool,
    pub claude_remote_control: bool,
    pub santree: bool,
    #[serde(default)]
    pub pending: Vec<PendingSetting>,
    #[serde(default)]
    pub failed: Vec<FailedSetting>,
    /// Who may change them on this machine (the user who installed the agent).
    #[serde(default)]
    pub operator: Option<String>,
    /// Whether the user asking may change them.
    #[serde(default)]
    pub may_change: Option<bool>,
}

/// What `settings.set` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetOutcome {
    /// Recorded; the agent asks the box now.
    Sent,
    /// The box already holds that value.
    Unchanged,
    /// santree ON: nothing sent; open this page, where an admin confirms it.
    Confirm(String),
}

/// Why a call to the agent's socket got no answer to use.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ControlError {
    /// No agent socket: the Daedalus agent isn't installed.
    #[error("the Daedalus agent isn't installed on this machine")]
    NoAgent,
    /// The agent doesn't know the method: it predates 0.25.
    #[error("the Daedalus agent on this machine is too old to change its settings from santree")]
    Outdated,
    /// Something other than the agent holds its socket.
    #[error("{0}")]
    Untrusted(String),
    /// The agent refused the request; `code` and `msg` are its own.
    #[error("{msg}")]
    Refused { code: String, msg: String },
    /// Anything else, as a short human line.
    #[error("{0}")]
    Failed(String),
}

impl From<ConnectError> for ControlError {
    fn from(e: ConnectError) -> Self {
        match e {
            ConnectError::Untrusted(msg) => ControlError::Untrusted(msg),
            other => ControlError::Failed(other.to_string()),
        }
    }
}

/// Calls on the Daedalus agent's own socket.
#[derive(Debug, Clone)]
pub struct AgentControl {
    socket: PathBuf,
    /// Who must serve it and own the file: root.
    server_uid: u32,
}

impl Default for AgentControl {
    fn default() -> Self {
        Self {
            socket: control_socket_path(),
            server_uid: 0,
        }
    }
}

impl AgentControl {
    /// The installed agent's socket.
    pub fn new() -> Self {
        Self::default()
    }

    /// A socket of the test's, served by `server_uid` (the test's own).
    #[cfg(any(test, feature = "fake"))]
    pub fn at(socket: impl Into<PathBuf>, server_uid: u32) -> Self {
        Self {
            socket: socket.into(),
            server_uid,
        }
    }

    /// This machine's settings, as the agent keeps them.
    pub async fn settings(&self) -> Result<MachineSettings, ControlError> {
        let ok = self.call("settings.get", Value::Null).await?;
        serde_json::from_value(ok).map_err(|e| {
            ControlError::Failed(format!(
                "the Daedalus agent's settings aren't what this santree reads: {e}"
            ))
        })
    }

    /// Ask the box for `key` = `value`.
    pub async fn set(&self, key: SettingKey, value: bool) -> Result<SetOutcome, ControlError> {
        #[derive(Deserialize)]
        struct Answer {
            #[serde(default)]
            sent: bool,
            #[serde(default)]
            unchanged: bool,
            #[serde(default)]
            confirm_url: Option<String>,
        }
        let ok = self
            .call(
                "settings.set",
                serde_json::json!({ "key": key, "value": value }),
            )
            .await?;
        let answer: Answer = serde_json::from_value(ok).map_err(|e| {
            ControlError::Failed(format!(
                "the Daedalus agent's answer isn't one santree reads: {e}"
            ))
        })?;
        match answer {
            Answer {
                confirm_url: Some(url),
                ..
            } => Ok(SetOutcome::Confirm(url)),
            Answer { sent: true, .. } => Ok(SetOutcome::Sent),
            Answer {
                unchanged: true, ..
            } => Ok(SetOutcome::Unchanged),
            _ => Err(ControlError::Failed(
                "the Daedalus agent answered without saying what it did".into(),
            )),
        }
    }

    /// One request, one answer, within [`CALL_WAIT`].
    async fn call(&self, method: &str, params: Value) -> Result<Value, ControlError> {
        tokio::time::timeout(CALL_WAIT, self.exchange(method, params))
            .await
            .map_err(|_| ControlError::Failed("the Daedalus agent didn't answer in time".into()))?
    }

    async fn exchange(&self, method: &str, params: Value) -> Result<Value, ControlError> {
        let mut stream = match UnixStream::connect(&self.socket).await {
            Ok(stream) => stream,
            Err(e) if e.kind() == ErrorKind::NotFound => return Err(ControlError::NoAgent),
            Err(e) if e.kind() == ErrorKind::ConnectionRefused => {
                return Err(ControlError::Failed(
                    "the Daedalus agent isn't running".into(),
                ))
            }
            Err(e) => {
                return Err(ControlError::Failed(format!(
                    "can't open the Daedalus agent's socket: {e}"
                )))
            }
        };
        check_server(&self.socket, &stream, self.server_uid)?;
        let mut request =
            serde_json::to_vec(&serde_json::json!({ "id": 1, "m": method, "p": params }))
                .map_err(|e| ControlError::Failed(e.to_string()))?;
        request.push(b'\n');
        stream
            .write_all(&request)
            .await
            .map_err(|e| ControlError::Failed(format!("writing to the Daedalus agent: {e}")))?;
        let line = answer_line(&mut stream).await?;
        envelope(&line)
    }
}

/// The agent's answer line, without its newline.
async fn answer_line(stream: &mut UnixStream) -> Result<Vec<u8>, ControlError> {
    let mut line = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = match stream.read(&mut buf).await {
            Ok(0) => {
                return Err(ControlError::Failed(
                    "the Daedalus agent closed the connection without answering".into(),
                ))
            }
            Ok(n) => n,
            Err(e) => {
                return Err(ControlError::Failed(format!(
                    "reading the Daedalus agent's answer: {e}"
                )))
            }
        };
        let chunk = &buf[..n];
        if let Some(end) = chunk.iter().position(|b| *b == b'\n') {
            line.extend_from_slice(&chunk[..end]);
            return if line.len() > ANSWER_MAX {
                Err(too_long())
            } else {
                Ok(line)
            };
        }
        line.extend_from_slice(chunk);
        if line.len() > ANSWER_MAX {
            return Err(too_long());
        }
    }
}

fn too_long() -> ControlError {
    ControlError::Failed("the Daedalus agent's answer is too long".into())
}

/// The envelope's `ok`, or its `err` as a [`ControlError`].
fn envelope(line: &[u8]) -> Result<Value, ControlError> {
    #[derive(Deserialize)]
    struct Envelope {
        #[serde(default)]
        ok: Option<Value>,
        #[serde(default)]
        err: Option<Err>,
    }
    #[derive(Deserialize)]
    struct Err {
        code: String,
        msg: String,
    }
    let unreadable = || {
        ControlError::Failed(
            "the Daedalus agent answered in a way this santree doesn't understand".into(),
        )
    };
    let env: Envelope = serde_json::from_slice(line).map_err(|_| unreadable())?;
    match (env.ok, env.err) {
        (_, Some(err)) if err.code == "unknown_method" => Err(ControlError::Outdated),
        (None, Some(err)) => Err(ControlError::Refused {
            code: err.code,
            msg: err.msg,
        }),
        // `ok: null` is a valid answer (`"ok":null` deserializes as None).
        (ok, None) => Ok(ok.unwrap_or(Value::Null)),
        (Some(_), Some(_)) => Err(unreadable()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_is_the_agents_own() {
        let path = control_socket_path();
        assert!(path.ends_with("daedalus-agent/run/agent.sock"), "{path:?}");
    }

    #[test]
    fn envelopes_read_as_answers_or_refusals() {
        assert_eq!(
            envelope(br#"{"id":1,"ok":{"sent":true}}"#),
            Ok(serde_json::json!({ "sent": true }))
        );
        assert_eq!(
            envelope(
                br#"{"id":1,"err":{"code":"unknown_method","msg":"no method `settings.get`"}}"#
            ),
            Err(ControlError::Outdated)
        );
        assert_eq!(
            envelope(br#"{"id":1,"err":{"code":"forbidden","msg":"uid 501 may not"}}"#),
            Err(ControlError::Refused {
                code: "forbidden".into(),
                msg: "uid 501 may not".into()
            })
        );
        for garbage in [
            &b"nope"[..],
            br#"{"id":1,"ok":1,"err":{"code":"x","msg":"y"}}"#,
        ] {
            assert!(
                matches!(envelope(garbage), Err(ControlError::Failed(_))),
                "{}",
                String::from_utf8_lossy(garbage)
            );
        }
    }

    /// The agent 0.25 wire, as `settings.get` writes it.
    #[test]
    fn the_agents_settings_read_as_written() {
        let wire = serde_json::json!({
            "node": "0123456789abcdef",
            "fingerprint": "f876:e2c7:1a0b:8029",
            "fingerprint_short": "f876:e2c7…8029",
            "linked": true,
            "awake_hold": true,
            "claude_remote_control": false,
            "santree": false,
            "pending": [{ "key": "santree", "want": true, "via": "browser" }],
            "failed": [{ "key": "awake_hold", "want": false, "why": "not connected to the box" }],
            "operator_uid": 501,
            "operator": "santiago",
            "may_change": true,
            "something_newer": 1
        });
        let s: MachineSettings = serde_json::from_value(wire).unwrap();
        assert_eq!(s.fingerprint_short.as_deref(), Some("f876:e2c7…8029"));
        assert_eq!(
            s.pending,
            [PendingSetting {
                key: SettingKey::Santree,
                want: true,
                via: SettingVia::Browser
            }]
        );
        assert_eq!(s.failed[0].key, SettingKey::AwakeHold);
        assert_eq!(s.may_change, Some(true));
        assert_eq!(
            serde_json::to_value(SettingKey::ClaudeRemoteControl).unwrap(),
            "claude_remote_control"
        );
    }

    fn settings() -> MachineSettings {
        MachineSettings {
            node: Some("0123456789abcdef".into()),
            fingerprint: Some("f876:e2c7:1a0b:8029".into()),
            fingerprint_short: Some("f876:e2c7…8029".into()),
            linked: true,
            awake_hold: true,
            claude_remote_control: true,
            santree: false,
            operator: Some("santiago".into()),
            ..MachineSettings::default()
        }
    }

    /// Against a fake `agent.sock`: read, ask, the box applying it, santree ON
    /// answered with its page, and asking for what the box holds.
    #[tokio::test]
    async fn settings_are_read_and_asked_for_on_the_agents_socket() {
        let dir = tempfile::tempdir().unwrap();
        let agent = crate::fake::FakeAgentControl::serve(dir.path().join("agent.sock"), settings())
            .unwrap();
        let control = agent.control();

        let read = control.settings().await.unwrap();
        assert!(read.awake_hold && read.linked && !read.santree);
        assert_eq!(read.may_change, Some(true));

        assert_eq!(
            control.set(SettingKey::AwakeHold, false).await,
            Ok(SetOutcome::Sent)
        );
        let pending = control.settings().await.unwrap().pending;
        assert_eq!(
            pending,
            [PendingSetting {
                key: SettingKey::AwakeHold,
                want: false,
                via: SettingVia::Box
            }]
        );
        agent.apply(SettingKey::AwakeHold, false);
        let applied = control.settings().await.unwrap();
        assert!(!applied.awake_hold && applied.pending.is_empty());
        assert_eq!(
            control.set(SettingKey::AwakeHold, false).await,
            Ok(SetOutcome::Unchanged)
        );

        assert_eq!(
            control.set(SettingKey::Santree, true).await,
            Ok(SetOutcome::Confirm(format!(
                "{}/settings?tab=machines&node=0123456789abcdef&santree=on",
                crate::fake::FakeAgentControl::APP_URL
            )))
        );
        assert_eq!(
            control.settings().await.unwrap().pending[0].via,
            SettingVia::Browser
        );

        // The wire: one request per connection, in the agent's envelope.
        let requests = agent.requests();
        assert_eq!(
            requests[0],
            serde_json::json!({ "id": 1, "m": "settings.get", "p": null })
        );
        assert_eq!(
            requests[1],
            serde_json::json!({ "id": 1, "m": "settings.set", "p": { "key": "awake_hold", "value": false } })
        );
    }

    /// Every way a call gets no usable answer: no agent, an old one, a
    /// refusal, and a socket somebody else serves.
    #[tokio::test]
    async fn every_unanswered_call_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("agent.sock");
        assert_eq!(
            AgentControl::at(&socket, 0).settings().await,
            Err(ControlError::NoAgent)
        );

        let agent = crate::fake::FakeAgentControl::serve(&socket, settings()).unwrap();
        let control = agent.control();
        agent.set_may_change(false);
        assert_eq!(control.settings().await.unwrap().may_change, Some(false));
        assert!(matches!(
            control.set(SettingKey::AwakeHold, false).await,
            Err(ControlError::Refused { code, .. }) if code == "forbidden"
        ));
        agent.set_may_change(true);

        agent.set_linked(false);
        assert_eq!(
            control.set(SettingKey::AwakeHold, false).await,
            Err(ControlError::Refused {
                code: "unavailable".into(),
                msg: "not connected to the box".into()
            })
        );
        assert_eq!(
            control.settings().await.unwrap().failed[0].why,
            "not connected to the box"
        );

        agent.set_app_url(None);
        assert!(matches!(
            control.set(SettingKey::Santree, true).await,
            Err(ControlError::Refused { code, .. }) if code == "unsupported"
        ));

        agent.set_outdated(true);
        assert_eq!(control.settings().await, Err(ControlError::Outdated));
        assert_eq!(
            control.set(SettingKey::AwakeHold, true).await,
            Err(ControlError::Outdated)
        );

        // Served by someone else than the uid it must be: refused unasked.
        use std::os::unix::fs::MetadataExt;
        let owner = std::fs::symlink_metadata(&socket).unwrap().uid();
        let before = agent.requests().len();
        assert!(matches!(
            AgentControl::at(&socket, owner + 1).settings().await,
            Err(ControlError::Untrusted(_))
        ));
        assert_eq!(agent.requests().len(), before, "nothing was sent");
    }
}
