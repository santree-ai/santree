//! Daedalus's REST API, as santree reads it: `GET <url>/api/santree/connection`
//! and `GET <url>/api/santree/workspaces`, each with the bearer token.
//!
//! Every outcome is a [`DaedalusReach`], never an error: the user being away from
//! home is the normal case this exists for (docs/remote.md). The reach's reason is
//! a short line for a person, built here from the status or the transport failure
//! and never from the request itself, so the bearer cannot ride into it.

use std::net::IpAddr;
use std::time::Duration;

use anyhow::{bail, Result};
use reqwest::{StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::Deserialize;

use santree_core::domain::{DaedalusReach, DaedalusSync, DaedalusWorkspace};

/// How long a connect gets. Short: an unreachable home server is the common
/// failure, and a Settings pane or a status poll must not sit on it.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// The whole request, body included.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);

/// The Daedalus client. Never follows a redirect: the request carries a bearer,
/// and it goes to the host the user typed or nowhere.
fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("building HTTP client")
    });
    &CLIENT
}

/// A user-typed Daedalus URL, checked and normalised: `https` (or `http` to a
/// host on the user's own network — see [`plain_http_allowed`]), a host, no
/// credentials, query or fragment, and no trailing slash — so the endpoint
/// paths join onto it the same way however it was typed.
pub fn normalize_url(raw: &str) -> Result<String> {
    let raw = raw.trim();
    let Ok(url) = Url::parse(raw) else {
        bail!("That isn't a URL. Use the full address, like https://daedalus.example.");
    };
    if !matches!(url.scheme(), "http" | "https") {
        bail!("The Daedalus URL has to start with http:// or https://.");
    }
    let Some(host) = url.host_str().filter(|h| !h.is_empty()) else {
        bail!("The Daedalus URL has no host.");
    };
    if url.scheme() == "http" && !plain_http_allowed(host) {
        bail!(
            "Use https://, since every request carries your API token. Plain http:// is \
             only allowed for localhost, a private or link-local IP address (10.x, 172.16-31.x, \
             192.168.x, 169.254.x, fc00::/7, fe80::/10), a .local name, or a one-word \
             host name."
        );
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("Leave credentials out of the URL; the token goes in its own field.");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("The Daedalus URL can't carry a query or a fragment.");
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Whether a plain-http URL to `host` keeps the bearer on the user's own
/// network: a loopback, private or link-local IP literal, or a name that only
/// local resolution answers — `localhost`, mDNS's `.local`, or a single label
/// (a LAN or VPN search-domain name). Anything else could be the internet, and
/// the token would cross it in the clear. Decided on the parsed host, never on
/// the URL's text.
fn plain_http_allowed(host: &str) -> bool {
    // `host` is `Url`'s parsed host written back out: an IPv4 literal in
    // dotted decimal however it was typed, an IPv6 one in brackets, a name
    // lowercased.
    let literal = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    match literal.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        Err(_) => {
            // A trailing dot is the same name.
            let name = host.strip_suffix('.').unwrap_or(host);
            !name.is_empty() && (!name.contains('.') || name.ends_with(".local"))
        }
    }
}

/// `GET /api/santree/connection` — how to reach the server over ssh. `sshHost`
/// is one name that reaches sshd from anywhere (docs/remote.md "One address").
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Connection {
    pub ssh_user: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub projects_root: Option<String>,
}

/// `GET /api/santree/workspaces` — the checkouts under the projects root.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspaces {
    pub root: Option<String>,
    pub generated_at: Option<String>,
    #[serde(deserialize_with = "null_as_default")]
    pub workspaces: Vec<WireWorkspace>,
}

/// One row of that list as the server sends it. Lenient on purpose: a field left
/// out, or sent as `null`, reads as its default rather than failing the list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WireWorkspace {
    #[serde(deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(deserialize_with = "null_as_default")]
    pub path: String,
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub head_at: Option<String>,
    #[serde(deserialize_with = "null_as_default")]
    pub dirty: bool,
    #[serde(deserialize_with = "null_as_default")]
    pub ahead: u32,
    #[serde(deserialize_with = "null_as_default")]
    pub behind: u32,
    #[serde(deserialize_with = "null_as_default")]
    pub sync: WireSync,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct WireSync {
    pub result: Option<String>,
    pub detail: Option<String>,
    pub at: Option<String>,
}

impl WireWorkspace {
    /// The bridge's shape, with santree's own `registered` mark.
    pub fn into_domain(self, registered: bool) -> DaedalusWorkspace {
        DaedalusWorkspace {
            name: self.name,
            path: self.path,
            remote: self.remote,
            branch: self.branch,
            head: self.head,
            head_at: self.head_at,
            dirty: self.dirty,
            ahead: self.ahead,
            behind: self.behind,
            sync: DaedalusSync {
                result: self.sync.result,
                detail: self.sync.detail,
                at: self.sync.at,
            },
            registered,
        }
    }
}

/// A field that may arrive as `null`, read as its default.
fn null_as_default<'de, D, T>(deserializer: D) -> std::result::Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// One read's outcome: the body when Daedalus answered with it, else the reach
/// that explains why not.
pub type Fetched<T> = std::result::Result<T, DaedalusReach>;

pub async fn connection(base: &str, token: Option<&str>) -> Fetched<Connection> {
    get(base, "connection", token).await
}

pub async fn workspaces(base: &str, token: Option<&str>) -> Fetched<Workspaces> {
    get(base, "workspaces", token).await
}

async fn get<T: DeserializeOwned>(base: &str, endpoint: &str, token: Option<&str>) -> Fetched<T> {
    let mut request = client().get(format!("{base}/api/santree/{endpoint}"));
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    let response = request.send().await.map_err(|e| unreachable(&e))?;
    reach_for_status(response.status())?;
    response.json::<T>().await.map_err(|e| {
        if e.is_timeout() {
            unreachable(&e)
        } else {
            DaedalusReach::ApiUnreachable {
                reason: "Daedalus answered with something santree can't read.".into(),
            }
        }
    })
}

/// What an HTTP status says about reaching Daedalus: `Ok` for a success, else the
/// reach to show.
pub fn reach_for_status(status: StatusCode) -> Fetched<()> {
    if status.is_success() {
        return Ok(());
    }
    Err(match status.as_u16() {
        401 | 403 => DaedalusReach::Unauthorized,
        404 => DaedalusReach::ApiUnreachable {
            reason: "This Daedalus doesn't serve santree's API yet. Update Daedalus.".into(),
        },
        code if status.is_redirection() => DaedalusReach::ApiUnreachable {
            reason: format!("Daedalus redirected (HTTP {code}). Use the address it redirects to."),
        },
        code if status.is_server_error() => DaedalusReach::ApiUnreachable {
            reason: format!("Daedalus had an error (HTTP {code})."),
        },
        code => DaedalusReach::ApiUnreachable {
            reason: format!("Daedalus answered HTTP {code}."),
        },
    })
}

/// A transport failure as a short reason. Built from the error's *kind* and its
/// source chain's words, never from its URL or anything the request carried.
fn unreachable(error: &reqwest::Error) -> DaedalusReach {
    let mut chain = String::new();
    let mut source: Option<&dyn std::error::Error> = std::error::Error::source(error);
    while let Some(cause) = source {
        chain.push_str(&cause.to_string().to_ascii_lowercase());
        chain.push(' ');
        source = cause.source();
    }
    DaedalusReach::ApiUnreachable {
        reason: transport_reason(error.is_timeout(), error.is_connect(), &chain).into(),
    }
}

/// The reason line for a transport failure, from what kind it was and the
/// (lower-cased) words of its causes.
fn transport_reason(timeout: bool, connect: bool, chain: &str) -> &'static str {
    if timeout {
        "Timed out waiting for Daedalus."
    } else if chain.contains("dns") || chain.contains("resolve") || chain.contains("lookup") {
        "Couldn't resolve the Daedalus host."
    } else if chain.contains("certificate") || chain.contains("tls") || chain.contains("handshake")
    {
        "Couldn't establish a secure connection to Daedalus."
    } else if connect {
        "Couldn't connect to Daedalus."
    } else {
        "Lost the connection to Daedalus."
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn normalizes_urls_and_rejects_the_unsafe_ones() {
        assert_eq!(
            normalize_url("https://daedalus.example/").unwrap(),
            "https://daedalus.example"
        );
        assert_eq!(
            normalize_url("  http://10.0.0.2:8080  ").unwrap(),
            "http://10.0.0.2:8080"
        );
        assert_eq!(
            normalize_url("https://home.example/daedalus/").unwrap(),
            "https://home.example/daedalus"
        );
        for bad in [
            "",
            "daedalus.example",
            "ftp://daedalus.example",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:pass@daedalus.example",
            "https://daedalus.example/?next=evil",
            "https://daedalus.example/#frag",
        ] {
            assert!(normalize_url(bad).is_err(), "{bad:?} should be refused");
        }
    }

    /// The bearer rides every request: plain http is only for a host on the
    /// user's own network, judged by the parsed host rather than the text.
    #[test]
    fn plain_http_is_only_for_the_local_network() {
        for local in [
            "http://localhost:8080",
            "http://127.0.0.1",
            "http://10.0.0.2:8080",
            "http://172.16.4.1",
            "http://172.31.255.254",
            "http://192.168.1.10",
            "http://169.254.10.1",
            "http://[::1]:8080",
            "http://[fd00::2]",
            "http://[fe80::1]",
            "http://daedalus",
            "http://daedalus.local",
            "http://Daedalus.Local.",
        ] {
            assert!(normalize_url(local).is_ok(), "{local} should be allowed");
        }
        for public in [
            "http://daedalus.example",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://100.64.0.1",
            "http://[2001:db8::1]",
            "http://[::ffff:10.0.0.2]",
            "http://daedalus.local.evil.example",
            "http://10.0.0.2.evil.example",
            "http://localhost.evil.example",
        ] {
            let err = normalize_url(public).unwrap_err().to_string();
            assert!(err.contains("Use https://"), "{public}: {err}");
        }
        // Any host at all over https.
        assert!(normalize_url("https://8.8.8.8").is_ok());
        assert!(normalize_url("https://daedalus.example").is_ok());
    }

    #[test]
    fn maps_http_statuses_to_reach() {
        assert_eq!(reach_for_status(StatusCode::OK), Ok(()));
        assert_eq!(
            reach_for_status(StatusCode::UNAUTHORIZED),
            Err(DaedalusReach::Unauthorized)
        );
        assert_eq!(
            reach_for_status(StatusCode::FORBIDDEN),
            Err(DaedalusReach::Unauthorized)
        );
        let Err(DaedalusReach::ApiUnreachable { reason }) = reach_for_status(StatusCode::NOT_FOUND)
        else {
            panic!("404 is unreachable");
        };
        assert!(reason.contains("doesn't serve santree's API"), "{reason}");
        for status in [
            StatusCode::BAD_GATEWAY,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::FOUND,
            StatusCode::IM_A_TEAPOT,
        ] {
            assert!(
                matches!(
                    reach_for_status(status),
                    Err(DaedalusReach::ApiUnreachable { .. })
                ),
                "{status}"
            );
        }
    }

    #[test]
    fn transport_failures_read_as_short_reasons() {
        assert_eq!(
            transport_reason(true, true, ""),
            "Timed out waiting for Daedalus."
        );
        assert_eq!(
            transport_reason(false, true, "dns error: failed to lookup address "),
            "Couldn't resolve the Daedalus host."
        );
        assert_eq!(
            transport_reason(false, true, "invalid peer certificate "),
            "Couldn't establish a secure connection to Daedalus."
        );
        assert_eq!(
            transport_reason(false, true, "connection refused "),
            "Couldn't connect to Daedalus."
        );
    }

    /// Serve one canned response on an ephemeral port; returns the base URL and a
    /// handle yielding the raw request the client sent.
    fn serve_once(
        status_line: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            );
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (url, handle)
    }

    #[tokio::test]
    async fn reads_the_connection_with_the_bearer() {
        let (url, request) = serve_once(
            "200 OK",
            r#"{"sshUser":"me","sshHost":"s2.example.org","sshPort":2222,"projectsRoot":"/srv/projects"}"#,
        );
        let conn = connection(&url, Some("t0k")).await.unwrap();
        assert_eq!(conn.ssh_user.as_deref(), Some("me"));
        assert_eq!(conn.ssh_port, Some(2222));
        assert_eq!(conn.ssh_host.as_deref(), Some("s2.example.org"));
        assert_eq!(conn.projects_root.as_deref(), Some("/srv/projects"));
        let request = request.join().unwrap();
        assert!(
            request.starts_with("GET /api/santree/connection "),
            "{request}"
        );
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer t0k"),
            "{request}"
        );
    }

    #[tokio::test]
    async fn a_missing_api_is_unreachable_not_an_error() {
        let (url, _) = serve_once("404 Not Found", "not here");
        assert!(matches!(
            workspaces(&url, Some("t")).await,
            Err(DaedalusReach::ApiUnreachable { .. })
        ));
    }

    #[tokio::test]
    async fn a_refused_token_is_unauthorized() {
        let (url, _) = serve_once("401 Unauthorized", "{}");
        assert_eq!(
            workspaces(&url, Some("t")).await,
            Err(DaedalusReach::Unauthorized)
        );
    }

    #[tokio::test]
    async fn workspaces_are_read_leniently() {
        let (url, _) = serve_once(
            "200 OK",
            r#"{"root":"/srv/projects","generatedAt":"2026-01-01T00:00:00Z","workspaces":[
                {"name":"web","path":"/srv/projects/web","remote":"git@github.com:acme/web.git",
                 "branch":"main","head":"abc","headAt":"2026-01-01T00:00:00Z","dirty":true,
                 "ahead":1,"behind":2,"sync":{"result":"ok","detail":null,"at":"2026-01-01T00:00:00Z"}},
                {"name":"bare","path":"/srv/projects/bare","dirty":null,"ahead":null,"sync":null}
            ]}"#,
        );
        let list = workspaces(&url, None).await.unwrap();
        assert_eq!(list.workspaces.len(), 2);
        let web = list.workspaces[0].clone().into_domain(false);
        assert!(web.dirty);
        assert_eq!((web.ahead, web.behind), (1, 2));
        assert_eq!(web.sync.result.as_deref(), Some("ok"));
        assert_eq!(list.workspaces[1].branch, None);
    }

    #[tokio::test]
    async fn nothing_listening_is_unreachable() {
        // Bind then drop, so the port is (almost certainly) closed.
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert!(matches!(
            connection(&format!("http://127.0.0.1:{port}"), None).await,
            Err(DaedalusReach::ApiUnreachable { .. })
        ));
    }
}
