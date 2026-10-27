//! Cookies from another browser on this Mac, copied into the Web tabs' own store
//! for the sites the user picks (docs/web.md, "Cookie import"), so a page there
//! opens signed in.
//!
//! A browser keeps a profile's cookies in a SQLite file, which is copied before it
//! is read: the browser holds it open and keeps writing to it, and the copy can't
//! change under the read. Chromium browsers encrypt each value with a key kept in
//! the login Keychain ([`chromium`]); Firefox keeps them in plain text
//! ([`firefox`]). A value only ever goes from that file to WebKit: the frontend
//! sees sites and counts, and nothing of a cookie is logged or saved.

mod chromium;
mod firefox;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use specta::Type;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Row as _, SqliteConnection};

/// A browser profile on this Mac whose cookies can be imported.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct CookieSource {
    /// `<browser>/<profile folder>`, as found here. The frontend hands it back,
    /// and it is only ever looked up among the sources found again, never made
    /// into a path.
    pub id: String,
    pub browser: String,
    /// The profile's name in the browser, when the browser has more than one.
    pub profile: Option<String>,
    /// Its cookies are locked with a key in the Keychain, so importing them makes
    /// macOS ask the user.
    pub keychain: bool,
}

/// A site a source has cookies for: a host, standing for itself and every
/// subdomain with cookies under it.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct CookieSite {
    pub site: String,
    pub cookies: u32,
}

/// What an import did.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct CookieImport {
    pub cookies: u32,
    /// Cookies that couldn't be decrypted, or that WebKit wouldn't take.
    pub skipped: u32,
}

/// A cookie as WebKit is handed it.
pub struct Cookie {
    pub name: String,
    pub value: String,
    /// The browser's host key, which keeps NSHTTPCookie's own convention:
    /// `.example.com` for a domain cookie, `example.com` for a host-only one.
    pub domain: String,
    pub path: String,
    /// Seconds since 1970; `None` for a session cookie.
    pub expires: Option<f64>,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<SameSite>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SameSite {
    Lax,
    Strict,
}

/// The cookies read for an import, and how many of them couldn't be.
pub struct Read {
    pub cookies: Vec<Cookie>,
    pub skipped: u32,
}

/// One cookie as a browser's file has it.
struct Row {
    host: String,
    name: String,
    value: Value,
    path: String,
    expires: Option<f64>,
    /// When the browser last sent it, in seconds since 1970: the sites used last
    /// are listed first.
    used: f64,
    secure: bool,
    http_only: bool,
    same_site: Option<SameSite>,
}

enum Value {
    Plain(String),
    /// A Chromium value, decrypted only once it is being imported.
    Encrypted(Vec<u8>),
}

/// A source, with where its cookies are and how to read them.
struct Profile {
    source: CookieSource,
    file: PathBuf,
    browser: Browser,
}

#[derive(Clone, Copy)]
enum Browser {
    Chromium(&'static chromium::Browser),
    Firefox,
}

/// The most sites one import takes: more than any profile has.
const MAX_SITES: usize = 10_000;

/// Every browser profile under `support` (the user's Application Support) that
/// has a cookie file.
pub fn sources(support: &Path) -> Vec<CookieSource> {
    profiles(support).into_iter().map(|p| p.source).collect()
}

/// The sites `source` has cookies for, the ones used last first.
pub async fn sites(support: &Path, source: &str) -> Result<Vec<CookieSite>> {
    let profile = find(support, source)?;
    Ok(group(&read_rows(&profile).await?))
}

/// `source`'s cookies for `sites`, decrypted. A Chromium source's key comes from
/// the Keychain, which waits for the user to answer macOS's prompt.
pub async fn read(support: &Path, source: &str, sites: &[String]) -> Result<Read> {
    if sites.len() > MAX_SITES {
        anyhow::bail!("too many sites for one import");
    }
    let profile = find(support, source)?;
    let rows = read_rows(&profile).await?;
    let picked: HashSet<&str> = sites.iter().map(String::as_str).collect();
    let hosts = hosts(&rows);
    let rows: Vec<Row> = rows
        .into_iter()
        .filter(|row| picked.contains(site_of(&normal(&row.host), &hosts)))
        .collect();
    let decrypt = match profile.browser {
        Browser::Chromium(browser)
            if rows.iter().any(|r| matches!(r.value, Value::Encrypted(_))) =>
        {
            let key = tokio::task::spawn_blocking(move || chromium::Key::from_keychain(browser))
                .await??;
            let version = chromium::version(&profile.file).await?;
            Some((key, version))
        }
        _ => None,
    };
    let mut cookies = Vec::with_capacity(rows.len());
    let mut skipped = 0;
    for row in rows {
        let value = match row.value {
            Value::Plain(value) => Some(value),
            Value::Encrypted(bytes) => decrypt
                .as_ref()
                .and_then(|(key, version)| key.decrypt(&row.host, &bytes, *version)),
        };
        let Some(value) = value else {
            skipped += 1;
            continue;
        };
        cookies.push(Cookie {
            name: row.name,
            value,
            domain: row.host,
            path: if row.path.is_empty() {
                "/".into()
            } else {
                row.path
            },
            expires: row.expires,
            secure: row.secure,
            http_only: row.http_only,
            same_site: row.same_site,
        });
    }
    Ok(Read { cookies, skipped })
}

fn profiles(support: &Path) -> Vec<Profile> {
    let mut profiles = chromium::profiles(support);
    profiles.extend(firefox::profiles(support));
    profiles
}

/// The profile an id from IPC names, among the ones found here.
fn find(support: &Path, id: &str) -> Result<Profile> {
    profiles(support)
        .into_iter()
        .find(|p| p.source.id == id)
        .ok_or_else(|| anyhow!("that browser profile isn't on this Mac anymore"))
}

/// Every unexpired cookie a profile has for a whole site — not one set inside
/// another site's frame (partitioned) or in a Firefox container, which no tab here
/// would send.
async fn read_rows(profile: &Profile) -> Result<Vec<Row>> {
    let copy = Copy::of(&profile.file)?;
    let mut db = copy.open().await?;
    let rows = match profile.browser {
        Browser::Chromium(_) => chromium::rows(&mut db).await,
        Browser::Firefox => firefox::rows(&mut db).await,
    }
    .with_context(|| format!("couldn't read {}'s cookies", profile.source.browser))?;
    let now = now();
    Ok(rows
        .into_iter()
        .filter(|row| !row.host.is_empty() && row.expires.is_none_or(|at| at > now))
        .collect())
}

/// The sites `rows` cover, with how many cookies each has, the ones used last
/// first.
fn group(rows: &[Row]) -> Vec<CookieSite> {
    let hosts = hosts(rows);
    // Normalized once and kept, so each site key can borrow from here for the
    // life of the map rather than from a per-row temporary.
    let normals: Vec<String> = rows.iter().map(|row| normal(&row.host)).collect();
    let mut sites: HashMap<&str, (u32, f64)> = HashMap::new();
    for (row, host) in rows.iter().zip(&normals) {
        let site = sites.entry(site_of(host, &hosts)).or_insert((0, 0.0));
        site.0 += 1;
        site.1 = site.1.max(row.used);
    }
    let mut sites: Vec<(&str, (u32, f64))> = sites.into_iter().collect();
    sites.sort_by(|a, b| b.1 .1.total_cmp(&a.1 .1).then_with(|| a.0.cmp(b.0)));
    sites
        .into_iter()
        .map(|(site, (cookies, _))| CookieSite {
            site: site.to_string(),
            cookies,
        })
        .collect()
}

fn hosts(rows: &[Row]) -> HashSet<String> {
    rows.iter().map(|row| normal(&row.host)).collect()
}

/// A table's column names, so a reader can adapt to a browser's schema version.
/// `table` is a fixed name a reader passes, never a value from IPC.
async fn columns(db: &mut SqliteConnection, table: &str) -> Result<Vec<String>> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(db)
        .await?;
    Ok(rows
        .iter()
        .filter_map(|r| r.try_get::<String, _>("name").ok())
        .collect())
}

/// A host key as a host: `.example.com` (a domain cookie's) is `example.com`.
fn normal(host: &str) -> String {
    host.trim_start_matches('.').to_ascii_lowercase()
}

/// The site `host`'s cookies are listed under: the shortest of its parents that
/// has cookies of its own, or itself. A browser refuses a cookie for a public
/// suffix (`co.uk`, `github.io`), so no such suffix is ever among the hosts, and
/// unrelated sites are never lumped together — without the suffix list.
fn site_of<'a>(host: &'a str, hosts: &HashSet<String>) -> &'a str {
    let mut site = host;
    // Each suffix is shorter than the one before: the last one with cookies wins.
    for (dot, _) in host.match_indices('.') {
        let parent = &host[dot + 1..];
        if hosts.contains(parent) {
            site = parent;
        }
    }
    site
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

/// A browser's cookie file copied into a private temporary folder, with the
/// journal or write-ahead log that holds its latest writes. Removed when dropped.
struct Copy {
    dir: tempfile::TempDir,
    file: PathBuf,
}

impl Copy {
    fn of(file: &Path) -> Result<Self> {
        let name = file
            .file_name()
            .ok_or_else(|| anyhow!("a cookie file has no name"))?;
        // Owner-only, like every folder `tempfile` makes: the copy holds what the
        // browser's file does.
        let dir = tempfile::Builder::new()
            .prefix("santree-cookies")
            .tempdir()?;
        let copy = dir.path().join(name);
        std::fs::copy(file, &copy).context("couldn't copy the browser's cookie file")?;
        for suffix in ["-wal", "-journal"] {
            let mut side = file.as_os_str().to_owned();
            side.push(suffix);
            let mut copied = copy.as_os_str().to_owned();
            copied.push(suffix);
            // Missing is normal: the browser isn't writing just now.
            let _ = std::fs::copy(&side, &copied);
        }
        Ok(Self { dir, file: copy })
    }

    async fn open(&self) -> Result<SqliteConnection> {
        // Writable, because the copy is ours: SQLite may have to finish or roll
        // back what the browser was writing when it was copied.
        SqliteConnectOptions::new()
            .filename(&self.file)
            .connect()
            .await
            .context("couldn't open the copy of the browser's cookies")
    }
}

impl Drop for Copy {
    fn drop(&mut self) {
        // `TempDir` removes the folder itself; this only keeps the field read.
        let _ = self.dir.path();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subdomains_are_listed_under_the_shortest_host_with_cookies_of_its_own() {
        let hosts: HashSet<String> = [
            "github.com",
            "gist.github.com",
            "api.github.com",
            "accounts.google.com",
            "mail.google.com",
            "news.bbc.co.uk",
            "alice.github.io",
            "bob.github.io",
            "127.0.0.1",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        let cases = [
            ("gist.github.com", "github.com"),
            ("github.com", "github.com"),
            // No cookie of google.com itself: each subdomain stands alone.
            ("mail.google.com", "mail.google.com"),
            ("news.bbc.co.uk", "news.bbc.co.uk"),
            // github.io is a public suffix, so it never has cookies to group under.
            ("alice.github.io", "alice.github.io"),
            ("127.0.0.1", "127.0.0.1"),
        ];
        for (host, site) in cases {
            assert_eq!(site_of(host, &hosts), site, "{host}");
        }
    }

    #[test]
    fn a_source_is_found_only_by_an_id_discovery_gave_it() {
        let support = tempfile::tempdir().unwrap();
        let chrome = support.path().join("Google/Chrome");
        std::fs::create_dir_all(chrome.join("Profile 1")).unwrap();
        std::fs::write(chrome.join("Profile 1/Cookies"), b"").unwrap();
        std::fs::create_dir_all(chrome.join("Guest Profile")).unwrap();
        std::fs::write(chrome.join("Guest Profile/Cookies"), b"").unwrap();
        std::fs::write(
            chrome.join("Local State"),
            r#"{"profile":{"info_cache":{"Profile 1":{"name":"Work"}}}}"#,
        )
        .unwrap();

        let found = sources(support.path());
        assert_eq!(
            found,
            vec![CookieSource {
                id: "chrome/Profile 1".into(),
                browser: "Chrome".into(),
                profile: None,
                keychain: true,
            }]
        );
        assert!(find(support.path(), "chrome/Profile 1").is_ok());
        for id in [
            "chrome/Guest Profile",
            "chrome/../Chrome/Profile 1",
            "chrome/",
            "",
        ] {
            assert!(find(support.path(), id).is_err(), "{id}");
        }
    }
}
