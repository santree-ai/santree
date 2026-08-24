//! The `santree-review` MCP server: newline-delimited JSON-RPC 2.0 over stdio.
//!
//! An AI-review session launches with `--mcp-config` pointing at this binary in
//! `mcp` mode, scoped by argv to exactly one pull request. Its tools are the only
//! way that session can record anything: a review brief and draft review comments,
//! written into santree's own SQLite. Nothing here can reach GitHub — there is no
//! token, no network call, and no `git`. A draft becomes a real comment only when
//! the user publishes it from the app, under their own name.
//!
//! Hand-rolled rather than `rmcp`: the protocol surface we need is five tools and
//! six methods, and this crate's whole point is to stay a small, dependency-thin
//! binary that can never disrupt a Claude session.
//!
//! **stdout is the transport.** Only protocol messages go there, one JSON object
//! per line; anything worth saying goes to stderr, where `claude --debug` shows it.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use santree_core::domain::AgentKind;
use serde_json::{json, Map, Value};

/// The server name Claude sees, and the prefix of its permission rules
/// (`mcp__santree-review`). Mirrored by `hooks.rs`'s `MCP_SERVER_NAME`.
const SERVER_NAME: &str = "santree-review";

/// Protocol revisions we know how to speak. An `initialize` naming one of these is
/// echoed back; anything else is answered with [`LATEST`], which is what the spec
/// asks a server to do when it doesn't support the client's version.
const SUPPORTED: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const LATEST: &str = "2025-06-18";

/// Which pull request this server may write to. Fixed at launch by santree, never
/// by the model: every statement is scoped to it, so "add a comment to some other
/// PR" is not expressible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpScope {
    pub pr_repo: String,
    pub number: u32,
    pub head_sha: String,
    /// The diff index santree wrote at launch — what makes a line "real".
    pub diff_index: PathBuf,
    pub agent_kind: AgentKind,
}

impl McpScope {
    /// Validate the argv the app wrote. `None` on anything malformed: the app
    /// controls these, so a bad one is a santree bug, not a model input, and
    /// starting a half-scoped server would be worse than not starting.
    pub fn new(pr_repo: String, number: String, head_sha: String, diff: String) -> Option<Self> {
        let (owner, name) = pr_repo.split_once('/')?;
        if owner.is_empty() || name.is_empty() || name.contains('/') {
            return None;
        }
        let number: u32 = number.parse().ok().filter(|n| *n > 0)?;
        let ok_head = (7..=64).contains(&head_sha.len())
            && head_sha.bytes().all(|b| b.is_ascii_hexdigit())
            && head_sha == head_sha.to_ascii_lowercase();
        if !ok_head || diff.is_empty() {
            return None;
        }
        Some(Self {
            pr_repo,
            number,
            head_sha,
            diff_index: PathBuf::from(diff),
            agent_kind: AgentKind::Claude,
        })
    }

    pub fn with_agent_kind(mut self, value: &str) -> Option<Self> {
        let kind = value.parse().ok()?;
        if !matches!(kind, AgentKind::Claude | AgentKind::Codex) {
            return None;
        }
        self.agent_kind = kind;
        Some(self)
    }
}

/// One text block back to the model.
pub(crate) struct ToolReply {
    pub text: String,
}

/// Why a tool call didn't do what was asked.
///
/// [`Self::InvalidParams`] and [`Self::Failed`] come back as a *result* with
/// `isError: true`, not as a JSON-RPC error — that's what the spec reserves for
/// protocol faults. The difference matters: a result reaches the model, which can
/// read the reason and try again, and every message here is written for exactly
/// that (what was wrong, and what would work).
#[derive(Debug)]
pub(crate) enum ToolError {
    UnknownTool,
    InvalidParams(String),
    Failed(String),
}

/// What [`Session`] dispatches `tools/call` to. A trait so the framing can be
/// tested without a database.
pub(crate) trait ToolHost {
    fn list(&self) -> Vec<Value>;
    fn call(&mut self, name: &str, args: &Value) -> Result<ToolReply, ToolError>;
}

/// A live MCP conversation: parses one line, produces at most one reply.
pub(crate) struct Session<H: ToolHost> {
    host: H,
}

impl<H: ToolHost> Session<H> {
    pub fn new(host: H) -> Self {
        Self { host }
    }

    /// `None` = say nothing (a notification, which the spec forbids answering).
    pub fn handle_line(&mut self, line: &str) -> Option<Value> {
        if line.trim().is_empty() {
            return None;
        }
        let msg: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => return Some(error(Value::Null, -32700, &format!("parse error: {e}"))),
        };
        let Some(obj) = msg.as_object() else {
            // A batch (array) or a bare scalar. Claude Code never batches, and
            // answering half a batch is worse than refusing it.
            return Some(error(
                Value::Null,
                -32600,
                "expected a single JSON-RPC object",
            ));
        };
        // No `id` ⇒ a notification: `notifications/initialized`, `cancelled`, and
        // friends. Observed and dropped.
        let id = obj.get("id")?.clone();
        let method = obj
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        Some(self.dispatch(id, method, &params))
    }

    fn dispatch(&mut self, id: Value, method: &str, params: &Value) -> Value {
        match method {
            "initialize" => {
                let asked = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(LATEST);
                let version = if SUPPORTED.contains(&asked) {
                    asked
                } else {
                    LATEST
                };
                result(
                    id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": { "tools": { "listChanged": false } },
                        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                        "instructions": "santree's review tools. Everything written through them stays \
                                         in santree and is invisible on GitHub until the human publishes it.",
                    }),
                )
            }
            "ping" => result(id, json!({})),
            "tools/list" => result(id, json!({ "tools": self.host.list() })),
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                match self.host.call(name, &args) {
                    Ok(reply) => result(id, content(&reply.text, false)),
                    Err(ToolError::UnknownTool) => {
                        error(id, -32602, &format!("unknown tool '{name}'"))
                    }
                    Err(ToolError::InvalidParams(m) | ToolError::Failed(m)) => {
                        result(id, content(&m, true))
                    }
                }
            }
            other => error(id, -32601, &format!("method '{other}' is not supported")),
        }
    }
}

fn result(id: Value, value: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": value })
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn content(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// Read `params.arguments` as an object, so a tool never has to re-check.
pub(crate) fn args_object(args: &Value) -> Map<String, Value> {
    args.as_object().cloned().unwrap_or_default()
}

/// Serve until Claude closes stdin, then return (the caller exits 0).
pub(crate) fn serve(db_path: &str, scope: McpScope) {
    let Ok(rt) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        eprintln!("santree-review: couldn't start a runtime");
        return;
    };
    let mut session = Session::new(crate::review_tools::ReviewTools::new(
        rt,
        db_path.to_string(),
        scope,
    ));

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Some(reply) = session.handle_line(&line) else {
            continue;
        };
        // `to_string` escapes any newline inside a string, so one message really is
        // one line — the framing the transport depends on.
        if writeln!(stdout, "{reply}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            break; // the client went away
        }
    }
}

/// Where a diff index that can't be read is reported from — shared by the tools so
/// the wording stays one thing.
pub(crate) fn read_diff_index(
    path: &Path,
) -> Result<santree_core::diff_index::DiffIndex, ToolError> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        ToolError::Failed(format!(
            "santree's diff index isn't readable at {}: {e}. Tell the human — the review session \
             needs relaunching from santree.",
            path.display()
        ))
    })?;
    serde_json::from_str(&raw).map_err(|e| {
        ToolError::Failed(format!(
            "santree's diff index at {} isn't valid: {e}",
            path.display()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host that records what it was asked and answers predictably.
    struct Stub {
        last: Option<(String, Value)>,
        answer: Result<String, ToolError>,
    }

    impl Stub {
        fn ok() -> Self {
            Self {
                last: None,
                answer: Ok("done".into()),
            }
        }
    }

    impl ToolHost for Stub {
        fn list(&self) -> Vec<Value> {
            vec![json!({ "name": "add_review_comment" })]
        }
        fn call(&mut self, name: &str, args: &Value) -> Result<ToolReply, ToolError> {
            self.last = Some((name.to_string(), args.clone()));
            match &self.answer {
                Ok(text) => Ok(ToolReply { text: text.clone() }),
                Err(ToolError::UnknownTool) => Err(ToolError::UnknownTool),
                Err(ToolError::InvalidParams(m)) => Err(ToolError::InvalidParams(m.clone())),
                Err(ToolError::Failed(m)) => Err(ToolError::Failed(m.clone())),
            }
        }
    }

    fn line(session: &mut Session<Stub>, s: &str) -> Option<Value> {
        session.handle_line(s)
    }

    #[test]
    fn initialize_echoes_a_version_it_speaks() {
        let mut s = Session::new(Stub::ok());
        let out = line(
            &mut s,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#,
        )
        .unwrap();
        assert_eq!(out["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(out["result"]["serverInfo"]["name"], SERVER_NAME);
    }

    #[test]
    fn initialize_falls_back_for_a_version_it_does_not_speak() {
        let mut s = Session::new(Stub::ok());
        let out = line(
            &mut s,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#,
        )
        .unwrap();
        assert_eq!(out["result"]["protocolVersion"], LATEST);
    }

    #[test]
    fn a_notification_is_never_answered() {
        let mut s = Session::new(Stub::ok());
        assert!(line(
            &mut s,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
        )
        .is_none());
        assert!(line(&mut s, "").is_none());
    }

    #[test]
    fn ping_and_tools_list_answer() {
        let mut s = Session::new(Stub::ok());
        let pong = line(&mut s, r#"{"jsonrpc":"2.0","id":"p","method":"ping"}"#).unwrap();
        assert_eq!(pong["id"], "p");
        assert_eq!(pong["result"], json!({}));
        let list = line(&mut s, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).unwrap();
        assert_eq!(list["result"]["tools"][0]["name"], "add_review_comment");
    }

    #[test]
    fn a_tool_call_carries_its_arguments_through() {
        let mut s = Session::new(Stub::ok());
        let out = line(
            &mut s,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_review_comment","arguments":{"line":4}}}"#,
        )
        .unwrap();
        assert_eq!(out["result"]["isError"], false);
        assert_eq!(out["result"]["content"][0]["text"], "done");
    }

    #[test]
    fn a_rejected_call_is_a_result_the_model_can_read_not_a_protocol_error() {
        // This is the whole retry story: an error *result* reaches the model with
        // the reason, where a JSON-RPC error is a transport fault it can't act on.
        let mut s = Session::new(Stub {
            last: None,
            answer: Err(ToolError::InvalidParams("line 9 isn't in the diff".into())),
        });
        let out = line(
            &mut s,
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"add_review_comment"}}"#,
        )
        .unwrap();
        assert!(out.get("error").is_none(), "{out}");
        assert_eq!(out["result"]["isError"], true);
        assert_eq!(
            out["result"]["content"][0]["text"],
            "line 9 isn't in the diff"
        );
    }

    #[test]
    fn an_unknown_tool_is_a_protocol_error() {
        let mut s = Session::new(Stub {
            last: None,
            answer: Err(ToolError::UnknownTool),
        });
        let out = line(
            &mut s,
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"nope"}}"#,
        )
        .unwrap();
        assert_eq!(out["error"]["code"], -32602);
    }

    #[test]
    fn unknown_methods_bad_json_and_batches_each_get_their_own_code() {
        let mut s = Session::new(Stub::ok());
        assert_eq!(
            line(
                &mut s,
                r#"{"jsonrpc":"2.0","id":6,"method":"resources/list"}"#
            )
            .unwrap()["error"]["code"],
            -32601
        );
        let parse = line(&mut s, "not json {{{").unwrap();
        assert_eq!(parse["error"]["code"], -32700);
        assert_eq!(parse["id"], Value::Null);
        assert_eq!(line(&mut s, "[1,2]").unwrap()["error"]["code"], -32600);
    }

    #[test]
    fn one_message_is_always_one_line() {
        // The transport is newline-delimited, so a body with a newline in it must
        // not split the reply in two.
        let mut s = Session::new(Stub {
            last: None,
            answer: Ok("first\nsecond".into()),
        });
        let out = line(
            &mut s,
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"x"}}"#,
        )
        .unwrap();
        assert!(!out.to_string().contains('\n'));
    }

    #[test]
    fn scope_rejects_argv_it_cannot_trust() {
        let ok = McpScope::new(
            "acme/web".into(),
            "42".into(),
            "abc1234".into(),
            "/d.json".into(),
        );
        assert!(ok.is_some());
        for (pr, n, head) in [
            ("acmeweb", "42", "abc1234"),  // no slash
            ("acme/", "42", "abc1234"),    // empty name
            ("a/b/c", "42", "abc1234"),    // too many parts
            ("acme/web", "0", "abc1234"),  // PRs start at 1
            ("acme/web", "x", "abc1234"),  // not a number
            ("acme/web", "42", "abc"),     // too short to be a sha
            ("acme/web", "42", "ABC1234"), // not lowercase
            ("acme/web", "42", "zzzzzzz"), // not hex
        ] {
            assert!(
                McpScope::new(pr.into(), n.into(), head.into(), "/d.json".into()).is_none(),
                "{pr} {n} {head} should be refused"
            );
        }
        assert!(McpScope::new(
            "acme/web".into(),
            "42".into(),
            "abc1234".into(),
            String::new()
        )
        .is_none());
    }
}
