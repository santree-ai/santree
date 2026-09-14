//! Shared OAuth 2.0 + PKCE machinery used by both the Linear and Jira
//! integrations. Handles the localhost callback listener, PKCE challenge
//! generation, keychain storage (one JSON blob per org), per-org refresh
//! locks, and the token-endpoint POST. Provider-specific logic (which URL,
//! which client id, what to do after the code exchange) stays in the
//! provider modules.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::gql;

/// The port both providers share for the OAuth callback.
pub const OAUTH_PORT: u16 = 8420;

/// How long the whole browser round-trip gets before the connect is abandoned.
pub const OAUTH_TIMEOUT: Duration = Duration::from_secs(120);

/// How long an accepted connection gets to send its request line.
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(5);

/// How far before expiry a token is considered unusable — refresh before it
/// expires mid-flight.
pub const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

/// Keychain service name (the app's bundle id).
pub const KEYCHAIN_SERVICE: &str = "com.santree.desktop";

// ── Keychain token storage ───────────────────────────────────────────────

/// One keychain entry per org, holding *both* tokens as a single JSON blob:
/// the refresh token is rotated on every use, so the pair has to be written
/// atomically — and one entry means one keychain prompt instead of two.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Tokens {
    pub access: String,
    pub refresh: String,
}

/// Build a keychain entry for a provider + org id (e.g. `"linear:acme"` or
/// `"jira:abc123"`).
pub fn keychain_entry(provider: &str, org_id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("{provider}:{org_id}")).map_err(keychain_err)
}

pub fn keychain_err(e: keyring::Error) -> anyhow::Error {
    anyhow::Error::new(e)
        .context("the OS keychain is unavailable (santree keeps OAuth tokens there)")
}

pub fn read_tokens_blocking(provider: &str, org_id: &str) -> Result<Option<Tokens>> {
    match keychain_entry(provider, org_id)?.get_password() {
        Ok(blob) => decode_tokens(&blob).map(Some),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keychain_err(e)),
    }
}

pub fn write_tokens_blocking(provider: &str, org_id: &str, tokens: &Tokens) -> Result<()> {
    keychain_entry(provider, org_id)?
        .set_password(&encode_tokens(tokens)?)
        .map_err(keychain_err)
}

pub fn encode_tokens(tokens: &Tokens) -> Result<String> {
    serde_json::to_string(tokens).context("encoding the OAuth credential")
}

pub fn decode_tokens(blob: &str) -> Result<Tokens> {
    serde_json::from_str(blob)
        .context("the stored OAuth credential isn't in the expected format — reconnect the org")
}

/// The org's stored token pair, or `None` when the keychain has no entry.
pub async fn load_tokens(provider: &str, org_id: &str) -> Result<Option<Tokens>> {
    let provider = provider.to_string();
    let org_id = org_id.to_string();
    tokio::task::spawn_blocking(move || read_tokens_blocking(&provider, &org_id))
        .await
        .context("keychain read")?
}

pub async fn save_tokens(provider: &str, org_id: &str, tokens: Tokens) -> Result<()> {
    let provider = provider.to_string();
    let org_id = org_id.to_string();
    tokio::task::spawn_blocking(move || write_tokens_blocking(&provider, &org_id, &tokens))
        .await
        .context("keychain write")?
}

/// Remove the org's stored token pair. A missing entry is already the goal.
pub async fn delete_tokens(provider: &str, org_id: &str) -> Result<()> {
    let provider = provider.to_string();
    let org_id = org_id.to_string();
    tokio::task::spawn_blocking(move || {
        match keychain_entry(&provider, &org_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_err(e)),
        }
    })
    .await
    .context("keychain delete")?
}

// ── Token endpoint ───────────────────────────────────────────────────────

/// The response from an OAuth token endpoint (code exchange or refresh).
#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    #[serde(default)]
    pub scope: Option<GrantedScope>,
}

/// A `scope` field that may arrive as a JSON list or a delimited string.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum GrantedScope {
    List(Vec<String>),
    Text(String),
}

impl GrantedScope {
    pub fn as_csv(&self) -> String {
        match self {
            Self::List(items) => items.join(","),
            Self::Text(s) => s
                .split([',', ' '])
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(","),
        }
    }
}

/// A token endpoint's refusal. Typed so a caller can tell a dead grant
/// (`invalid_grant`: the user has to reconnect) from a transient failure without
/// matching on message text. Its `Display` keeps the endpoint's body, which is
/// where the reason is.
#[derive(Debug)]
pub struct TokenEndpointError {
    /// The OAuth `error` code from the body (RFC 6749 §5.2), when it had one.
    pub code: Option<String>,
    message: String,
}
impl std::fmt::Display for TokenEndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for TokenEndpointError {}

/// The OAuth error code a failed [`token_request`] carried, if it had one.
pub fn token_error_code(err: &anyhow::Error) -> Option<&str> {
    err.downcast_ref::<TokenEndpointError>()?.code.as_deref()
}

/// POST an OAuth token endpoint and decode the token pair. On failure the
/// response body is preserved — `invalid_grant` reads as the same bare 400
/// as a transient error without it.
pub async fn token_request(url: &str, form: &[(&str, &str)], what: &str) -> Result<TokenResponse> {
    let res = gql::credential_client()
        .post(url)
        .form(form)
        .send()
        .await
        .with_context(|| format!("{what} request"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let code = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|json| json.get("error")?.as_str().map(str::to_owned));
        let snippet: String = body.chars().take(300).collect();
        return Err(anyhow::Error::new(TokenEndpointError {
            code,
            message: format!("{what} failed ({status}): {snippet}"),
        }));
    }
    res.json()
        .await
        .with_context(|| format!("decoding the {what} response"))
}

// ── Per-org refresh locks ────────────────────────────────────────────────

/// Per-org locks serializing token refresh. Keyed by `"{provider}:{org_id}"`.
static REFRESH_LOCKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(Default::default);

pub fn refresh_lock(provider: &str, org_id: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    REFRESH_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(format!("{provider}:{org_id}"))
        .or_default()
        .clone()
}

/// Whether a token expiring at `expires_at` is still usable at `now`.
pub fn usable_at(expires_at: i64, now: i64) -> bool {
    now < expires_at - REFRESH_SKEW_MS
}

// ── PKCE helpers ─────────────────────────────────────────────────────────

pub fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub fn pkce_challenge(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

// ── Localhost callback listener ──────────────────────────────────────────

/// Bind the OAuth callback port and wait for the authorization code.
pub fn wait_for_code(expected_state: &str, provider_name: &str) -> Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", OAUTH_PORT)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            anyhow!(
                "Port {OAUTH_PORT} is already in use — another {provider_name} sign-in may be in progress. Close it and try again."
            )
        } else {
            anyhow::Error::new(e).context("binding oauth port")
        }
    })?;
    accept_code(&listener, expected_state, Instant::now() + OAUTH_TIMEOUT)
}

/// Serve the OAuth callback until the browser delivers a `code` for our `state`,
/// the user declines, or `deadline` passes.
pub fn accept_code(
    listener: &TcpListener,
    expected_state: &str,
    deadline: Instant,
) -> Result<String> {
    listener.set_nonblocking(true)?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<String>>();

    loop {
        if Instant::now() > deadline {
            bail!("timed out waiting for authorization");
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let tx = tx.clone();
                let state = expected_state.to_string();
                std::thread::spawn(move || {
                    if let Some(outcome) = serve_callback(stream, &state, deadline) {
                        let _ = tx.send(outcome);
                    }
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e.into()),
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(outcome) => return outcome,
            Err(_) => continue,
        }
    }
}

fn serve_callback(
    mut stream: std::net::TcpStream,
    expected_state: &str,
    deadline: Instant,
) -> Option<Result<String>> {
    let req = match read_request(&mut stream, deadline) {
        Ok(req) => req,
        Err(e) => {
            log::debug!("ignoring an unreadable oauth callback connection: {e}");
            return None;
        }
    };
    let path = req
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .unwrap_or("");
    let (code, returned_state, error) = parse_callback(path);
    if code.is_none() && error.is_none() {
        return None;
    }
    let state_matches = returned_state.as_deref() == Some(expected_state);
    let ok = code.is_some() && state_matches;

    let html = if ok {
        "<html><body><h2>Authentication successful!</h2><p>You can close this tab.</p></body></html>"
    } else {
        "<html><body><h2>Authentication failed.</h2></body></html>"
    };
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
            html.len(),
            html
        )
        .as_bytes(),
    );

    if ok {
        return Some(Ok(code.unwrap()));
    }
    error
        .filter(|_| state_matches)
        .map(|error| Err(anyhow!("authorization failed: {error}")))
}

fn read_request(stream: &mut std::net::TcpStream, deadline: Instant) -> std::io::Result<String> {
    stream.set_nonblocking(false)?;
    let budget = deadline
        .saturating_duration_since(Instant::now())
        .min(CALLBACK_READ_TIMEOUT)
        .max(Duration::from_millis(50));
    stream.set_read_timeout(Some(budget))?;

    let mut buf = [0u8; 2048];
    let mut len = 0;
    while len < buf.len() {
        match stream.read(&mut buf[len..]) {
            Ok(0) => break,
            Ok(n) => {
                len += n;
                if buf[..len].contains(&b'\n') {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    if len == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "the callback connection sent nothing",
        ));
    }
    Ok(String::from_utf8_lossy(&buf[..len]).into_owned())
}

pub fn parse_callback(path: &str) -> (Option<String>, Option<String>, Option<String>) {
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    (code, state, error)
}

pub fn open_browser(url: &str) {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(cmd).arg(url).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_blob_round_trips() {
        let tokens = Tokens {
            access: "oauth_ac.ce-ss_1/2+3".into(),
            refresh: "oauth_re\"fresh\"".into(),
        };
        let blob = encode_tokens(&tokens).unwrap();
        assert_eq!(decode_tokens(&blob).unwrap(), tokens);
    }

    #[test]
    fn token_blob_rejects_garbage() {
        assert!(decode_tokens("not json").is_err());
        assert!(decode_tokens(r#"{"access":"a"}"#).is_err());
    }

    #[test]
    fn a_token_is_reused_until_the_refresh_skew() {
        let now = 1_700_000_000_000;
        let expires = |mins: i64| now + mins * 60 * 1000;
        assert_eq!(REFRESH_SKEW_MS, 5 * 60 * 1000);

        assert!(usable_at(expires(6), now));
        assert!(!usable_at(expires(5), now));
        assert!(!usable_at(expires(1), now));
        assert!(!usable_at(expires(-1), now));
    }

    /// A dead grant has to be recognisable as one — the MCP connection turns it
    /// into "reconnect" instead of a raw 400 — and the reason has to survive.
    #[tokio::test]
    async fn a_refused_grant_keeps_its_oauth_error_code() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = stream.read(&mut [0u8; 4096]);
            let body = r#"{"error":"invalid_grant","error_description":"Invalid refresh token"}"#;
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            );
        });

        let err = token_request(&url, &[("grant_type", "refresh_token")], "test refresh")
            .await
            .err()
            .expect("a 400 is a failure");
        assert_eq!(token_error_code(&err), Some("invalid_grant"));
        assert!(err.to_string().contains("Invalid refresh token"), "{err}");
        // Callers add context on the way up; the code must still be readable.
        assert_eq!(
            token_error_code(&err.context("while refreshing")),
            Some("invalid_grant")
        );
        assert_eq!(token_error_code(&anyhow!("invalid_grant")), None);
    }

    #[test]
    fn refresh_lock_same_key_returns_the_same_arc() {
        let a = refresh_lock("test", "same");
        let b = refresh_lock("test", "same");
        assert!(std::sync::Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn refresh_lock_different_keys_return_different_arcs() {
        let a = refresh_lock("test", "lock-a");
        let b = refresh_lock("test", "lock-b");
        assert!(!std::sync::Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn parse_callback_reads_code_and_state() {
        let (code, state, error) = parse_callback("/?code=abc123&state=xyz789");
        assert_eq!(code.as_deref(), Some("abc123"));
        assert_eq!(state.as_deref(), Some("xyz789"));
        assert_eq!(error, None);
    }

    #[test]
    fn parse_callback_percent_decodes_values() {
        let (code, state, _) = parse_callback("/?code=a%2Bb%2Fc&state=has%20space");
        assert_eq!(code.as_deref(), Some("a+b/c"));
        assert_eq!(state.as_deref(), Some("has space"));
    }

    #[test]
    fn parse_callback_reads_error_on_deny() {
        let (code, state, error) = parse_callback("/?error=access_denied&state=xyz789");
        assert_eq!(code, None);
        assert_eq!(state.as_deref(), Some("xyz789"));
        assert_eq!(error.as_deref(), Some("access_denied"));
    }

    #[test]
    fn parse_callback_handles_missing_query_string() {
        let (code, state, error) = parse_callback("/");
        assert_eq!(code, None);
        assert_eq!(state, None);
        assert_eq!(error, None);
    }

    #[test]
    fn the_callback_waits_for_a_slow_browser_and_ignores_a_silent_peer() {
        use std::io::{Read as _, Write as _};
        use std::net::{TcpListener, TcpStream};

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();

        let client = std::thread::spawn(move || {
            let _silent = TcpStream::connect(addr).unwrap();
            let mut real = TcpStream::connect(addr).unwrap();
            std::thread::sleep(Duration::from_millis(150));
            real.write_all(b"GET /?code=abc%2F123&state=st HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
            let mut resp = String::new();
            real.read_to_string(&mut resp).unwrap();
            assert!(resp.contains("successful"), "{resp}");
        });

        let code = accept_code(&listener, "st", Instant::now() + Duration::from_secs(10)).unwrap();
        assert_eq!(code, "abc/123");
        client.join().unwrap();
    }

    #[test]
    fn a_silent_peer_cannot_park_the_callback_past_its_deadline() {
        use std::net::{TcpListener, TcpStream};

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let _silent = TcpStream::connect(listener.local_addr().unwrap()).unwrap();

        let start = Instant::now();
        let err = accept_code(&listener, "st", start + Duration::from_millis(300)).unwrap_err();
        assert!(err.to_string().contains("timed out"), "{err:#}");
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "deadline overshot"
        );
    }

    #[test]
    fn a_denied_authorization_fails_fast() {
        use std::io::Write as _;
        use std::net::{TcpListener, TcpStream};

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let mut s = TcpStream::connect(addr).unwrap();
            s.write_all(b"GET /?error=access_denied&state=st HTTP/1.1\r\n\r\n")
                .unwrap();
            std::thread::sleep(Duration::from_millis(200));
        });

        let err =
            accept_code(&listener, "st", Instant::now() + Duration::from_secs(10)).unwrap_err();
        assert!(err.to_string().contains("access_denied"), "{err:#}");
    }
}
