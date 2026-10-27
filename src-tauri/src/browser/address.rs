//! What the Web tab will navigate to: the address bar's text turned into a URL,
//! and the one check every URL crossing IPC passes before a page loads it.
//!
//! A page is `http`/`https`, or `about:blank`. Nothing else is loaded from santree's
//! side — no `file:` (a tab is not a file browser, and a stored address must not
//! reach the disk), no `javascript:` (an address is not a script) and no app
//! schemes. Links a *page* follows are the navigation delegate's business
//! (`native::delegate`), not this module's.

use anyhow::{bail, Result};
use reqwest::Url;

/// The longest address santree stores or loads. Matches the column's CHECK.
const MAX_LEN: usize = 8192;

/// Where a query that isn't an address goes.
const SEARCH: &str = "https://www.google.com/search";

/// `url`, parsed, if a Web tab may load it. Every URL that arrives over IPC or is
/// read back from the database goes through here.
pub fn checked(url: &str) -> Result<Url> {
    if url.len() > MAX_LEN {
        bail!("that address is too long");
    }
    let parsed = Url::parse(url)?;
    if !is_page(&parsed) {
        bail!("santree's browser opens http and https pages only");
    }
    Ok(parsed)
}

/// Whether a Web tab shows this URL as a page.
pub fn is_page(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host().is_some()
        || url.as_str() == "about:blank"
}

/// The address santree writes down for a tab to reopen on: the page, without
/// the credentials an address can carry for a moment. A CLI's sign-in lands its
/// token in one — `codex login` redirects to `localhost:1455/success?id_token=…`
/// — and santree stores no agent's credential (COMPLIANCE.md), not even by
/// remembering where a tab was.
///
/// So a saved address keeps no user or password, no credential-named query
/// parameter, and no key-value fragment (an OAuth implicit grant's
/// `#access_token=…`). A page on this machine or the local network keeps no
/// query or fragment at all: there, a sign-in callback is the likely page, and a
/// dev server reopens fine on its path.
pub fn persistable(url: &Url) -> Url {
    let mut kept = url.clone();
    let _ = kept.set_username("");
    let _ = kept.set_password(None);
    if url.host_str().is_some_and(is_local) {
        kept.set_query(None);
        kept.set_fragment(None);
        return kept;
    }
    if url.query_pairs().any(|(key, _)| is_secret(&key)) {
        let others: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| !is_secret(key))
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        kept.set_query(None);
        if !others.is_empty() {
            kept.query_pairs_mut().extend_pairs(others);
        }
    }
    if url.fragment().is_some_and(|f| f.contains('=')) {
        kept.set_fragment(None);
    }
    kept
}

/// Query parameter names that carry a credential.
fn is_secret(key: &str) -> bool {
    const SECRETS: [&str; 14] = [
        "code",
        "token",
        "key",
        "apikey",
        "api_key",
        "secret",
        "client_secret",
        "password",
        "session",
        "sessionid",
        "sid",
        "jwt",
        "ticket",
        "otp",
    ];
    let key = key.to_ascii_lowercase();
    SECRETS.contains(&key.as_str()) || key.ends_with("token") || key.ends_with("_key")
}

/// The address bar's text as the URL to load, the way a browser reads it:
///
/// - a URL with a scheme loads as typed, if it is a page ([`is_page`]);
/// - a local address (`localhost:3000`, `127.0.0.1/admin`, `nas.local`, a
///   private-network IP) gets `http://` — dev servers rarely speak TLS;
/// - anything else that reads as a host (a dot or a port, no spaces) gets
///   `https://`;
/// - the rest is a search.
pub fn resolve(input: &str) -> Result<Url> {
    let input = input.trim();
    if input.is_empty() {
        bail!("type an address or a search");
    }
    // No address has a space in it.
    if !input.contains(char::is_whitespace) {
        if let Some((scheme, rest)) = input.split_once(':') {
            // `scheme://…`, or `scheme:rest` the way `mailto:` and `javascript:`
            // are written. A port is digits, so `localhost:3000` is no scheme.
            let scheme_like = scheme.starts_with(|c: char| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c));
            if scheme_like && !rest.starts_with(|c: char| c.is_ascii_digit()) {
                return checked(input);
            }
        }
        if let Some(url) = as_host(input) {
            return Ok(url);
        }
    }
    let mut search = Url::parse(SEARCH)?;
    search.query_pairs_mut().append_pair("q", input);
    Ok(search)
}

/// `input` as an address without a scheme, when it reads as one.
fn as_host(input: &str) -> Option<Url> {
    let http = Url::parse(&format!("http://{input}")).ok()?;
    let host = http.host_str()?;
    let local = is_local(host);
    if !local && !host.contains('.') && http.port().is_none() {
        // One bare word ("react", "todo") is a search, not a host.
        return None;
    }
    if local {
        return is_page(&http).then_some(http);
    }
    let https = Url::parse(&format!("https://{input}")).ok()?;
    is_page(&https).then_some(https)
}

/// Hosts that answer on this machine or the local network, which dev servers
/// and home-lab boxes serve over plain http.
fn is_local(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host.to_ascii_lowercase().ends_with(".local")
    {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_unspecified(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_bar_reads_input_the_way_a_browser_does() {
        let cases = [
            ("https://github.com/santree", "https://github.com/santree"),
            ("http://example.com", "http://example.com/"),
            ("github.com", "https://github.com/"),
            (
                "github.com/santree-ai/santree",
                "https://github.com/santree-ai/santree",
            ),
            ("localhost:5173", "http://localhost:5173/"),
            ("localhost", "http://localhost/"),
            (
                "app.localhost:3000/login",
                "http://app.localhost:3000/login",
            ),
            ("127.0.0.1:8080/admin", "http://127.0.0.1:8080/admin"),
            ("[::1]:3000", "http://[::1]:3000/"),
            ("192.168.0.2:8123", "http://192.168.0.2:8123/"),
            ("nas.local", "http://nas.local/"),
            ("example.com:8443", "https://example.com:8443/"),
            ("about:blank", "about:blank"),
            ("react hooks", "https://www.google.com/search?q=react+hooks"),
            ("react", "https://www.google.com/search?q=react"),
            (
                "what is 1.5 rem?",
                "https://www.google.com/search?q=what+is+1.5+rem%3F",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(resolve(input).unwrap().as_str(), want, "input {input:?}");
        }
    }

    /// The security gate: whatever is typed, stored or sent over IPC, santree only
    /// ever asks WebKit to load a web page.
    #[test]
    fn nothing_but_a_web_page_is_loaded() {
        for refused in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "vscode://file/etc/passwd",
            "ftp://example.com",
            "http://",
            "about:config",
        ] {
            assert!(checked(refused).is_err(), "{refused:?} must not load");
        }
        for refused in [
            "file:///etc/passwd",
            "vscode://open",
            "javascript:alert(1)",
            "mailto:me@example.com",
        ] {
            assert!(resolve(refused).is_err(), "{refused:?} must not load");
        }
        assert!(checked(&format!("https://example.com/{}", "a".repeat(MAX_LEN))).is_err());
    }

    /// COMPLIANCE.md: santree stores no agent CLI's credential. A Web tab writes
    /// down the page it is on, and a CLI's sign-in callback carries one.
    #[test]
    fn a_saved_address_keeps_no_credential() {
        let cases = [
            // codex login's local callback.
            (
                "http://localhost:1455/success?id_token=eyJh.eyJz.c2ln&needs_setup=false",
                "http://localhost:1455/success",
            ),
            // An OAuth code, and an implicit grant's fragment, on any host.
            (
                "https://platform.claude.com/oauth/code/callback?code=abc&state=xyz",
                "https://platform.claude.com/oauth/code/callback?state=xyz",
            ),
            (
                "https://app.example.com/cb#access_token=t0k&expires_in=3600",
                "https://app.example.com/cb",
            ),
            ("https://me:hunter2@example.com/", "https://example.com/"),
            (
                "https://example.com/s?q=rust&API_KEY=k&refresh_token=r",
                "https://example.com/s?q=rust",
            ),
            // What a page needs to reopen stays.
            (
                "https://github.com/santree-ai/santree/pulls?q=is%3Aopen#readme",
                "https://github.com/santree-ai/santree/pulls?q=is%3Aopen#readme",
            ),
            (
                "http://localhost:5173/settings",
                "http://localhost:5173/settings",
            ),
        ];
        for (seen, kept) in cases {
            let seen = Url::parse(seen).unwrap();
            assert_eq!(persistable(&seen).as_str(), kept, "from {seen}");
        }
    }
}
