//! Protocol v1 — the typed mirror of docs/remote.md "Protocol v1".
//!
//! Newline-delimited JSON, one object per line, both directions:
//!
//! - request  `{"id":<u64>,"m":"<method>","p":{…}}`
//! - response `{"id":<u64>,"ok":<result>}` | `{"id":<u64>,"err":{"code","msg"}}`
//! - event    `{"e":"<name>","p":{…}}` (server → client only)
//!
//! Every method is a marker type in [`m`] implementing [`Method`], which ties
//! its wire name to its params and result types — the client's `call` and the
//! fake daemon's dispatch both go through it, so the two can't disagree about a
//! shape. Binary fields are `Vec<u8>` on this side and standard padded base64 on
//! the wire ([`b64`]).
//!
//! Decoding is lenient where the doc is silent (a missing optional key and an
//! explicit `null` read the same; unknown keys are ignored) and encoding is
//! exact, so a daemon that adds a field later doesn't break an older app.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;

pub use santree_core::domain::AgentKind;

/// The protocol this client speaks. `hello` refuses any other with `version`.
pub const PROTOCOL_VERSION: u32 = 1;

/// A daemon-side PTY session id (the daemon's `PtyManager` id).
pub type SessionId = u32;

/// `fs.read` never returns more than this per call.
pub const FS_READ_MAX: u64 = 8 * 1024 * 1024;
/// `exec.run` when the request names no timeout.
pub const EXEC_DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// `exec.run`'s ceiling; a larger request is clamped to it.
pub const EXEC_MAX_TIMEOUT_MS: u64 = 600_000;
/// The daemon's in-memory hook queue; overflow drops the oldest and says so
/// with `hooks.dropped`.
pub const HOOK_QUEUE_CAP: usize = 10_000;
/// How often the daemon sends `{"e":"ping"}`.
pub const PING_INTERVAL: Duration = Duration::from_secs(15);

// ── base64 ────────────────────────────────────────────────────────────────

/// `#[serde(with = "b64")]` for a `Vec<u8>` field: standard alphabet, padded.
pub mod b64 {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::de::Error;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(d)?;
        STANDARD.decode(text.as_bytes()).map_err(D::Error::custom)
    }
}

/// [`b64`] for an optional field. Pair with `default` and
/// `skip_serializing_if = "Option::is_none"`.
pub mod b64_opt {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::de::Error;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &Option<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
        match bytes {
            Some(bytes) => s.serialize_some(&STANDARD.encode(bytes)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Vec<u8>>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|text| STANDARD.decode(text.as_bytes()).map_err(D::Error::custom))
            .transpose()
    }
}

// ── errors ────────────────────────────────────────────────────────────────

/// The `code` of an error response. `Other` keeps a code a newer daemon sends
/// rather than failing the whole frame on it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    BadRequest,
    NotFound,
    /// A path resolved outside the `within` root it was confined to.
    Outside,
    Io,
    Timeout,
    Version,
    Other(String),
}

impl ErrorCode {
    pub fn as_str(&self) -> &str {
        match self {
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::NotFound => "not_found",
            ErrorCode::Outside => "outside",
            ErrorCode::Io => "io",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Version => "version",
            ErrorCode::Other(code) => code,
        }
    }
}

impl From<&str> for ErrorCode {
    fn from(code: &str) -> Self {
        match code {
            "bad_request" => ErrorCode::BadRequest,
            "not_found" => ErrorCode::NotFound,
            "outside" => ErrorCode::Outside,
            "io" => ErrorCode::Io,
            "timeout" => ErrorCode::Timeout,
            "version" => ErrorCode::Version,
            other => ErrorCode::Other(other.to_string()),
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl Serialize for ErrorCode {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ErrorCode {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(ErrorCode::from(String::deserialize(d)?.as_str()))
    }
}

/// An error response's body.
///
/// `protocol` is an addition to the doc's `{code,msg}`: on a `version` refusal
/// the daemon names the protocol it *does* speak, so the app can say "the
/// server speaks v2" rather than parse it out of `msg`. Absent everywhere else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[error("{code}: {msg}")]
pub struct WireError {
    pub code: ErrorCode,
    #[serde(default)]
    pub msg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<u32>,
}

impl WireError {
    pub fn new(code: ErrorCode, msg: impl Into<String>) -> Self {
        Self {
            code,
            msg: msg.into(),
            protocol: None,
        }
    }
}

// ── methods ───────────────────────────────────────────────────────────────

/// One protocol method: its wire name and the shapes on either side of it.
pub trait Method {
    const NAME: &'static str;
    type Params: Serialize + DeserializeOwned + Send + Sync + 'static;
    type Result: Serialize + DeserializeOwned + Send + 'static;
}

/// `{}` — the params of `pty.sessions` and the result of every method that
/// answers with nothing. Reads from *any* value (a daemon answering `null`
/// instead of `{}` is not worth failing a call over) and always writes `{}`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Empty;

impl Serialize for Empty {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        s.serialize_map(Some(0))?.end()
    }
}

impl<'de> Deserialize<'de> for Empty {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        serde::de::IgnoredAny::deserialize(d)?;
        Ok(Empty)
    }
}

/// The method markers. `client.call::<m::FsStat>(&params)`.
pub mod m {
    use super::*;

    macro_rules! methods {
        ($($(#[$doc:meta])* $ty:ident = $name:literal : $params:ty => $result:ty;)*) => {$(
            $(#[$doc])*
            pub enum $ty {}
            impl Method for $ty {
                const NAME: &'static str = $name;
                type Params = $params;
                type Result = $result;
            }
        )*};
    }

    methods! {
        /// First request on every connection.
        Hello = "hello": HelloParams => HelloResult;
        PtyOpen = "pty.open": PtyOpenParams => SessionInfo;
        /// See [`crate::RemoteClient::pty_attach`] for the ordering guarantee.
        PtyAttach = "pty.attach": PtyAttachParams => AttachResult;
        PtyDetach = "pty.detach": SessionRef => Empty;
        PtyWrite = "pty.write": PtyWriteParams => Empty;
        PtyResize = "pty.resize": PtyResizeParams => Empty;
        /// Kills the session.
        PtyClose = "pty.close": SessionRef => Empty;
        PtySessions = "pty.sessions": Empty => Vec<SessionInfo>;
        /// `PtyManager::adopt_others` on the daemon.
        PtyAdopt = "pty.adopt": PtyAdoptParams => Vec<SessionInfo>;
        ExecRun = "exec.run": ExecParams => ExecResult;
        FsRead = "fs.read": FsReadParams => FsReadResult;
        FsWrite = "fs.write": FsWriteParams => Empty;
        FsStat = "fs.stat": FsStatParams => super::FsStat;
        HooksPush = "hooks.push": HookPushParams => HookPushResult;
        HooksSubscribe = "hooks.subscribe": HooksSubscribeParams => Empty;
        HooksAck = "hooks.ack": HooksAckParams => Empty;
    }
}

// ── hello ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloParams {
    pub protocol: u32,
    /// `santree/<ver>`.
    pub client: String,
    /// A stable id for this app instance.
    pub owner: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloResult {
    pub protocol: u32,
    /// The daemon's own version (not the protocol's).
    pub version: String,
    pub hostname: String,
    pub user: String,
    pub home: String,
    /// Random per `serve` start. Hook `seq` restarts at 1 with each boot, so a
    /// cursor is only meaningful next to the boot it was taken under.
    #[serde(rename = "bootId")]
    pub boot_id: String,
}

// ── pty ───────────────────────────────────────────────────────────────────

/// The daemon's view of one session — `santree_pty::SessionInfo` on the wire.
/// Optional fields are written as `null`, never omitted: the doc lists every
/// key unconditionally.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: SessionId,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub command: String,
    pub owner: String,
    pub label: String,
    #[serde(default)]
    pub agent_kind: Option<AgentKind>,
    pub cols: u16,
    pub rows: u16,
    pub attached: bool,
    pub alive: bool,
    pub epoch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOpenParams {
    /// Absolute, on the server. Omitted = the daemon user's `$HOME`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Empty = the daemon user's login shell.
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
    /// `[[name, value], …]`.
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub owner: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<AgentKind>,
}

/// Where the client is in a session's stream — `santree_pty::Anchor` on the
/// wire: `{"at":{"epoch","seq"}}` | `"fresh"` | `"unknown"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Anchor {
    At { epoch: String, seq: u64 },
    Fresh,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReplayMode {
    Exact,
    Tail,
    Reanchor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyAttachParams {
    pub id: SessionId,
    pub anchor: Anchor,
}

/// `santree_pty::Replay` on the wire: write `data`, then count from `seq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachResult {
    pub mode: ReplayMode,
    pub epoch: String,
    pub seq: u64,
    #[serde(with = "b64")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionRef {
    pub id: SessionId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyWriteParams {
    pub id: SessionId,
    #[serde(with = "b64")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyResizeParams {
    pub id: SessionId,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyAdoptParams {
    pub owner: String,
}

// ── exec / fs ─────────────────────────────────────────────────────────────

/// `exec.run`: one process, argv only (no shell), always with
/// `GIT_OPTIONAL_LOCKS=0` layered last.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecParams {
    /// Absolute, on the server.
    pub cwd: String,
    pub argv: Vec<String>,
    /// `[[name, value], …]`, on top of the daemon's own environment — the same
    /// shape as `pty.open`'s `env`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<(String, String)>>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "b64_opt")]
    pub stdin: Option<Vec<u8>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// `exec.run`'s answer. Running past the timeout is not a result but a
/// `timeout` error (the process is killed).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ExecResult {
    /// The exit code; `null` when the process died of a signal.
    #[serde(default)]
    pub code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    #[serde(with = "b64")]
    pub stdout: Vec<u8>,
    #[serde(with = "b64")]
    pub stderr: Vec<u8>,
    /// Either stream was cut at the daemon's output cap.
    #[serde(default)]
    pub truncated: bool,
}

impl ExecResult {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct FsReadParams {
    pub path: String,
    /// Negative = from the end (`-5` = the last five bytes).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<i64>,
    /// At most [`FS_READ_MAX`]; omitted = that much.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub len: Option<u64>,
    /// When set, `path`'s real path must stay under this one's, else `outside`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub within: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsReadResult {
    #[serde(with = "b64")]
    pub data: Vec<u8>,
    /// The whole file's size, not `data`'s.
    pub size: u64,
    pub eof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsWriteParams {
    pub path: String,
    #[serde(with = "b64")]
    pub data: Vec<u8>,
    /// Unix permission bits (e.g. `0o755` = 493). Omitted = an existing
    /// file's mode is kept, a new one gets the daemon's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FsStatParams {
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FsKind {
    File,
    Dir,
    Symlink,
    Other,
}

/// `fs.stat` (an lstat). A missing path is `exists: false` with `kind: null`,
/// `size: 0`, `mtimeMs: 0` — an answer, not a `not_found` error.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    pub exists: bool,
    #[serde(default)]
    pub kind: Option<FsKind>,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub mtime_ms: i64,
}

// ── hooks ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookPushParams {
    /// The hook event name (`Stop`, `SessionStart`, …).
    pub event: String,
    /// `[[name, value], …]` — the hook process's environment, as captured.
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// The hook's stdin (the agent's JSON payload), as bytes.
    #[serde(with = "b64")]
    pub stdin: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookPushResult {
    pub seq: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct HooksSubscribeParams {
    /// Deliver only events with a greater seq. Omitted = everything queued.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksAckParams {
    pub up_to: u64,
}

// ── events ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyData {
    pub id: SessionId,
    #[serde(with = "b64")]
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PtyExit {
    pub id: SessionId,
}

/// One queued hook invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookEvent {
    pub seq: u64,
    /// When the daemon received it, in Unix milliseconds.
    pub at: i64,
    pub event: String,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(with = "b64")]
    pub stdin: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HooksDropped {
    pub count: u64,
}

/// A server → client event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "e", content = "p")]
pub enum Event {
    #[serde(rename = "pty.data")]
    PtyData(PtyData),
    #[serde(rename = "pty.exit")]
    PtyExit(PtyExit),
    #[serde(rename = "hook")]
    Hook(HookEvent),
    #[serde(rename = "hooks.dropped")]
    HooksDropped(HooksDropped),
    #[serde(rename = "ping")]
    Ping,
}

impl Event {
    /// The event as one line (no trailing newline).
    pub fn encode(&self) -> String {
        serde_json::to_string(self).expect("protocol events always serialize")
    }

    /// Decode an event from its name and payload. `Ok(None)` for a name this
    /// client doesn't know — a newer daemon's event is skipped, not fatal.
    pub fn decode(name: &str, p: Option<&RawValue>) -> Result<Option<Event>, serde_json::Error> {
        fn payload<T: DeserializeOwned>(p: Option<&RawValue>) -> Result<T, serde_json::Error> {
            serde_json::from_str(p.map(RawValue::get).unwrap_or("{}"))
        }
        Ok(Some(match name {
            "pty.data" => Event::PtyData(payload(p)?),
            "pty.exit" => Event::PtyExit(payload(p)?),
            "hook" => Event::Hook(payload(p)?),
            "hooks.dropped" => Event::HooksDropped(payload(p)?),
            "ping" => Event::Ping,
            _ => return Ok(None),
        }))
    }
}

// ── frames ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct RequestOut<'a, P> {
    id: u64,
    m: &'a str,
    p: &'a P,
}

/// A request line (no trailing newline).
pub fn encode_request<P: Serialize>(
    id: u64,
    method: &str,
    params: &P,
) -> serde_json::Result<String> {
    serde_json::to_string(&RequestOut {
        id,
        m: method,
        p: params,
    })
}

#[derive(Serialize)]
struct OkOut<'a, R: ?Sized> {
    id: u64,
    ok: &'a R,
}

#[derive(Serialize)]
struct ErrOut<'a> {
    id: u64,
    err: &'a WireError,
}

/// A success response line.
pub fn encode_ok<R: Serialize + ?Sized>(id: u64, result: &R) -> serde_json::Result<String> {
    serde_json::to_string(&OkOut { id, ok: result })
}

/// An error response line.
pub fn encode_err(id: u64, err: &WireError) -> String {
    serde_json::to_string(&ErrOut { id, err }).expect("error frames always serialize")
}

/// A request as the daemon reads it: the params stay raw until the method
/// name picks their type.
#[derive(Debug, Deserialize)]
pub struct RawRequest {
    pub id: u64,
    pub m: String,
    #[serde(default)]
    pub p: Option<Box<RawValue>>,
}

impl RawRequest {
    /// The params as `T`. A request with no `p` reads as `{}`, so methods
    /// whose params are all optional accept it.
    pub fn params<T: DeserializeOwned>(&self) -> Result<T, WireError> {
        let raw = self.p.as_deref().map(RawValue::get).unwrap_or("{}");
        serde_json::from_str(raw)
            .map_err(|e| WireError::new(ErrorCode::BadRequest, format!("{}: {e}", self.m)))
    }
}

pub fn decode_request(line: &str) -> serde_json::Result<RawRequest> {
    serde_json::from_str(line)
}

/// Anything the server can send.
#[derive(Debug)]
pub enum ServerFrame {
    /// A response. `Ok` holds the raw result; the caller decodes it into its
    /// method's `Result`. A response with neither `ok` nor `err` reads as
    /// `Ok(null)`.
    Response {
        id: u64,
        result: Result<Box<RawValue>, WireError>,
    },
    Event(Event),
    /// An event this client doesn't know, by name.
    UnknownEvent(String),
}

#[derive(Deserialize)]
struct FrameIn<'a> {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default, borrow)]
    ok: Option<&'a RawValue>,
    #[serde(default)]
    err: Option<WireError>,
    #[serde(default)]
    e: Option<String>,
    #[serde(default, borrow)]
    p: Option<&'a RawValue>,
}

pub fn decode_server_frame(line: &str) -> serde_json::Result<ServerFrame> {
    use serde::de::Error;
    let frame: FrameIn = serde_json::from_str(line)?;
    if let Some(name) = frame.e {
        return Ok(match Event::decode(&name, frame.p)? {
            Some(event) => ServerFrame::Event(event),
            None => ServerFrame::UnknownEvent(name),
        });
    }
    let id = frame
        .id
        .ok_or_else(|| serde_json::Error::custom("frame is neither a response nor an event"))?;
    let result = match frame.err {
        Some(err) => Err(err),
        None => Ok(match frame.ok {
            Some(ok) => ok.to_owned(),
            None => RawValue::from_string("null".to_string())?,
        }),
    };
    Ok(ServerFrame::Response { id, result })
}

#[cfg(test)]
mod tests {
    //! Exact wire text, checked against the shapes in docs/remote.md. A change
    //! here is a protocol change: it needs the doc and the daemon to move too.
    use super::*;

    fn req<M: Method>(id: u64, p: &M::Params) -> String {
        encode_request(id, M::NAME, p).unwrap()
    }

    /// Encode, compare with the doc's text, decode that text, compare values.
    fn round_trip<T>(value: &T, json: &str)
    where
        T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
    {
        assert_eq!(serde_json::to_string(value).unwrap(), json);
        assert_eq!(&serde_json::from_str::<T>(json).unwrap(), value);
    }

    #[test]
    fn hello_request_and_result() {
        let p = HelloParams {
            protocol: PROTOCOL_VERSION,
            client: "santree/0.1.16".into(),
            owner: "inst-1".into(),
        };
        assert_eq!(
            req::<m::Hello>(1, &p),
            r#"{"id":1,"m":"hello","p":{"protocol":1,"client":"santree/0.1.16","owner":"inst-1"}}"#
        );
        round_trip(
            &HelloResult {
                protocol: 1,
                version: "0.3.0".into(),
                hostname: "daedalus".into(),
                user: "santiago".into(),
                home: "/home/santiago".into(),
                boot_id: "b-1".into(),
            },
            r#"{"protocol":1,"version":"0.3.0","hostname":"daedalus","user":"santiago","home":"/home/santiago","bootId":"b-1"}"#,
        );
    }

    #[test]
    fn anchors_have_the_three_documented_shapes() {
        round_trip(
            &Anchor::At {
                epoch: "e1".into(),
                seq: 42,
            },
            r#"{"at":{"epoch":"e1","seq":42}}"#,
        );
        round_trip(&Anchor::Fresh, r#""fresh""#);
        round_trip(&Anchor::Unknown, r#""unknown""#);
        assert_eq!(
            req::<m::PtyAttach>(
                7,
                &PtyAttachParams {
                    id: 3,
                    anchor: Anchor::At {
                        epoch: "e1".into(),
                        seq: 42
                    }
                }
            ),
            r#"{"id":7,"m":"pty.attach","p":{"id":3,"anchor":{"at":{"epoch":"e1","seq":42}}}}"#
        );
    }

    #[test]
    fn attach_result_is_base64() {
        round_trip(
            &AttachResult {
                mode: ReplayMode::Exact,
                epoch: "e1".into(),
                seq: 45,
                data: b"hi".to_vec(),
            },
            r#"{"mode":"exact","epoch":"e1","seq":45,"data":"aGk="}"#,
        );
        assert_eq!(
            serde_json::to_string(&ReplayMode::Reanchor).unwrap(),
            r#""reanchor""#
        );
    }

    #[test]
    fn pty_open_omits_absent_optionals_and_pairs_env() {
        let p = PtyOpenParams {
            cwd: None,
            command: String::new(),
            args: vec![],
            cols: 80,
            rows: 24,
            env: vec![("A".into(), "1".into())],
            owner: "o".into(),
            label: "tree:x".into(),
            agent_kind: None,
        };
        round_trip(
            &p,
            r#"{"command":"","args":[],"cols":80,"rows":24,"env":[["A","1"]],"owner":"o","label":"tree:x"}"#,
        );
        let with = PtyOpenParams {
            cwd: Some("/srv/web".into()),
            agent_kind: Some(AgentKind::Claude),
            ..p
        };
        round_trip(
            &with,
            r#"{"cwd":"/srv/web","command":"","args":[],"cols":80,"rows":24,"env":[["A","1"]],"owner":"o","label":"tree:x","agentKind":"Claude"}"#,
        );
    }

    #[test]
    fn session_info_writes_every_key() {
        round_trip(
            &SessionInfo {
                id: 3,
                pid: None,
                cwd: Some("/srv/web".into()),
                command: "/bin/zsh".into(),
                owner: "o".into(),
                label: "tree:x".into(),
                agent_kind: None,
                cols: 80,
                rows: 24,
                attached: false,
                alive: true,
                epoch: "e1".into(),
            },
            r#"{"id":3,"pid":null,"cwd":"/srv/web","command":"/bin/zsh","owner":"o","label":"tree:x","agentKind":null,"cols":80,"rows":24,"attached":false,"alive":true,"epoch":"e1"}"#,
        );
    }

    #[test]
    fn small_pty_requests() {
        assert_eq!(
            req::<m::PtyWrite>(
                2,
                &PtyWriteParams {
                    id: 3,
                    data: b"ls\n".to_vec()
                }
            ),
            r#"{"id":2,"m":"pty.write","p":{"id":3,"data":"bHMK"}}"#
        );
        assert_eq!(
            req::<m::PtyResize>(
                3,
                &PtyResizeParams {
                    id: 3,
                    cols: 100,
                    rows: 30
                }
            ),
            r#"{"id":3,"m":"pty.resize","p":{"id":3,"cols":100,"rows":30}}"#
        );
        assert_eq!(
            req::<m::PtySessions>(4, &Empty),
            r#"{"id":4,"m":"pty.sessions","p":{}}"#
        );
    }

    #[test]
    fn exec_shapes() {
        round_trip(
            &ExecParams {
                cwd: "/srv/web".into(),
                argv: vec!["git".into(), "status".into()],
                env: None,
                stdin: Some(b"x".to_vec()),
                timeout_ms: Some(5000),
            },
            r#"{"cwd":"/srv/web","argv":["git","status"],"stdin":"eA==","timeoutMs":5000}"#,
        );
        round_trip(
            &ExecResult {
                code: Some(0),
                signal: None,
                stdout: b"ok".to_vec(),
                stderr: vec![],
                truncated: false,
            },
            r#"{"code":0,"stdout":"b2s=","stderr":"","truncated":false}"#,
        );
        round_trip(
            &ExecResult {
                code: None,
                signal: Some(9),
                ..Default::default()
            },
            r#"{"code":null,"signal":9,"stdout":"","stderr":"","truncated":false}"#,
        );
    }

    #[test]
    fn fs_shapes() {
        round_trip(
            &FsReadParams {
                path: "/srv/web/a".into(),
                offset: Some(-5),
                len: None,
                within: Some("/srv/web".into()),
            },
            r#"{"path":"/srv/web/a","offset":-5,"within":"/srv/web"}"#,
        );
        round_trip(
            &FsReadResult {
                data: b"world".to_vec(),
                size: 11,
                eof: true,
            },
            r#"{"data":"d29ybGQ=","size":11,"eof":true}"#,
        );
        round_trip(
            &FsStat {
                exists: true,
                kind: Some(FsKind::Symlink),
                size: 9,
                mtime_ms: 1_700_000_000_000,
            },
            r#"{"exists":true,"kind":"symlink","size":9,"mtimeMs":1700000000000}"#,
        );
        round_trip(
            &FsWriteParams {
                path: "/a".into(),
                data: vec![],
                mode: Some(0o644),
            },
            r#"{"path":"/a","data":"","mode":420}"#,
        );
    }

    #[test]
    fn hook_shapes() {
        assert_eq!(
            req::<m::HooksAck>(9, &HooksAckParams { up_to: 12 }),
            r#"{"id":9,"m":"hooks.ack","p":{"upTo":12}}"#
        );
        assert_eq!(
            req::<m::HooksSubscribe>(10, &HooksSubscribeParams { after: None }),
            r#"{"id":10,"m":"hooks.subscribe","p":{}}"#
        );
        round_trip(&HooksSubscribeParams { after: Some(4) }, r#"{"after":4}"#);
    }

    #[test]
    fn responses_encode_as_documented() {
        assert_eq!(encode_ok(1, &Empty).unwrap(), r#"{"id":1,"ok":{}}"#);
        assert_eq!(
            encode_err(
                2,
                &WireError::new(ErrorCode::NotFound, "no terminal session 9")
            ),
            r#"{"id":2,"err":{"code":"not_found","msg":"no terminal session 9"}}"#
        );
    }

    #[test]
    fn events_encode_and_decode() {
        let cases = [
            (
                Event::PtyData(PtyData {
                    id: 3,
                    data: b"hi".to_vec(),
                }),
                r#"{"e":"pty.data","p":{"id":3,"data":"aGk="}}"#,
            ),
            (
                Event::PtyExit(PtyExit { id: 3 }),
                r#"{"e":"pty.exit","p":{"id":3}}"#,
            ),
            (Event::Ping, r#"{"e":"ping"}"#),
            (
                Event::Hook(HookEvent {
                    seq: 5,
                    at: 1_700_000_000_000,
                    event: "Stop".into(),
                    env: vec![("A".into(), "b".into())],
                    stdin: b"{}".to_vec(),
                }),
                r#"{"e":"hook","p":{"seq":5,"at":1700000000000,"event":"Stop","env":[["A","b"]],"stdin":"e30="}}"#,
            ),
            (
                Event::HooksDropped(HooksDropped { count: 3 }),
                r#"{"e":"hooks.dropped","p":{"count":3}}"#,
            ),
        ];
        for (event, json) in cases {
            assert_eq!(event.encode(), json);
            match decode_server_frame(json).unwrap() {
                ServerFrame::Event(decoded) => assert_eq!(decoded, event),
                other => panic!("{json} decoded as {other:?}"),
            }
        }
    }

    #[test]
    fn server_frames_decode_leniently() {
        match decode_server_frame(r#"{"e":"future.thing","p":{"x":1}}"#).unwrap() {
            ServerFrame::UnknownEvent(name) => assert_eq!(name, "future.thing"),
            other => panic!("{other:?}"),
        }
        match decode_server_frame(r#"{"id":4,"err":{"code":"shiny_new","msg":"m"}}"#).unwrap() {
            ServerFrame::Response {
                id: 4,
                result: Err(e),
            } => {
                assert_eq!(e.code, ErrorCode::Other("shiny_new".into()))
            }
            other => panic!("{other:?}"),
        }
        match decode_server_frame(r#"{"id":5,"ok":{"seq":7}}"#).unwrap() {
            ServerFrame::Response {
                id: 5,
                result: Ok(raw),
            } => {
                let r: HookPushResult = serde_json::from_str(raw.get()).unwrap();
                assert_eq!(r.seq, 7);
            }
            other => panic!("{other:?}"),
        }
        // `Empty` accepts whatever a method with no result sends back.
        assert_eq!(serde_json::from_str::<Empty>("null").unwrap(), Empty);
        assert!(decode_server_frame(r#"{"nothing":true}"#).is_err());
    }

    #[test]
    fn version_error_may_name_the_servers_protocol() {
        let e: WireError =
            serde_json::from_str(r#"{"code":"version","msg":"speaks 2","protocol":2}"#).unwrap();
        assert_eq!((e.code, e.protocol), (ErrorCode::Version, Some(2)));
    }

    #[test]
    fn a_request_without_params_reads_as_empty() {
        let r = decode_request(r#"{"id":1,"m":"hooks.subscribe"}"#).unwrap();
        assert_eq!(r.params::<HooksSubscribeParams>().unwrap().after, None);
        let bad = decode_request(r#"{"id":2,"m":"pty.write","p":{"id":"x"}}"#).unwrap();
        assert_eq!(
            bad.params::<PtyWriteParams>().unwrap_err().code,
            ErrorCode::BadRequest
        );
    }
}
