//! JSON-RPC over MCP's Streamable HTTP transport — `initialize` and `tools/call`
//! against Linear's MCP server, which is all santree needs of it.
//!
//! Hand-rolled rather than an MCP SDK: two methods against one server, and every
//! result is decoded into santree's own types anyway. A tool's output is JSON
//! inside text content with no output schema, so a decode failure names the
//! tool — it is the first sign Linear reshaped it.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use super::auth;
use crate::db::Db;
use crate::gql;

const PROTOCOL_VERSION: &str = "2025-06-18";
const SERVICE: &str = "Linear MCP";

/// Whether a tool call may be sent twice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Effect {
    /// A read: resent once on a gateway failure, as a GraphQL query is.
    Read,
    /// A write: never resent after a response that could mean it was applied —
    /// a 502 doesn't say, and the server annotates its write tools
    /// non-idempotent. Only a refusal (a 401, a dropped-session 404) is sent again.
    Write,
}

/// Each org's MCP session, once initialized: `None` inside means the server is
/// stateless (Linear's is, measured), `Some(id)` that it handed one out. An org
/// with no entry is initialized before its next call.
static SESSIONS: LazyLock<Mutex<HashMap<String, Option<String>>>> = LazyLock::new(Default::default);

fn known_session(slug: &str) -> Option<Option<String>> {
    SESSIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(slug)
        .cloned()
}

fn remember_session(slug: &str, session: Option<String>) {
    SESSIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(slug.to_string(), session);
}

/// Call `tool` as the MCP org `slug` and decode its output into `T`.
pub(crate) async fn call_tool<T: DeserializeOwned>(
    db: &Db,
    slug: &str,
    tool: &str,
    args: Value,
    effect: Effect,
) -> Result<T> {
    decode(tool, &call_tool_text(db, slug, tool, args, effect).await?)
}

/// Call a write tool as the MCP org `slug`, succeeding when the tool does. Its
/// output is not decoded: what the write tools answer with was never measured,
/// and a write that landed must not report failure because its confirmation
/// didn't parse. A tool that reports an error, or answers with nothing, fails.
pub(crate) async fn call_write(db: &Db, slug: &str, tool: &str, args: Value) -> Result<()> {
    let answer = call_tool_text(db, slug, tool, args, Effect::Write).await?;
    confirmed(tool, &answer)
}

/// Whether a write tool's answer confirms anything. An empty one doesn't, and
/// reading it as done would clear a comment's draft for a comment that may not
/// exist.
fn confirmed(tool: &str, answer: &str) -> Result<()> {
    if answer.trim().is_empty() {
        bail!(
            "{SERVICE} {tool} answered with nothing, so santree can't tell whether the change was made"
        );
    }
    Ok(())
}

/// A tool call's text output. A 401 re-mints the token once and retries, as
/// `linear::Session::query` does — safe even for a write, since a 401 is a
/// refusal, not a request half-applied.
async fn call_tool_text(
    db: &Db,
    slug: &str,
    tool: &str,
    args: Value,
    effect: Effect,
) -> Result<String> {
    let spent = auth::valid_token(db, slug).await?;
    match call_with_token_text(Some(slug), &spent, tool, args.clone(), effect).await {
        Err(e) if gql::status_of(&e) == Some(reqwest::StatusCode::UNAUTHORIZED) => {
            log::warn!(
                "Linear's MCP server rejected the stored access token for org {slug} before its \
                 recorded expiry — re-minting it and retrying once"
            );
            let fresh = auth::force_refresh(db, slug, &spent).await?;
            call_with_token_text(Some(slug), &fresh, tool, args, effect).await
        }
        other => other,
    }
}

/// [`call_tool`] with a token already in hand and no refresh: the connect flow's
/// first call, made before there is an org (`slug: None`, so no session is kept).
pub(crate) async fn call_with_token<T: DeserializeOwned>(
    slug: Option<&str>,
    token: &str,
    tool: &str,
    args: Value,
    effect: Effect,
) -> Result<T> {
    decode(
        tool,
        &call_with_token_text(slug, token, tool, args, effect).await?,
    )
}

async fn call_with_token_text(
    slug: Option<&str>,
    token: &str,
    tool: &str,
    args: Value,
    effect: Effect,
) -> Result<String> {
    let call = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": tool, "arguments": args },
    });
    let session = match slug.and_then(known_session) {
        Some(session) => session,
        None => start_session(slug, token).await?,
    };
    let reply = match post(token, session.as_deref(), &call, effect).await {
        // The spec's answer for a session the server dropped. The call wasn't
        // processed, so a new session and a second send are safe even for a write.
        Err(e)
            if session.is_some() && gql::status_of(&e) == Some(reqwest::StatusCode::NOT_FOUND) =>
        {
            let session = start_session(slug, token).await?;
            post(token, session.as_deref(), &call, effect).await?
        }
        other => other?,
    };
    tool_text(tool, rpc_result(&reply, 1)?)
}

/// `initialize`, then the `initialized` notification. Returns the session the
/// server handed out, if any, and remembers it for `slug`.
async fn start_session(slug: Option<&str>, token: &str) -> Result<Option<String>> {
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "santree", "version": env!("CARGO_PKG_VERSION") },
        },
    });
    let reply = post(token, None, &initialize, Effect::Read).await?;
    rpc_result(&reply, 0)?;
    let session = reply.session;
    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    post(token, session.as_deref(), &initialized, Effect::Read).await?;
    if let Some(slug) = slug {
        remember_session(slug, session.clone());
    }
    Ok(session)
}

struct Reply {
    session: Option<String>,
    event_stream: bool,
    body: String,
}

async fn post(
    token: &str,
    session: Option<&str>,
    message: &Value,
    effect: Effect,
) -> Result<Reply> {
    let mut req = gql::credential_client()
        .post(auth::RESOURCE)
        .bearer_auth(token)
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/event-stream",
        )
        .header("mcp-protocol-version", PROTOCOL_VERSION)
        .json(message);
    if let Some(session) = session {
        req = req.header("mcp-session-id", session);
    }
    let res = match effect {
        Effect::Read => gql::send_read(req, SERVICE).await?,
        Effect::Write => gql::send(req, SERVICE).await?,
    };
    let status = res.status();
    let header = |name| {
        res.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let session = header("mcp-session-id");
    let event_stream = header(reqwest::header::CONTENT_TYPE.as_str())
        .is_some_and(|ct| ct.starts_with("text/event-stream"));
    let body = res
        .text()
        .await
        .with_context(|| format!("reading the {SERVICE} response"))?;
    if !status.is_success() {
        return Err(gql::http_error(SERVICE, status, &body));
    }
    Ok(Reply {
        session,
        event_stream,
        body,
    })
}

/// The `result` of the JSON-RPC response numbered `id` — from a plain JSON body,
/// or from an SSE stream, which may carry other messages before it.
fn rpc_result(reply: &Reply, id: u64) -> Result<Value> {
    let messages = if reply.event_stream {
        sse_messages(&reply.body)
    } else {
        vec![serde_json::from_str(&reply.body)
            .with_context(|| format!("decoding the {SERVICE} response"))?]
    };
    let response = messages
        .into_iter()
        .find(|m| m.get("id").and_then(Value::as_u64) == Some(id))
        .ok_or_else(|| anyhow!("{SERVICE} sent no response to request {id}"))?;
    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        bail!("{SERVICE}: {message}");
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| anyhow!("{SERVICE} response {id} has no result"))
}

/// The JSON messages in an SSE body: an event's `data:` lines joined by newlines,
/// events split on a blank line. Data that isn't JSON (a keep-alive) is skipped.
fn sse_messages(body: &str) -> Vec<Value> {
    let mut messages = Vec::new();
    let mut data = String::new();
    for line in body.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Ok(message) = serde_json::from_str(&data) {
                messages.push(message);
            }
            data.clear();
        } else if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    messages
}

/// A tool that ran and reported failure in its own words (`isError`). Typed so a
/// caller can tell "no such issue" apart from a transport failure without
/// matching on the whole error chain.
#[derive(Debug)]
pub(crate) struct ToolError {
    pub(crate) tool: String,
    pub(crate) message: String,
}
impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{SERVICE} {}: {}", self.tool, self.message)
    }
}
impl std::error::Error for ToolError {}

/// The tool's own failure a failed call carried, if that is why it failed.
pub(crate) fn tool_error(err: &anyhow::Error) -> Option<&ToolError> {
    err.downcast_ref::<ToolError>()
}

#[derive(Deserialize)]
struct ToolResult {
    #[serde(default)]
    content: Vec<Content>,
    #[serde(default, rename = "isError")]
    is_error: bool,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Content {
    Text {
        text: String,
    },
    #[serde(other)]
    Other,
}

/// A tool's text output. A tool that reports an error fails with its own words.
fn tool_text(tool: &str, result: Value) -> Result<String> {
    let result: ToolResult = serde_json::from_value(result)
        .with_context(|| format!("decoding the {SERVICE} {tool} result"))?;
    let text: String = result
        .content
        .into_iter()
        .filter_map(|content| match content {
            Content::Text { text } => Some(text),
            Content::Other => None,
        })
        .collect();
    if result.is_error {
        return Err(anyhow::Error::new(ToolError {
            tool: tool.to_string(),
            message: text.trim().to_string(),
        }));
    }
    Ok(text)
}

/// A read tool's text output, decoded as JSON into `T`.
fn decode<T: DeserializeOwned>(tool: &str, text: &str) -> Result<T> {
    serde_json::from_str(text).with_context(|| {
        format!("decoding the {SERVICE} {tool} output — Linear may have changed its shape")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(event_stream: bool, body: &str) -> Reply {
        Reply {
            session: None,
            event_stream,
            body: body.to_string(),
        }
    }

    #[test]
    fn a_plain_json_response_yields_its_result() {
        let result = rpc_result(
            &reply(false, r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#),
            1,
        )
        .unwrap();
        assert_eq!(result, json!({ "ok": true }));
    }

    #[test]
    fn an_event_stream_is_searched_for_the_matching_response() {
        let body = "event: message\r\n\
                    data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\
                    \r\n\
                    : keep-alive\r\n\
                    \r\n\
                    event: message\r\n\
                    data: {\"jsonrpc\":\"2.0\",\r\n\
                    data: \"id\":1,\"result\":{\"n\":2}}\r\n\
                    \r\n";
        assert_eq!(
            rpc_result(&reply(true, body), 1).unwrap(),
            json!({ "n": 2 })
        );
        assert!(rpc_result(&reply(true, body), 7).is_err());
    }

    #[test]
    fn a_json_rpc_error_is_a_failure_with_its_message() {
        let err = rpc_result(
            &reply(
                false,
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Unknown tool"}}"#,
            ),
            1,
        )
        .unwrap_err();
        assert!(err.to_string().contains("Unknown tool"), "{err}");
    }

    #[test]
    fn tool_output_is_the_json_in_its_text_content() {
        #[derive(Deserialize, Debug, PartialEq)]
        struct Workspace {
            name: String,
            url: String,
        }
        // As measured: one text item carrying a JSON document. Content of any
        // other type is ignored rather than failing the decode.
        let result = json!({
            "content": [
                { "type": "text", "text": "{\"name\":\"Acme\",\"url\":\"https://linear.app/acme\"}" },
                { "type": "image", "data": "", "mimeType": "image/png" },
            ]
        });
        let text = tool_text("get_workspace", result).unwrap();
        assert_eq!(
            decode::<Workspace>("get_workspace", &text).unwrap(),
            Workspace {
                name: "Acme".into(),
                url: "https://linear.app/acme".into(),
            }
        );
    }

    #[test]
    fn a_tool_error_fails_with_the_tools_words_and_a_reshape_names_the_tool() {
        let err = tool_text(
            "get_issue",
            json!({ "content": [{ "type": "text", "text": "Issue not found" }], "isError": true }),
        )
        .unwrap_err();
        assert_eq!(err.to_string(), "Linear MCP get_issue: Issue not found");

        let err = decode::<Vec<String>>("list_teams", "{\"teams\":[]}").unwrap_err();
        assert!(err.to_string().contains("list_teams"), "{err}");
    }

    #[test]
    fn an_empty_write_answer_confirms_nothing() {
        assert!(confirmed("save_comment", "Comment created.").is_ok());
        assert!(confirmed("save_comment", "  \n").is_err());
        assert!(confirmed("save_issue", "").is_err());
    }

    /// A write's confirmation is whatever the tool says: prose is as good as JSON,
    /// and only the tool's own error flag makes it a failure.
    #[test]
    fn a_write_succeeds_on_any_text_and_fails_only_on_the_tools_error() {
        assert_eq!(
            tool_text(
                "save_comment",
                json!({ "content": [{ "type": "text", "text": "Comment created." }] }),
            )
            .unwrap(),
            "Comment created."
        );
        assert!(tool_text(
            "save_issue",
            json!({ "content": [{ "type": "text", "text": "State not found" }], "isError": true }),
        )
        .is_err());
    }
}
