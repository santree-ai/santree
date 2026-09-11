//! Shared HTTP plumbing for the Linear and GitHub clients: the one client, the
//! send that repeats a read once when a service's edge fails, the message a failed
//! response turns into, and for GraphQL the `{ nodes: [...] }` connection wrapper,
//! the response envelope and the POST → decode → error-check helper. Each client
//! keeps its own request wiring (URL, auth, headers).

use anyhow::{anyhow, Context, Result};
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
#[derive(Deserialize, Debug)]
pub struct GqlError {
    pub message: String,
    /// The service's machine-readable annotation, when it sends one. Preferred over
    /// the human message wherever a caller has to *act* on a specific failure.
    #[serde(default)]
    pub extensions: GqlErrorExtensions,
}

/// The one part of a GraphQL error's `extensions` the app classifies on: the
/// service's own error code. Everything else it puts there (`type`, `userError`,
/// `userPresentableMessage`, …) is ignored rather than rejected — an unmodelled key
/// must never turn a decodable error into a decode failure.
#[derive(Deserialize, Debug, Default)]
pub struct GqlErrorExtensions {
    #[serde(default)]
    pub code: Option<String>,
}

/// A GraphQL response that came back HTTP 200 with a populated `errors` array —
/// the shape a permission, validation or "no such entity" failure arrives in.
///
/// Carries the parsed entries alongside the joined message so a caller can act on a
/// *specific* failure without re-parsing its own error string — `linear.rs` tells
/// "that issue does not exist" apart from every other Linear failure that way. Its
/// `Display` is the same `"<service>: <messages>"` a user sees in a toast.
#[derive(Debug)]
pub struct GraphQlErrors {
    service: String,
    pub errors: Vec<GqlError>,
}
impl GraphQlErrors {
    /// Build one from a decoded `errors` array. Public so a caller's tests can hand
    /// their classifier the exact array a service returns without standing up a
    /// server to return it.
    pub fn new(service: &str, errors: Vec<GqlError>) -> Self {
        Self {
            service: service.to_string(),
            errors,
        }
    }
}
impl std::fmt::Display for GraphQlErrors {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let joined = self
            .errors
            .iter()
            .map(|e| e.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        write!(f, "{}: {joined}", self.service)
    }
}
impl std::error::Error for GraphQlErrors {}

/// The GraphQL `errors` array a failed [`post`] carried, or `None` when it failed for
/// any other reason — a transport error, or a non-success HTTP status (see
/// [`status_of`]). Those are the failures a caller must *not* reinterpret: an expired
/// token, a rate limit and a dead network all arrive that way.
pub fn graphql_errors(err: &anyhow::Error) -> Option<&GraphQlErrors> {
    err.downcast_ref::<GraphQlErrors>()
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

/// How long a read waits before it is sent the second time. A gateway failure is
/// usually a moment of the service being unreachable rather than an outage, and
/// the frontend's own retry still comes after this one.
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(500);

/// A status a service's edge answers with when the service behind it didn't. It is
/// about a moment, not about the request, which makes it the one failure worth a
/// retry and the one whose body (a proxy's HTML page) is never worth showing.
fn is_gateway_failure(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::BAD_GATEWAY
            | reqwest::StatusCode::SERVICE_UNAVAILABLE
            | reqwest::StatusCode::GATEWAY_TIMEOUT
    )
}

/// What a user reads about a failed response from `service`.
///
/// The service's own body is kept, because that is where the reason is (Linear
/// explains a complexity overflow there, GitHub a rate limit) — unless it is an
/// HTML page, which a toast shows as raw markup and which says nothing the status
/// doesn't. A gateway failure says in words that it's the service, not the request.
pub fn status_message(service: &str, status: reqwest::StatusCode, body: &str) -> String {
    if is_gateway_failure(status) {
        return format!("{service} is temporarily unavailable ({status}). Try again in a moment.");
    }
    let body = body.trim();
    if body.is_empty() || body.starts_with('<') {
        return format!("{service} returned {status}");
    }
    let snippet: String = body.chars().take(300).collect();
    format!("{service} returned {status}: {snippet}")
}

/// The error for a non-success GraphQL response, with the status attached for
/// [`status_of`].
fn status_error(service: &str, status: reqwest::StatusCode, body: &str) -> anyhow::Error {
    anyhow::Error::new(HttpError {
        status,
        message: status_message(&format!("{service} GraphQL"), status, body),
    })
}

/// Whether a GraphQL document is a read: no `mutation` or `subscription` in it.
///
/// Every write starts with the `mutation` keyword, so no write passes. A read can
/// fail it — a field or a comment that happens to use the word — and the only cost
/// of that is one retry not taken, which is why this is a word match and not a parser.
fn is_query_document(document: &str) -> bool {
    !document
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .any(|word| word == "mutation" || word == "subscription")
}

/// Whether sending `request` a second time can't change anything the first
/// didn't: a GET, or a GraphQL POST whose document is a read.
fn is_repeatable(request: &reqwest::Request) -> bool {
    match *request.method() {
        reqwest::Method::GET | reqwest::Method::HEAD => true,
        reqwest::Method::POST => request
            .body()
            .and_then(|body| body.as_bytes())
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
            .and_then(|json| json.get("query")?.as_str().map(is_query_document))
            .unwrap_or(false),
        _ => false,
    }
}

/// Send a prepared request, and send it once more when the service's edge answers
/// with a gateway failure (502/503/504) and the request is a read.
///
/// A write is never sent twice: a gateway failure doesn't say whether the service
/// applied the write before its edge gave up, and a second send could post the same
/// review comment twice. `service` names the backend in the error context and in
/// the log line a retry leaves — the only trace a blip the retry absorbed has.
pub async fn send(req: reqwest::RequestBuilder, service: &str) -> Result<reqwest::Response> {
    let (client, request) = req.build_split();
    let request = request.with_context(|| format!("{service} request"))?;
    let again = if is_repeatable(&request) {
        request.try_clone()
    } else {
        None
    };
    let res = client
        .execute(request)
        .await
        .with_context(|| format!("{service} request"))?;
    let Some(again) = again.filter(|_| is_gateway_failure(res.status())) else {
        return Ok(res);
    };
    log::warn!(
        "{service} answered {}; sending the read once more",
        res.status()
    );
    tokio::time::sleep(RETRY_DELAY).await;
    client
        .execute(again)
        .await
        .with_context(|| format!("{service} request"))
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
/// the request (URL, auth, headers, JSON body) so each client keeps its wiring;
/// a read is sent once more on a gateway failure (see [`send`]).
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
/// past, never a reason a query fails. After a retry it sees the response that
/// answered, which is the newer budget anyway.
pub async fn post_observed<T: DeserializeOwned>(
    req: reqwest::RequestBuilder,
    service: &str,
    observe: impl FnOnce(&reqwest::header::HeaderMap),
) -> Result<T> {
    let res = send(req, &format!("{service} GraphQL")).await?;
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
        return Err(anyhow::Error::new(GraphQlErrors::new(service, env.errors)));
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

    /// …and the entries themselves survive, so a caller can classify one specific
    /// failure (Linear's "no such issue") without matching on the joined string.
    #[tokio::test]
    async fn a_graphql_errors_array_keeps_its_entries_and_extensions() {
        let err = post_to(&serve_once(
            "200 OK",
            r#"{"data":null,"errors":[{"message":"Entity not found: Issue",
                "extensions":{"type":"invalid_input","code":"ENTITY_NOT_FOUND","userError":true}}]}"#,
        ))
        .await;
        let errors = graphql_errors(&err).expect("a GraphQL errors array");
        assert_eq!(errors.errors.len(), 1);
        assert_eq!(errors.errors[0].message, "Entity not found: Issue");
        assert_eq!(
            errors.errors[0].extensions.code.as_deref(),
            Some("ENTITY_NOT_FOUND")
        );
        // The user-facing string is unchanged by carrying the structure.
        assert_eq!(err.to_string(), "Linear: Entity not found: Issue");
    }

    /// An error array without `extensions` (or with only keys we don't model) still
    /// decodes — the structure is an aid to classification, never a decode gate.
    #[tokio::test]
    async fn a_graphql_error_without_extensions_still_decodes() {
        let err = post_to(&serve_once(
            "200 OK",
            r#"{"data":null,"errors":[{"message":"boom","locations":[{"line":1,"column":2}]}]}"#,
        ))
        .await;
        let errors = graphql_errors(&err).expect("a GraphQL errors array");
        assert_eq!(errors.errors[0].message, "boom");
        assert!(errors.errors[0].extensions.code.is_none());
    }

    /// A transport/status failure is *not* a GraphQL errors array — the distinction
    /// callers rely on to keep an expired token or a rate limit surfacing as an error.
    #[tokio::test]
    async fn a_status_failure_is_not_a_graphql_errors_array() {
        let err = post_to(&serve_once(
            "429 Too Many Requests",
            r#"{"message":"slow down"}"#,
        ))
        .await;
        assert!(graphql_errors(&err).is_none());
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

    // ── A gateway failure ─────────────────────────────────────────────────

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const READ: &str = r#"{"query":"query Viewer { viewer { login } }","variables":{}}"#;
    const WRITE: &str = r#"{"query":"mutation Resolve($id: ID!) { resolveReviewThread(input: {threadId: $id}) { clientMutationId } }","variables":{"id":"T1"}}"#;
    /// What GitHub's edge actually answered with, byte for byte the page a toast
    /// once showed as markup.
    const NGINX_502: &str = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n";

    fn gql_post(url: &str, body: &'static str) -> reqwest::RequestBuilder {
        client()
            .post(url)
            .header("Content-Type", "application/json")
            .body(body)
    }

    /// Read one whole request off `stream`: its headers, then the body bytes they
    /// announce. Closing a socket with input still unread resets it, which can throw
    /// away a response the client hasn't read yet.
    fn read_request(stream: &mut std::net::TcpStream) {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let Ok(n) = stream.read(&mut chunk) else {
                return;
            };
            if n == 0 {
                return;
            }
            buf.extend_from_slice(&chunk[..n]);
            let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                continue;
            };
            let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
            let len = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buf.len() >= end + 4 + len {
                return;
            }
        }
    }

    /// Serve `responses` in order, one per connection, counting the requests that
    /// arrive — how a test tells a request sent twice from one sent once.
    fn serve_each(responses: Vec<(&'static str, &'static str)>) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let served = Arc::new(AtomicUsize::new(0));
        let count = served.clone();
        std::thread::spawn(move || {
            for (status_line, body) in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                read_request(&mut stream);
                count.fetch_add(1, Ordering::SeqCst);
                // `Connection: close`, so a retry opens a connection of its own
                // instead of racing this one's shutdown.
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                );
            }
        });
        (url, served)
    }

    #[tokio::test]
    async fn a_read_the_edge_failed_is_sent_once_more() {
        let (url, served) = serve_each(vec![
            ("502 Bad Gateway", NGINX_502),
            ("200 OK", r#"{"data":{"viewer":{"login":"octocat"}}}"#),
        ]);
        let data: serde_json::Value = post(gql_post(&url, READ), "GitHub").await.unwrap();
        assert_eq!(data["viewer"]["login"], "octocat");
        assert_eq!(served.load(Ordering::SeqCst), 2);
    }

    /// The toast that started this: a proxy's HTML page, shown as markup. Failing
    /// twice now says what happened in words, and keeps the status for callers.
    #[tokio::test]
    async fn a_read_the_edge_fails_twice_says_so_in_words() {
        let (url, served) = serve_each(vec![
            ("502 Bad Gateway", NGINX_502),
            ("502 Bad Gateway", NGINX_502),
        ]);
        let err = post::<serde_json::Value>(gql_post(&url, READ), "GitHub")
            .await
            .unwrap_err();
        assert_eq!(served.load(Ordering::SeqCst), 2);
        assert_eq!(status_of(&err), Some(reqwest::StatusCode::BAD_GATEWAY));
        assert_eq!(
            err.to_string(),
            "GitHub GraphQL is temporarily unavailable (502 Bad Gateway). Try again in a moment."
        );
    }

    /// A gateway failure doesn't say whether the write landed behind it, so a
    /// second send could apply it twice.
    #[tokio::test]
    async fn a_write_the_edge_failed_is_not_sent_again() {
        let (url, served) = serve_each(vec![
            ("502 Bad Gateway", NGINX_502),
            ("200 OK", r#"{"data":{}}"#),
        ]);
        let err = post::<serde_json::Value>(gql_post(&url, WRITE), "GitHub")
            .await
            .unwrap_err();
        assert_eq!(status_of(&err), Some(reqwest::StatusCode::BAD_GATEWAY));
        assert_eq!(
            served.load(Ordering::SeqCst),
            1,
            "the write reached the server once"
        );
    }

    #[tokio::test]
    async fn any_other_failure_is_sent_once_and_drops_an_html_body() {
        let (url, served) = serve_each(vec![
            (
                "500 Internal Server Error",
                "<html><body>oops</body></html>",
            ),
            ("200 OK", r#"{"data":{}}"#),
        ]);
        let err = post::<serde_json::Value>(gql_post(&url, READ), "GitHub")
            .await
            .unwrap_err();
        assert_eq!(served.load(Ordering::SeqCst), 1);
        assert_eq!(
            err.to_string(),
            "GitHub GraphQL returned 500 Internal Server Error"
        );
    }

    /// The retry's guard. Its one allowed mistake is calling a read a write.
    #[test]
    fn only_a_document_without_a_mutation_is_a_read() {
        assert!(is_query_document("query Viewer { viewer { login } }"));
        assert!(is_query_document("{ viewer { login } }"));
        assert!(is_query_document(
            "query { repository { viewerSubscription } }"
        ));
        // Linear's scope queries carry their fragment after the operation.
        assert!(is_query_document(
            "query T { teams { nodes { ...TriageTeam } } }\nfragment TriageTeam on Team { key }"
        ));
        assert!(!is_query_document(
            "mutation Resolve($id: ID!) { resolveReviewThread(input: {threadId: $id}) { clientMutationId } }"
        ));
        assert!(!is_query_document("subscription { issueUpdated { id } }"));
        // The safe direction of a word match: a read that mentions it isn't retried.
        assert!(!is_query_document(
            "query { viewer { login } } # no mutation here"
        ));
    }

    #[test]
    fn a_get_is_repeatable_and_a_post_only_when_it_carries_a_read() {
        let url: reqwest::Url = "http://127.0.0.1/".parse().unwrap();
        assert!(is_repeatable(&reqwest::Request::new(
            reqwest::Method::GET,
            url.clone()
        )));
        assert!(
            !is_repeatable(&reqwest::Request::new(reqwest::Method::POST, url.clone())),
            "a POST with no body says nothing about what it does"
        );
        assert!(is_repeatable(
            &gql_post(url.as_str(), READ).build().unwrap()
        ));
        assert!(!is_repeatable(
            &gql_post(url.as_str(), WRITE).build().unwrap()
        ));
        assert!(!is_repeatable(&reqwest::Request::new(
            reqwest::Method::PUT,
            url
        )));
    }

    // ── The pagination cursor ─────────────────────────────────────────────

    #[derive(Deserialize)]
    struct Node {
        id: String,
    }
    #[derive(Deserialize)]
    struct Page {
        issues: Connection<Node>,
    }

    /// Nine pagination loops in `linear.rs` and `github.rs` turn on this one
    /// decode, and until this test nothing deserialized it — every `hasNextPage`
    /// in the tree was inside a query *string*. Drop [`Connection`]'s `pageInfo`
    /// rename or [`PageInfo`]'s `rename_all` and the `serde(default)` underneath
    /// answers "no more pages": every loop stops after page 1 while its query
    /// still asks for the cursor, and the caller sees a short list it has no way
    /// to tell from a complete one.
    #[tokio::test]
    async fn a_connection_decodes_the_cursor_its_query_asked_for() {
        let page: Page = post(
            client().post(serve_once(
                "200 OK",
                r#"{"data":{"issues":{
                     "nodes":[{"id":"a"},{"id":"b"}],
                     "pageInfo":{"hasNextPage":true,"endCursor":"Y3Vyc29yOnYyOpHOACk"}}}}"#,
            )),
            "Linear",
        )
        .await
        .unwrap();

        let ids: Vec<&str> = page.issues.nodes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, ["a", "b"]);
        assert!(
            page.issues.page_info.has_next_page,
            "the wire said there is another page"
        );
        assert_eq!(
            page.issues.page_info.end_cursor.as_deref(),
            Some("Y3Vyc29yOnYyOpHOACk"),
            "the cursor the next request has to send back"
        );
    }

    /// The other half of the contract the `serde(default)`s exist for: a query
    /// that never asked for `pageInfo` (most of them) reads as one complete page
    /// rather than failing to decode.
    #[test]
    fn a_connection_without_a_cursor_reads_as_one_complete_page() {
        for body in [
            r#"{"issues":{"nodes":[{"id":"a"}]}}"#,
            // Asked for, but the service answered with an empty object.
            r#"{"issues":{"nodes":[{"id":"a"}],"pageInfo":{}}}"#,
        ] {
            let page: Page = serde_json::from_str(body).expect(body);
            assert_eq!(page.issues.nodes.len(), 1, "{body}");
            assert!(!page.issues.page_info.has_next_page, "{body}");
            assert!(page.issues.page_info.end_cursor.is_none(), "{body}");
        }
        // And an absent connection is no nodes, not a decode failure.
        let page: Page = serde_json::from_str(r#"{"issues":{}}"#).unwrap();
        assert!(page.issues.nodes.is_empty());
    }
}
