//! Signing in to Linear's hosted MCP server, and staying signed in.
//!
//! A workspace that blocks santree's OAuth app can still approve Linear's own
//! MCP server, whose authorization server lets a client register itself. The
//! PKCE flow, the callback listener, the keychain store and the refresh locks
//! are `oauth.rs`'s. What is this server's own: a client registered on every
//! connect, the RFC 8707 `resource` on every authorize and token request, and a
//! grant that only the client it was issued to can refresh or revoke.

use anyhow::{anyhow, bail, Context, Result};
use santree_core::domain::{LinearConnection, LinearOrg};
use serde::Deserialize;

use super::client::{self, Effect};
use crate::db::{now_ms, Db};
use crate::gql;
use crate::linear::{self, OrgRow};
use crate::oauth::{self, GrantedScope, Tokens};

const REGISTER_URL: &str = "https://mcp.linear.app/register";
const AUTHORIZE_URL: &str = "https://mcp.linear.app/authorize";
/// Also where a grant is revoked: the server's metadata names the same url.
const TOKEN_URL: &str = "https://mcp.linear.app/token";

/// The MCP server's canonical URI — the `resource` every authorize and token
/// request names, and the endpoint [`client`] posts to.
pub(crate) const RESOURCE: &str = "https://mcp.linear.app/mcp";

/// The keychain namespace for MCP credentials: `linear-mcp:{slug}`, never
/// `linear:{slug}`.
pub(crate) const KEYCHAIN: &str = "linear-mcp";

/// Connect a workspace through the MCP server: register a client, run the
/// browser sign-in, learn which workspace the grant is for, and store the org.
/// Returns the updated org list, as `linear::connect` does.
pub async fn connect(db: &Db) -> Result<Vec<LinearOrg>> {
    let redirect_uri = format!("http://localhost:{}", oauth::OAUTH_PORT);
    let client_id = register(&redirect_uri).await?;

    let verifier = oauth::b64url(&oauth::random_bytes(32));
    let challenge = oauth::pkce_challenge(&verifier);
    let state = oauth::hex(&oauth::random_bytes(16));
    let requested = linear::requested_scope(db).await?;
    let scope = mcp_scope(requested);
    let params = [
        ("client_id", client_id.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("response_type", "code"),
        ("scope", scope.as_str()),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("resource", RESOURCE),
    ];
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={}", oauth::urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    oauth::open_browser(&format!("{AUTHORIZE_URL}?{query}"));

    let expected_state = state.clone();
    let code = tokio::task::spawn_blocking(move || oauth::wait_for_code(&expected_state, "Linear"))
        .await
        .context("oauth listener task")??;

    let body = oauth::token_request(
        TOKEN_URL,
        &[
            ("grant_type", "authorization_code"),
            ("client_id", client_id.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", verifier.as_str()),
            ("resource", RESOURCE),
        ],
        "Linear MCP token exchange",
    )
    .await?;
    let expires_at = now_ms() + body.expires_in * 1000;
    // Without a `scope` in the response, record what was asked for rather than
    // nothing: an empty scope string reads as writable (legacy OAuth orgs).
    // An empty granted scope says no more than a missing one, and must not be
    // stored: an empty string reads as writable (legacy OAuth orgs).
    let scopes = body
        .scope
        .as_ref()
        .map(GrantedScope::as_csv)
        .filter(|granted| !granted.is_empty())
        .unwrap_or_else(|| requested.to_string());
    let tokens = Tokens {
        access: body.access_token,
        refresh: body.refresh_token,
    };

    let (slug, name) = match workspace(&tokens.access).await {
        Ok(found) => found,
        Err(e) => {
            revoke(&client_id, &tokens).await;
            return Err(e);
        }
    };

    let replaced = match linear::org_row(db, &slug).await? {
        // The normal connection reaches everything this one does and more, so an
        // org that has it is never moved onto this one.
        Some(prior) if prior.connection() == LinearConnection::OAuth => {
            revoke(&client_id, &tokens).await;
            bail!(
                "{} is already connected through santree's OAuth app, with full access. There is nothing to add through the MCP server.",
                prior.name
            );
        }
        // Reconnecting replaces the grant. Hold on to the old one so it can be
        // revoked once the new one is stored, rather than left live for a day.
        Some(prior) => oauth::load_tokens(KEYCHAIN, &slug)
            .await
            .ok()
            .flatten()
            .zip(prior.mcp_client_id),
        None => None,
    };

    let org = OrgRow {
        slug,
        name,
        expires_at,
        scopes,
        auth: linear::AUTH_MCP.into(),
        mcp_client_id: Some(client_id.clone()),
    };
    if !linear::upsert_mcp_org(db, &org, tokens).await? {
        // Connected through the OAuth app while the browser was open — that
        // connection wins, and the grant just stored under `linear-mcp:` goes.
        forget(&org.slug, Some(&client_id)).await;
        bail!(
            "{} was connected through santree's OAuth app while this sign-in was open, so it keeps full access. The MCP sign-in was discarded.",
            org.name
        );
    }
    if let Some((old_tokens, old_client)) = replaced {
        revoke(&old_client, &old_tokens).await;
    }
    linear::invalidate_org_caches(&org.slug);
    super::tracker::invalidate_org_caches(&org.slug);
    log::info!("connected Linear org {} through its MCP server", org.slug);
    linear::list_orgs(db).await
}

/// Register santree with the MCP server's authorization server (RFC 7591) and
/// return the client id. One per connect: nothing to keep valid across
/// installs, and the org row records which client its grant belongs to.
async fn register(redirect_uri: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Registered {
        client_id: String,
    }

    let res = gql::credential_client()
        .post(REGISTER_URL)
        .json(&serde_json::json!({
            "client_name": "santree",
            "client_uri": "https://santree.toscanini.me",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            // A desktop app can't keep a secret; PKCE is what protects the code.
            "token_endpoint_auth_method": "none",
        }))
        .send()
        .await
        .context("Linear MCP client registration request")?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(gql::http_error(
            "Linear MCP client registration",
            status,
            &body,
        ));
    }
    Ok(res
        .json::<Registered>()
        .await
        .context("decoding the Linear MCP client registration")?
        .client_id)
}

/// The workspace a fresh token belongs to, as `(slug, name)`.
async fn workspace(token: &str) -> Result<(String, String)> {
    #[derive(Deserialize)]
    struct Workspace {
        name: String,
        url: String,
    }

    let found: Workspace = client::call_with_token(
        None,
        token,
        "get_workspace",
        serde_json::json!({}),
        Effect::Read,
    )
    .await?;
    let slug = slug_from_workspace_url(&found.url).ok_or_else(|| {
        anyhow!(
            "Linear's MCP server named a workspace url santree doesn't recognise: {}",
            found.url
        )
    })?;
    Ok((slug, found.name))
}

/// The org slug in a workspace url like `https://linear.app/acme` — Linear's
/// `urlKey`, the slug the OAuth connection stores too, so a workspace connected
/// both ways is one row. Matched by parse, never by prefix:
/// `https://linear.app.example.com/acme` is not Linear.
fn slug_from_workspace_url(url: &str) -> Option<String> {
    let url = reqwest::Url::parse(url).ok()?;
    if url.scheme() != "https" || url.host_str() != Some("linear.app") {
        return None;
    }
    let slug = url.path_segments()?.find(|s| !s.is_empty())?;
    slug.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        .then(|| slug.to_string())
}

/// `linear_scope`'s request (`read` / `read,write`) in this server's spelling:
/// space-separated, as OAuth scopes are.
fn mcp_scope(requested: &str) -> String {
    requested.replace(',', " ")
}

/// A valid access token for the MCP org `slug`, refreshed under the org's lock
/// when it is near expiry.
pub(crate) async fn valid_token(db: &Db, slug: &str) -> Result<String> {
    let (row, tokens) = credentials(db, slug).await?;
    if oauth::usable_at(row.expires_at, now_ms()) {
        return Ok(tokens.access);
    }

    let lock = oauth::refresh_lock(KEYCHAIN, slug);
    let _guard = lock.lock().await;
    // Re-read the keychain, not just the row. The server rotates the refresh
    // token and briefly still accepts the old one — and a refresh with that old
    // one revokes the pair another caller stored while we waited (measured).
    let (row, tokens) = credentials(db, slug).await?;
    if oauth::usable_at(row.expires_at, now_ms()) {
        return Ok(tokens.access);
    }
    rotate(db, row, tokens).await
}

/// Mint a fresh access token regardless of the stored expiry, for when the
/// server rejected one the expiry said was good. `spent` is that token: if the
/// stored one differs, another caller already rotated it, and it is reused.
pub(crate) async fn force_refresh(db: &Db, slug: &str, spent: &str) -> Result<String> {
    let lock = oauth::refresh_lock(KEYCHAIN, slug);
    let _guard = lock.lock().await;
    let (row, tokens) = credentials(db, slug).await?;
    if tokens.access != spent {
        return Ok(tokens.access);
    }
    rotate(db, row, tokens).await
}

async fn credentials(db: &Db, slug: &str) -> Result<(OrgRow, Tokens)> {
    let row = linear::org_row(db, slug)
        .await?
        .ok_or_else(|| anyhow!("org {slug} not connected"))?;
    if row.connection() != LinearConnection::Mcp {
        bail!("org {slug} isn't connected through Linear's MCP server");
    }
    let tokens = oauth::load_tokens(KEYCHAIN, slug).await?.ok_or_else(|| {
        anyhow!(
            "no Linear MCP credential for {} in the OS keychain. Reconnect it from Settings → Integrations.",
            row.name
        )
    })?;
    Ok((row, tokens))
}

/// Spend the refresh token for a fresh pair and persist it. The caller holds the
/// org's refresh lock.
async fn rotate(db: &Db, row: OrgRow, tokens: Tokens) -> Result<String> {
    let client_id = row.mcp_client_id.clone().ok_or_else(|| {
        anyhow!(
            "{} has no MCP client on record. Reconnect it from Settings → Integrations.",
            row.name
        )
    })?;
    let refreshed = oauth::token_request(
        TOKEN_URL,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", tokens.refresh.as_str()),
            ("resource", RESOURCE),
        ],
        "Linear MCP token refresh",
    )
    .await;
    let body = match refreshed {
        Ok(body) => body,
        Err(e) if oauth::token_error_code(&e) == Some("invalid_grant") => {
            // Measured: the server can refuse a refresh token long before its
            // access token would have expired (docs/linear-mcp.md, "Measured").
            // When it happens decides whether reconnecting is rare or daily, so
            // the log says when — never the token.
            log::warn!(
                "Linear's MCP server refused the refresh token for org {} ({}); it needs reconnecting",
                row.slug,
                access_expiry_note(row.expires_at, now_ms())
            );
            bail!(
                "Linear's MCP sign-in for {} has expired. Reconnect it from Settings → Integrations.",
                row.name
            );
        }
        Err(e) => return Err(e),
    };
    // As at connect: an empty granted scope keeps what was recorded.
    let scopes = body
        .scope
        .as_ref()
        .map(GrantedScope::as_csv)
        .filter(|granted| !granted.is_empty())
        .unwrap_or_else(|| row.scopes.clone());
    let updated = OrgRow {
        expires_at: now_ms() + body.expires_in * 1000,
        scopes,
        ..row
    };
    let rotated = Tokens {
        access: body.access_token,
        refresh: body.refresh_token,
    };
    if !linear::upsert_mcp_org(db, &updated, rotated.clone()).await? {
        forget(&updated.slug, Some(&client_id)).await;
        bail!(
            "{} is connected through santree's OAuth app now",
            updated.name
        );
    }
    Ok(rotated.access)
}

/// Where the grant's access token stood when its refresh token was refused.
fn access_expiry_note(expires_at: i64, now: i64) -> String {
    let minutes = (expires_at - now).abs() / 60_000;
    if expires_at <= now {
        format!("its access token expired {minutes} min earlier")
    } else {
        format!("its access token had {minutes} min left")
    }
}

/// Revoke a grant (RFC 7009): the refresh token first, then the access token.
/// Best effort — it runs after the credential was already replaced or refused,
/// so a failure only logs.
async fn revoke(client_id: &str, tokens: &Tokens) {
    for (hint, token) in [
        ("refresh_token", &tokens.refresh),
        ("access_token", &tokens.access),
    ] {
        let res = gql::credential_client()
            .post(TOKEN_URL)
            .form(&[
                ("token", token.as_str()),
                ("token_type_hint", hint),
                ("client_id", client_id),
            ])
            .send()
            .await;
        match res {
            Ok(res) if res.status().is_success() => {}
            Ok(res) => log::warn!(
                "Linear's MCP server answered {} to revoking a {hint}",
                res.status()
            ),
            Err(e) => log::warn!("couldn't reach Linear's MCP server to revoke a {hint}: {e}"),
        }
    }
}

/// Drop an org's MCP credential once the org is connected another way: revoke
/// the grant, then remove the keychain entry. Best effort, like [`revoke`] — the
/// new row is already stored, so a failure leaves a dead entry at worst.
pub(crate) async fn forget(slug: &str, client_id: Option<&str>) {
    match oauth::load_tokens(KEYCHAIN, slug).await {
        Ok(Some(tokens)) => {
            if let Some(client_id) = client_id {
                revoke(client_id, &tokens).await;
            }
        }
        Ok(None) => {}
        Err(e) => log::warn!("reading the replaced MCP credential for org {slug}: {e:#}"),
    }
    if let Err(e) = oauth::delete_tokens(KEYCHAIN, slug).await {
        log::warn!("removing the replaced MCP credential for org {slug}: {e:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_workspace_slug_comes_from_a_linear_url_only() {
        assert_eq!(
            slug_from_workspace_url("https://linear.app/getsentry").as_deref(),
            Some("getsentry")
        );
        assert_eq!(
            slug_from_workspace_url("https://linear.app/acme-co/").as_deref(),
            Some("acme-co")
        );
        for rejected in [
            "https://linear.app.example.com/acme",
            "https://example.com/linear.app/acme",
            "https://evil.linear.app/acme",
            "http://linear.app/acme",
            "https://linear.app/",
            "https://linear.app",
            "https://linear.app/acme%2F..",
            "not a url",
        ] {
            assert_eq!(slug_from_workspace_url(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn the_requested_scope_is_space_separated_for_the_mcp_server() {
        assert_eq!(mcp_scope("read"), "read");
        assert_eq!(mcp_scope("read,write"), "read write");
    }

    #[test]
    fn a_refused_refresh_says_where_the_access_token_stood() {
        let now = 1_700_000_000_000;
        assert_eq!(
            access_expiry_note(now + 90 * 60_000, now),
            "its access token had 90 min left"
        );
        assert_eq!(
            access_expiry_note(now - 15 * 60_000, now),
            "its access token expired 15 min earlier"
        );
    }
}
