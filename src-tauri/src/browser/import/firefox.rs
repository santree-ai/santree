//! Firefox's cookies. Firefox keeps them in plain text in `cookies.sqlite`
//! (table `moz_cookies`), so there is no key and no Keychain prompt — the file is
//! copied and read like any other.

use std::path::{Path, PathBuf};

use anyhow::Result;
use sqlx::{Row as _, SqliteConnection};

use super::{CookieSource, Profile, Row, SameSite, Value};

/// Every Firefox profile with a cookie store under `support`.
pub fn profiles(support: &Path) -> Vec<Profile> {
    let root = support.join("Firefox/Profiles");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut found: Vec<(String, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|dir| {
            let file = dir.join("cookies.sqlite");
            file.is_file().then(|| {
                let folder = dir
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                (folder, file)
            })
        })
        .collect();
    found.sort();
    let many = found.len() > 1;
    found
        .into_iter()
        .map(|(folder, file)| Profile {
            source: CookieSource {
                id: format!("firefox/{folder}"),
                browser: "Firefox".to_string(),
                // A folder is named like `8f3k2a1z.default-release`; the part
                // after the dot is what the user would recognise.
                profile: many.then(|| {
                    folder
                        .split_once('.')
                        .map_or(folder.clone(), |(_, name)| name.to_string())
                }),
                keychain: false,
            },
            file,
            browser: super::Browser::Firefox,
        })
        .collect()
}

/// Firefox's cookies. Cookies in a container or set inside another site's frame
/// (a non-empty `originAttributes`) are left out — no tab here sends them.
pub async fn rows(db: &mut SqliteConnection) -> Result<Vec<Row>> {
    let rows = sqlx::query(
        "SELECT host, name, value, path, expiry, lastAccessed, isSecure, isHttpOnly, sameSite \
         FROM moz_cookies WHERE originAttributes = ''",
    )
    .fetch_all(&mut *db)
    .await?;
    Ok(rows
        .iter()
        .map(|r| {
            let expiry: i64 = r.try_get("expiry").unwrap_or(0);
            Row {
                host: r.try_get("host").unwrap_or_default(),
                name: r.try_get("name").unwrap_or_default(),
                value: Value::Plain(r.try_get("value").unwrap_or_default()),
                path: r.try_get("path").unwrap_or_default(),
                // `expiry` is already seconds since 1970; 0 is a session cookie.
                expires: (expiry != 0).then_some(expiry as f64),
                // `lastAccessed` is microseconds since 1970.
                used: r.try_get::<i64, _>("lastAccessed").unwrap_or(0) as f64 / 1_000_000.0,
                secure: r.try_get::<i64, _>("isSecure").unwrap_or(0) != 0,
                http_only: r.try_get::<i64, _>("isHttpOnly").unwrap_or(0) != 0,
                same_site: match r.try_get::<i64, _>("sameSite").unwrap_or(0) {
                    1 => Some(SameSite::Lax),
                    2 => Some(SameSite::Strict),
                    _ => None,
                },
            }
        })
        .collect())
}
