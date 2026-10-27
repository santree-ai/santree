//! A Chromium-family browser's cookies (Chrome, Arc, Brave, Edge, Vivaldi,
//! Opera, Chromium). Each value is encrypted: on macOS the browser derives an
//! AES-128-CBC key from a random secret it keeps in the login Keychain under
//! "<Browser> Safe Storage", and santree's import derives the same key to read
//! the values it copies. The derivation is Chromium's, fixed for years
//! (PBKDF2-HMAC-SHA1, salt "saltysalt", 1003 rounds, 16-byte key, a 16-space IV).

use std::num::NonZeroU32;
use std::path::{Path, PathBuf};

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, KeyIvInit};
use anyhow::{Context, Result};
use serde::Deserialize;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, Row as _, SqliteConnection};

use super::{CookieSource, Profile, Row, SameSite, Value};

/// A Chromium-family browser as it is laid out on this Mac.
pub struct Browser {
    /// Short id, first half of a source's id (`chrome/Profile 1`).
    id: &'static str,
    /// What the user calls it.
    name: &'static str,
    /// Its user-data folder under `~/Library/Application Support`.
    dir: &'static str,
    /// The Keychain service its cookie secret is stored under.
    safe_storage: &'static str,
    /// That Keychain item's account.
    account: &'static str,
    /// Its cookies sit straight in the user-data folder, not in a `Profile N`
    /// subfolder (Opera).
    single_profile: bool,
}

/// The browsers the import knows, with where each keeps its things. Agent-vendor
/// web sessions are never a reason to add one here, but nothing about this list
/// excludes a site — the user picks the sites, and the rule that keeps a vendor's
/// cookie out is `super`'s, not this.
static BROWSERS: &[Browser] = &[
    Browser {
        id: "chrome",
        name: "Chrome",
        dir: "Google/Chrome",
        safe_storage: "Chrome Safe Storage",
        account: "Chrome",
        single_profile: false,
    },
    Browser {
        id: "arc",
        name: "Arc",
        dir: "Arc/User Data",
        safe_storage: "Arc Safe Storage",
        account: "Arc",
        single_profile: false,
    },
    Browser {
        id: "brave",
        name: "Brave",
        dir: "BraveSoftware/Brave-Browser",
        safe_storage: "Brave Safe Storage",
        account: "Brave",
        single_profile: false,
    },
    Browser {
        id: "edge",
        name: "Microsoft Edge",
        dir: "Microsoft Edge",
        safe_storage: "Microsoft Edge Safe Storage",
        account: "Microsoft Edge",
        single_profile: false,
    },
    Browser {
        id: "vivaldi",
        name: "Vivaldi",
        dir: "Vivaldi",
        safe_storage: "Vivaldi Safe Storage",
        account: "Vivaldi",
        single_profile: false,
    },
    Browser {
        id: "chromium",
        name: "Chromium",
        dir: "Chromium",
        safe_storage: "Chromium Safe Storage",
        account: "Chromium",
        single_profile: false,
    },
    Browser {
        id: "opera",
        name: "Opera",
        dir: "com.operasoftware.Opera",
        safe_storage: "Opera Safe Storage",
        account: "Opera",
        single_profile: true,
    },
];

/// Every importable profile of every known Chromium browser found under
/// `support`.
pub fn profiles(support: &Path) -> Vec<Profile> {
    let mut out = Vec::new();
    for browser in BROWSERS {
        let root = support.join(browser.dir);
        if !root.is_dir() {
            continue;
        }
        let names = profile_names(&root);
        let dirs = if browser.single_profile {
            vec![root.clone()]
        } else {
            profile_dirs(&root)
        };
        // Each browser's profiles are collected first, so a profile's display
        // name is set only when the browser has more than one to tell apart.
        let mut found: Vec<(String, PathBuf)> = Vec::new();
        for dir in dirs {
            if let Some(file) = cookie_file(&dir) {
                let folder = dir
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                found.push((folder, file));
            }
        }
        let many = found.len() > 1;
        for (folder, file) in found {
            out.push(Profile {
                source: CookieSource {
                    id: format!("{}/{}", browser.id, folder),
                    browser: browser.name.to_string(),
                    profile: many.then(|| {
                        names
                            .get(&folder)
                            .cloned()
                            .unwrap_or_else(|| folder.clone())
                    }),
                    keychain: true,
                },
                file,
                browser: super::Browser::Chromium(browser),
            });
        }
    }
    out
}

/// The profile folders of a user-data dir — `Default` and `Profile N`, never the
/// `Guest`/`System` profiles, which hold no login worth importing.
fn profile_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| match p.file_name().and_then(|n| n.to_str()) {
            Some("Default") => true,
            Some(name) => name.starts_with("Profile "),
            None => false,
        })
        .collect();
    dirs.sort();
    dirs
}

/// A profile's cookie file: the newer `Network/Cookies`, else the older `Cookies`.
fn cookie_file(dir: &Path) -> Option<PathBuf> {
    [dir.join("Network/Cookies"), dir.join("Cookies")]
        .into_iter()
        .find(|p| p.is_file())
}

#[derive(Deserialize)]
struct LocalState {
    profile: Option<ProfileInfo>,
}
#[derive(Deserialize)]
struct ProfileInfo {
    info_cache: Option<std::collections::HashMap<String, ProfileEntry>>,
}
#[derive(Deserialize)]
struct ProfileEntry {
    name: Option<String>,
}

/// Each profile folder's display name, from the user-data dir's `Local State`.
fn profile_names(root: &Path) -> std::collections::HashMap<String, String> {
    let Ok(text) = std::fs::read_to_string(root.join("Local State")) else {
        return Default::default();
    };
    let Ok(state) = serde_json::from_str::<LocalState>(&text) else {
        return Default::default();
    };
    state
        .profile
        .and_then(|p| p.info_cache)
        .map(|cache| {
            cache
                .into_iter()
                .filter_map(|(folder, entry)| entry.name.map(|name| (folder, name)))
                .collect()
        })
        .unwrap_or_default()
}

/// The browser's cookies, encrypted values still encrypted. Partitioned cookies
/// (set inside another site's frame) are left out — no tab here sends them.
pub async fn rows(db: &mut SqliteConnection) -> Result<Vec<Row>> {
    let columns = super::columns(db, "cookies").await?;
    let partition = columns.iter().any(|c| c == "top_frame_site_key");
    let mut sql = String::from(
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, \
         last_access_utc, is_secure, is_httponly, samesite, is_persistent FROM cookies",
    );
    if partition {
        sql.push_str(" WHERE top_frame_site_key = ''");
    }
    let rows = sqlx::query(&sql).fetch_all(&mut *db).await?;
    Ok(rows
        .iter()
        .map(|r| {
            let encrypted: Vec<u8> = r.try_get("encrypted_value").unwrap_or_default();
            let plain: String = r.try_get("value").unwrap_or_default();
            let persistent: i64 = r.try_get("is_persistent").unwrap_or(1);
            let expires: i64 = r.try_get("expires_utc").unwrap_or(0);
            Row {
                host: r.try_get("host_key").unwrap_or_default(),
                name: r.try_get("name").unwrap_or_default(),
                value: if encrypted.is_empty() {
                    Value::Plain(plain)
                } else {
                    Value::Encrypted(encrypted)
                },
                path: r.try_get("path").unwrap_or_default(),
                expires: (persistent != 0 && expires != 0).then(|| chromium_time(expires)),
                used: chromium_time(r.try_get("last_access_utc").unwrap_or(0)),
                secure: r.try_get::<i64, _>("is_secure").unwrap_or(0) != 0,
                http_only: r.try_get::<i64, _>("is_httponly").unwrap_or(0) != 0,
                same_site: match r.try_get::<i64, _>("samesite").unwrap_or(-1) {
                    1 => Some(SameSite::Lax),
                    2 => Some(SameSite::Strict),
                    _ => None,
                },
            }
        })
        .collect())
}

/// The cookie store's schema version, which decides whether a decrypted value
/// carries the host-hash prefix below.
pub async fn version(file: &Path) -> Result<i64> {
    // Read-only and immutable: a quick scalar from the live file without taking
    // the browser's lock or reading its write-ahead log.
    let mut db = SqliteConnectOptions::new()
        .filename(file)
        .read_only(true)
        .immutable(true)
        .connect()
        .await?;
    let version: i64 = sqlx::query_scalar("SELECT value FROM meta WHERE key = 'version'")
        .fetch_optional(&mut db)
        .await?
        .unwrap_or(0);
    Ok(version)
}

/// Chromium's microseconds-since-1601 as seconds since 1970.
fn chromium_time(micros: i64) -> f64 {
    micros as f64 / 1_000_000.0 - 11_644_473_600.0
}

/// The AES-128 key a browser's cookies are encrypted under, derived from its
/// Keychain secret the way the browser derives it.
pub struct Key([u8; 16]);

impl Key {
    /// Read the browser's "Safe Storage" secret from the login Keychain (macOS
    /// asks the user to allow it) and derive the key.
    pub fn from_keychain(browser: &Browser) -> Result<Self> {
        let secret = security_framework::passwords::get_generic_password(
            browser.safe_storage,
            browser.account,
        )
        .with_context(|| {
            format!(
                "couldn't read {}'s cookie key from the Keychain",
                browser.name
            )
        })?;
        let mut key = [0u8; 16];
        ring::pbkdf2::derive(
            ring::pbkdf2::PBKDF2_HMAC_SHA1,
            NonZeroU32::new(1003).expect("1003 is non-zero"),
            b"saltysalt",
            &secret,
            &mut key,
        );
        Ok(Self(key))
    }

    /// One `encrypted_value` as its plaintext, or `None` if it isn't in the
    /// macOS `v10` form or the key doesn't fit it (a cookie the browser wrote
    /// under a key santree can't read — counted as skipped, never guessed at).
    pub fn decrypt(&self, host: &str, encrypted: &[u8], version: i64) -> Option<String> {
        let body = encrypted.strip_prefix(b"v10")?;
        type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;
        let mut buf = body.to_vec();
        let plain = Aes128CbcDec::new(&self.0.into(), &[b' '; 16].into())
            .decrypt_padded_mut::<Pkcs7>(&mut buf)
            .ok()?;
        // Version 24 on, Chromium prefixes the plaintext with SHA-256 of the host
        // key and binds the value to it; the prefix isn't part of the value.
        let plain = if version >= 24 {
            let (prefix, value) = plain.split_at_checked(32)?;
            // A wrong key decrypts to noise whose prefix won't match — so this
            // drops a mis-decrypted cookie instead of importing garbage.
            if prefix != host_hash(host).as_slice() {
                return None;
            }
            value
        } else {
            plain
        };
        String::from_utf8(plain.to_vec()).ok()
    }
}

/// SHA-256 of the cookie's host key — the prefix a v24+ plaintext carries.
fn host_hash(host: &str) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(host.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_default_and_numbered_profiles_with_a_cookie_file_are_offered() {
        let root = tempfile::tempdir().unwrap();
        for name in ["Default", "Profile 1", "Guest Profile", "System Profile"] {
            std::fs::create_dir_all(root.path().join(name).join("Network")).unwrap();
            std::fs::write(root.path().join(name).join("Network/Cookies"), b"").unwrap();
        }
        // A profile folder without a cookie file yet (never opened) is left out.
        std::fs::create_dir_all(root.path().join("Profile 2")).unwrap();

        let mut dirs: Vec<String> = profile_dirs(root.path())
            .iter()
            .filter(|d| cookie_file(d).is_some())
            .map(|d| d.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        dirs.sort();
        assert_eq!(dirs, vec!["Default".to_string(), "Profile 1".to_string()]);
    }

    #[test]
    fn a_profile_is_named_only_when_a_browser_has_more_than_one() {
        let support = tempfile::tempdir().unwrap();
        let chrome = support.path().join("Google/Chrome");
        for folder in ["Default", "Profile 1"] {
            std::fs::create_dir_all(chrome.join(folder)).unwrap();
            std::fs::write(chrome.join(folder).join("Cookies"), b"").unwrap();
        }
        std::fs::write(
            chrome.join("Local State"),
            r#"{"profile":{"info_cache":{"Default":{"name":"Personal"},"Profile 1":{"name":"Work"}}}}"#,
        )
        .unwrap();

        let got: Vec<(String, Option<String>)> = profiles(support.path())
            .into_iter()
            .map(|p| (p.source.id, p.source.profile))
            .collect();
        assert_eq!(
            got,
            vec![
                ("chrome/Default".to_string(), Some("Personal".to_string())),
                ("chrome/Profile 1".to_string(), Some("Work".to_string())),
            ]
        );
    }
}
