//! Shared GraphQL plumbing for the Linear and GitHub clients: the
//! `{ nodes: [...] }` connection wrapper, the response envelope, and the
//! POST → decode → error-check helper. Each client keeps its own request wiring
//! (URL, auth, headers); only the shape of the response is shared.

use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Deserialize;

/// One process-wide HTTP client (connection pool + TLS session reuse) shared by
/// every Linear/GitHub call instead of a per-module duplicate. The 30s timeout
/// means a stalled request fails instead of hanging forever.
pub fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("building HTTP client")
    });
    &CLIENT
}

/// A GraphQL `{ nodes: [...] }` connection. One generic wrapper instead of a
/// near-identical `*Conn` struct per query. `Default` is hand-written because the
/// derive would needlessly require `T: Default` — an absent connection is simply
/// no nodes. `page_info` is only populated for queries that request it; callers
/// that don't care about pagination just ignore it.
#[derive(Deserialize)]
pub struct Connection<T> {
    #[serde(default = "Vec::new")]
    pub nodes: Vec<T>,
    #[serde(default, rename = "pageInfo")]
    pub page_info: PageInfo,
}
impl<T> Default for Connection<T> {
    fn default() -> Self {
        Self {
            nodes: Vec::new(),
            page_info: PageInfo::default(),
        }
    }
}

/// A GraphQL connection's pagination cursor. Defaults to "no more pages" so a
/// query that doesn't request `pageInfo` behaves as if everything fit in one page.
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    #[serde(default)]
    pub has_next_page: bool,
    #[serde(default)]
    pub end_cursor: Option<String>,
}

/// A single GraphQL error from the `errors` array.
#[derive(Deserialize)]
struct GqlError {
    message: String,
}

/// A GraphQL POST the server rejected with a non-success status. Carries the status
/// alongside the message so a caller can act on it without matching on message text —
/// `linear.rs` tells a rejected access token (401) apart from every other failure that
/// way, and refreshes it. Its `Display` is the message alone, so the status doesn't
/// show up twice in a toast.
#[derive(Debug)]
pub struct HttpError {
    pub status: reqwest::StatusCode,
    message: String,
}
impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for HttpError {}

/// The HTTP status a failed [`post`] came back with, or `None` when it failed for any
/// other reason — a transport error, or an HTTP 200 carrying a GraphQL `errors` array
/// (a permission/validation failure, which a retry would only repeat).
pub fn status_of(err: &anyhow::Error) -> Option<reqwest::StatusCode> {
    err.downcast_ref::<HttpError>().map(|e| e.status)
}

/// The error for a non-success GraphQL response: the service's own body (Linear
/// explains a complexity overflow there, GitHub a rate limit) rather than a bare
/// status code, with the status attached for [`status_of`].
fn status_error(service: &str, status: reqwest::StatusCode, body: &str) -> anyhow::Error {
    let snippet: String = body.chars().take(300).collect();
    anyhow::Error::new(HttpError {
        status,
        message: format!("{service} GraphQL returned {status}: {snippet}"),
    })
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
    /// A GraphQL endpoint can return HTTP 200 with `data: null` + a populated
    /// `errors` array on permission/validation failures — surfaced rather than
    /// reported as an empty response.
    #[serde(default)]
    errors: Vec<GqlError>,
}

/// Send a prepared GraphQL POST and decode its typed `data` payload, turning a
/// populated `errors` array (even on HTTP 200) into an error. `service` names the
/// backend for the error messages (e.g. "Linear", "GitHub"). The caller builds
/// the request (URL, auth, headers, JSON body) so each client keeps its wiring.
pub async fn post<T: DeserializeOwned>(req: reqwest::RequestBuilder, service: &str) -> Result<T> {
    post_observed(req, service, |_| {}).await
}

/// [`post`], with a look at the response headers before the body is decoded.
///
/// Linear reports the remaining rate-limit budget only in the headers of a
/// request that already spent some of it — there is no queryable equivalent of
/// GitHub's `/rate_limit` — so reading it means observing calls the app was
/// making anyway. `observe` runs on the rejections too, since a 429 is when the
/// numbers matter most, and it must not fail: it is a side-channel on the way
/// past, never a reason a query fails.
pub async fn post_observed<T: DeserializeOwned>(
    req: reqwest::RequestBuilder,
    service: &str,
    observe: impl FnOnce(&reqwest::header::HeaderMap),
) -> Result<T> {
    let res = req
        .send()
        .await
        .with_context(|| format!("{service} GraphQL request"))?;
    observe(res.headers());
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(status_error(service, status, &body));
    }
    let env: Envelope<T> = res
        .json()
        .await
        .with_context(|| format!("decoding {service} response"))?;
    if !env.errors.is_empty() {
        let joined = env
            .errors
            .iter()
            .map(|e| e.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        bail!("{service}: {joined}");
    }
    env.data.ok_or_else(|| anyhow!("empty {service} response"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Serve exactly one canned HTTP response on an ephemeral port and return its URL,
    /// so [`post`]'s real send → status → decode path is exercised without a network.
    fn serve_once(status_line: &'static str, body: &'static str) -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // One read is enough to let the client finish writing; we don't parse the
            // request, only answer it.
            let _ = stream.read(&mut [0u8; 4096]);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            );
        });
        url
    }

    async fn post_to(url: &str) -> anyhow::Error {
        post::<serde_json::Value>(client().post(url), "Linear")
            .await
            .unwrap_err()
    }

    /// The seam `linear.rs`'s token refresh hangs off: a rejected token has to be
    /// distinguishable from any other failure *without* sniffing the message text.
    #[tokio::test]
    async fn a_rejected_request_carries_its_http_status() {
        let err = post_to(&serve_once(
            "401 Unauthorized",
            r#"{"error":"invalid token"}"#,
        ))
        .await;
        assert_eq!(status_of(&err), Some(reqwest::StatusCode::UNAUTHORIZED));
        // …and the service's own body still reaches the message.
        let msg = format!("{err:#}");
        assert!(msg.contains("Linear GraphQL returned 401"), "{msg}");
        assert!(msg.contains("invalid token"), "{msg}");
    }

    /// The other half: a GraphQL-level failure (HTTP 200 + `errors`) carries no status,
    /// so a caller retrying on 401 doesn't burn its single-use refresh grant on a
    /// permission or complexity error that would only repeat.
    #[tokio::test]
    async fn a_graphql_errors_array_carries_no_http_status() {
        let err = post_to(&serve_once(
            "200 OK",
            r#"{"data":null,"errors":[{"message":"access denied"}]}"#,
        ))
        .await;
        assert_eq!(status_of(&err), None);
        assert!(format!("{err:#}").contains("access denied"));
    }

    /// A non-401 rejection is still reported with its status (nothing about the
    /// refresh path depends on 401 being the only one carried).
    #[tokio::test]
    async fn a_complexity_overflow_carries_its_status_too() {
        let err = post_to(&serve_once(
            "400 Bad Request",
            r#"{"message":"too complex"}"#,
        ))
        .await;
        assert_eq!(status_of(&err), Some(reqwest::StatusCode::BAD_REQUEST));
    }

    #[tokio::test]
    async fn a_successful_response_decodes_its_data() {
        let data: serde_json::Value = post(
            client().post(serve_once("200 OK", r#"{"data":{"viewer":{"id":"u1"}}}"#)),
            "Linear",
        )
        .await
        .unwrap();
        assert_eq!(data["viewer"]["id"], "u1");
    }
}
