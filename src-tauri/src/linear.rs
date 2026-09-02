//! Linear integration: multi-org token store (OS keychain), OAuth PKCE connect
//! flow, and the GraphQL fetch that turns assigned issues into a positioned
//! dependency graph. OAuth tokens live in the OS keychain; the org's non-secret
//! metadata and the repo↔org links live in the app database; pure mapping and
//! layout live in `santree_core`.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use futures::future::join_all;
use futures::StreamExt;
use rand::RngCore;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use santree_core::domain::{
    ApiBudgetKind, ApiBudgetWindow, CycleRef, LinearApiBudget, LinearOrg, LinearStatus,
    ProjectMilestoneRef, Task, TaskStatus, TicketRef, TriageComment, TriageDetail, TriageSchedule,
    TriageShift, TriageTicket, WorkflowState,
};
use santree_core::{layout, linear as core_linear};

use crate::db::{now_ms, Db};
use crate::gql::{self, Connection};
use crate::settings;

const CLIENT_ID: &str = "4be2738749371d7d3401061aabe2d11b";
const AUTHORIZE_URL: &str = "https://linear.app/oauth/authorize";
const TOKEN_URL: &str = "https://api.linear.app/oauth/token";
const GRAPHQL_URL: &str = "https://api.linear.app/graphql";
const OAUTH_PORT: u16 = 8420;
const REFRESH_SKEW_MS: i64 = 5 * 60 * 1000;

/// The `settings` row (scope `"app"`) choosing what santree *asks* Linear for.
/// Absent = read-only. Write access must be an explicit user choice.
pub const LINEAR_SCOPE_KEY: &str = "linear_scope";

/// The OAuth scope string for a connection, from the [`LINEAR_SCOPE_KEY`] setting.
/// Only the exact UI value opts up; unset or malformed values fail closed so a
/// typo can never silently request permission to mutate Linear.
async fn requested_scope(db: &Db) -> Result<&'static str> {
    let raw = settings::get(db, "app", LINEAR_SCOPE_KEY).await?;
    Ok(scope_from_setting(raw.as_deref()))
}

fn scope_from_setting(raw: Option<&str>) -> &'static str {
    if raw == Some("read_write") {
        "read,write"
    } else {
        "read"
    }
}

/// Whether a stored scope string permits writes.
///
/// Empty means the org connected before santree recorded scopes — every one of
/// those went through the unconditional read,write flow, so treating them as
/// write-capable is the truthful reading, not a lenient default.
fn scopes_allow_write(scopes: &str) -> bool {
    scopes.is_empty() || scopes.split(',').any(|s| s.trim() == "write")
}

/// Whether santree may write to `slug` *right now*.
///
/// Two independent brakes: the workspace's own grant, and the user's read-only
/// mode. The mode counts here rather than only at connect time because a switch
/// that does nothing until you reconnect isn't a switch — flipping it has to
/// disable the writes on the connection you already have.
async fn can_write_to(db: &Db, slug: &str) -> Result<bool> {
    if read_only_mode(db).await? {
        return Ok(false);
    }
    let scopes = org_row(db, slug)
        .await?
        .map(|row| row.scopes)
        .unwrap_or_default();
    Ok(scopes_allow_write(&scopes))
}

/// Whether the user has put Linear in read-only mode.
async fn read_only_mode(db: &Db) -> Result<bool> {
    Ok(requested_scope(db).await? == "read")
}

// ── Org token store (OS keychain + SQLite metadata) ───────────────────────
//
// santree spawns agent CLIs as the same user, so anything readable from the
// user's filesystem is readable by a prompt-injected agent — the write-scoped
// Linear tokens therefore live in the OS keychain (macOS Keychain / freedesktop
// Secret Service), never on disk. SQLite keeps only non-secret metadata.

/// Keychain service name (the app's bundle id).
const KEYCHAIN_SERVICE: &str = "com.santree.desktop";

/// One keychain entry per org, holding *both* tokens as a single JSON blob:
/// Linear rotates the refresh token on every use, so the pair has to be written
/// atomically — and one entry means one keychain prompt instead of two.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Tokens {
    access: String,
    refresh: String,
}

/// An org's non-secret metadata. The tokens are *not* here — see [`Tokens`].
#[derive(sqlx::FromRow)]
struct OrgRow {
    slug: String,
    name: String,
    expires_at: i64,
    /// Comma-separated OAuth scopes Linear granted; see `scopes_allow_write`.
    scopes: String,
}

fn keychain_entry(slug: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("linear:{slug}")).map_err(keychain_err)
}

/// A keychain failure (locked keychain, no Secret Service on a headless box) must
/// surface as a real error — degrading it into "no tokens" would read as a
/// disconnected org, and falling back to plaintext storage is exactly what this
/// store exists to prevent.
fn keychain_err(e: keyring::Error) -> anyhow::Error {
    anyhow::Error::new(e)
        .context("the OS keychain is unavailable (santree keeps Linear tokens there)")
}

fn read_tokens_blocking(slug: &str) -> Result<Option<Tokens>> {
    match keychain_entry(slug)?.get_password() {
        Ok(blob) => decode_tokens(&blob).map(Some),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(keychain_err(e)),
    }
}

fn write_tokens_blocking(slug: &str, tokens: &Tokens) -> Result<()> {
    keychain_entry(slug)?
        .set_password(&encode_tokens(tokens)?)
        .map_err(keychain_err)
}

fn encode_tokens(tokens: &Tokens) -> Result<String> {
    serde_json::to_string(tokens).context("encoding the Linear credential")
}

fn decode_tokens(blob: &str) -> Result<Tokens> {
    serde_json::from_str(blob)
        .context("the stored Linear credential isn't in the expected format — reconnect the org")
}

/// The org's stored token pair, or `None` when the keychain has no entry for it.
/// Keychain calls block (they can even prompt), so they run off the async runtime.
async fn load_tokens(slug: &str) -> Result<Option<Tokens>> {
    let slug = slug.to_string();
    tokio::task::spawn_blocking(move || read_tokens_blocking(&slug))
        .await
        .context("keychain read")?
}

async fn save_tokens(slug: &str, tokens: Tokens) -> Result<()> {
    let slug = slug.to_string();
    tokio::task::spawn_blocking(move || write_tokens_blocking(&slug, &tokens))
        .await
        .context("keychain write")?
}

/// Every connected org as `(slug, name)`, ordered by name — the order the "first
/// org" fallback in [`resolved_org`] is defined against.
pub(crate) async fn orgs_by_name(db: &Db) -> Result<Vec<(String, String)>> {
    Ok(
        sqlx::query_as::<_, (String, String)>("SELECT slug, name FROM linear_orgs ORDER BY name")
            .fetch_all(db)
            .await?,
    )
}

/// Every connected org (slug + display name).
pub async fn list_orgs(db: &Db) -> Result<Vec<LinearOrg>> {
    // Read once for the whole list: the mode is app-wide, the grant is per-org.
    let read_only = read_only_mode(db).await?;
    // Its own query rather than `orgs_by_name`: that one feeds `resolved_org`, whose
    // (slug, name) shape several callers depend on.
    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT slug, name, scopes FROM linear_orgs ORDER BY name",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(slug, name, scopes)| LinearOrg {
            can_write: !read_only && scopes_allow_write(&scopes),
            slug,
            name,
        })
        .collect())
}

/// The org a repo resolves to, given every connected org and the repo's stored
/// link: that link when it still names a connected org, else the first org. The one
/// definition of the fallback — `resolve_org_slug` sends the repo's queries to this
/// org and `repo::list` labels the repo with it, so the two must not diverge (a repo
/// row reading "Linear · Acme" while every query went to another workspace).
pub(crate) fn resolved_org<'a>(
    orgs: &'a [(String, String)],
    linked: Option<&str>,
) -> Option<&'a (String, String)> {
    linked
        .and_then(|slug| orgs.iter().find(|(s, _)| s == slug))
        .or_else(|| orgs.first())
}

async fn org_row(db: &Db, slug: &str) -> Result<Option<OrgRow>> {
    Ok(sqlx::query_as::<_, OrgRow>(
        "SELECT slug, name, expires_at, scopes FROM linear_orgs WHERE slug = ?",
    )
    .bind(slug)
    .fetch_optional(db)
    .await?)
}

/// Persist an org: credential to the keychain, metadata to SQLite. Keychain
/// first — a metadata row we couldn't back with a credential would show up as a
/// connected org whose every call then fails.
async fn upsert_org(db: &Db, org: &OrgRow, tokens: Tokens) -> Result<()> {
    save_tokens(&org.slug, tokens).await?;
    sqlx::query(
        "INSERT INTO linear_orgs (slug, name, expires_at, scopes)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           name = excluded.name,
           expires_at = excluded.expires_at,
           scopes = excluded.scopes",
    )
    .bind(&org.slug)
    .bind(&org.name)
    .bind(org.expires_at)
    .bind(&org.scopes)
    .execute(db)
    .await?;
    Ok(())
}

/// Move any plaintext OAuth tokens an older build left in `linear_orgs` into the
/// keychain. Called once at startup *before* the migration that drops those
/// columns (a `.sql` migration can't reach a keychain), and idempotent: once the
/// columns are gone — fresh install, or an install that already migrated — it's a
/// no-op. Returns whether the db ever held plaintext tokens, so the caller can
/// scrub the pages they were freed from.
///
/// A keychain failure here is loud but not fatal: the columns are dropped either
/// way, so no token is ever left in plaintext. The user reconnects the org (one
/// click) once their keychain works.
pub(crate) async fn migrate_tokens_to_keychain(db: &Db) -> Result<bool> {
    let legacy_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('linear_orgs')
          WHERE name IN ('access_token', 'refresh_token')",
    )
    .fetch_one(db)
    .await?;
    if legacy_columns < 2 {
        return Ok(false);
    }

    let rows = sqlx::query_as::<_, (String, String, String)>(
        "SELECT slug, access_token, refresh_token FROM linear_orgs
          WHERE COALESCE(access_token, '') <> ''",
    )
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(false);
    }

    for (slug, access, refresh) in rows {
        match save_tokens(&slug, Tokens { access, refresh }).await {
            Ok(()) => log::info!("moved the Linear tokens for org {slug} into the OS keychain"),
            Err(e) => log::error!(
                "couldn't move the Linear tokens for org {slug} into the OS keychain ({e:#}); \
                 dropping them rather than leaving them in plaintext — reconnect the org in Settings"
            ),
        }
    }
    Ok(true)
}

/// The stored display name of a connected org — `None` when it isn't connected.
pub(crate) async fn connected_org_name(db: &Db, slug: &str) -> Result<Option<String>> {
    Ok(org_row(db, slug).await?.map(|r| r.name))
}

/// Import a Linear credential the santree CLI left in its global auth store.
///
/// The CLI's access token is typically long expired, so the stored pair is
/// validated by spending its refresh token for a fresh one (the CLI and the app
/// share an OAuth client, so the grant carries over) — a revoked or stale grant
/// fails here, before anything is persisted. The org is then resolved from the
/// fresh token rather than trusted from the CLI's files, and persisted exactly
/// like an OAuth connect (credential → keychain, metadata → SQLite).
pub(crate) async fn import_cli_credential(
    db: &Db,
    slug: &str,
    refresh_token: String,
) -> Result<LinearOrg> {
    // Serialize with any in-flight refresh of the same org — Linear invalidates
    // a refresh token the moment it's spent.
    let lock = refresh_lock(slug);
    let _guard = lock.lock().await;
    let body = token_request(
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token.as_str()),
        ],
        "santree CLI credential import",
    )
    .await
    .context("the santree CLI's Linear sign-in is no longer valid — connect Linear from Settings instead")?;

    let (slug, name) = fetch_viewer_org(&body.access_token).await?;
    let scopes = body
        .scope
        .as_ref()
        .map(GrantedScope::as_csv)
        .unwrap_or_default();
    upsert_org(
        db,
        &OrgRow {
            slug: slug.clone(),
            name: name.clone(),
            expires_at: now_ms() + body.expires_in * 1000,
            scopes: scopes.clone(),
        },
        Tokens {
            access: body.access_token,
            refresh: body.refresh_token,
        },
    )
    .await?;
    invalidate_org_caches(&slug);
    log::info!("imported the Linear credential for org {slug} from the santree CLI auth store");
    Ok(LinearOrg {
        can_write: scopes_allow_write(&scopes),
        slug,
        name,
    })
}

/// The org slug a repo should use — see [`resolved_org`].
async fn resolve_org_slug(db: &Db, repo: &str) -> Result<Option<String>> {
    let linked: Option<Option<String>> =
        sqlx::query_scalar("SELECT linear_org_slug FROM repos WHERE name = ?")
            .bind(repo)
            .fetch_optional(db)
            .await?;
    let orgs = orgs_by_name(db).await?;
    Ok(resolved_org(&orgs, linked.flatten().as_deref()).map(|(slug, _)| slug.clone()))
}

/// Bind (or clear, with `None`) the Linear org a repo uses. Updates the existing
/// repo row only — binding an org for an unregistered repo used to INSERT a
/// half-populated row (NULL path/tracker) that showed up as a phantom repo.
pub async fn set_repo_org(db: &Db, repo: &str, slug: Option<String>) -> Result<()> {
    let affected = sqlx::query("UPDATE repos SET linear_org_slug = ? WHERE name = ?")
        .bind(slug)
        .bind(repo)
        .execute(db)
        .await?
        .rows_affected();
    if affected == 0 {
        bail!("repo '{repo}' is not registered");
    }
    Ok(())
}

// ── Token refresh ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    /// What Linear actually granted. Deserialized permissively because the
    /// shape is the server's to choose: absent on some responses, a JSON list
    /// on others, a delimited string elsewhere. Guessing one and being wrong
    /// would make every connection look read-only.
    #[serde(default)]
    scope: Option<GrantedScope>,
}

/// Linear's `scope` field, in whichever shape it arrives.
#[derive(Deserialize)]
#[serde(untagged)]
enum GrantedScope {
    List(Vec<String>),
    Text(String),
}

impl GrantedScope {
    /// Normalized to the comma-separated form stored on the org row.
    fn as_csv(&self) -> String {
        match self {
            Self::List(items) => items.join(","),
            // Linear documents commas; OAuth generally uses spaces. Accept both.
            Self::Text(s) => s
                .split([',', ' '])
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(","),
        }
    }
}

/// POST the OAuth token endpoint (code exchange or refresh) and decode the token
/// pair. On failure Linear's *body* is what matters — `invalid_grant` (the grant is
/// gone; the org has to be reconnected) reads as the same bare 400 as a transient
/// server error — so it's preserved, exactly as `gql::post` does for GraphQL.
async fn token_request(form: &[(&str, &str)], what: &str) -> Result<TokenResponse> {
    let res = gql::client()
        .post(TOKEN_URL)
        .form(form)
        .send()
        .await
        .with_context(|| format!("{what} request"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(300).collect();
        bail!("{what} failed ({status}): {snippet}");
    }
    res.json()
        .await
        .with_context(|| format!("decoding the {what} response"))
}

/// Per-org locks serializing token refresh. Linear rotates the refresh token on
/// each use, so two commands refreshing the same org concurrently (Issues +
/// Triage both load on startup) would race: the second sends an already-consumed
/// token and fails — or both persist, last-writer-wins. We single-flight per slug.
static REFRESH_LOCKS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(Default::default);

fn refresh_lock(slug: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    // Poison-tolerant (matching the pty/openers/settings locks): the map holds
    // only Arcs, so a thread that panicked mid-access left it structurally sound.
    REFRESH_LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(slug.to_string())
        .or_default()
        .clone()
}

/// An org's metadata row paired with its keychain credential. A row with no
/// keychain entry means the credential was removed out from under us (keychain
/// reset, or a migration that couldn't reach it) — say so instead of reporting
/// the org as simply not connected.
async fn org_credentials(db: &Db, slug: &str) -> Result<(OrgRow, Tokens)> {
    let row = org_row(db, slug)
        .await?
        .ok_or_else(|| anyhow!("org {slug} not connected"))?;
    let tokens = load_tokens(slug).await?.ok_or_else(|| {
        anyhow!("no Linear credential for org {slug} in the OS keychain — reconnect it in Settings")
    })?;
    Ok((row, tokens))
}

/// Whether a token expiring at `expires_at` is still usable at `now`. The skew is
/// what stops a token that passes this check from expiring mid-flight; a call that
/// takes longer than [`REFRESH_SKEW_MS`] would fail either way.
fn usable_at(expires_at: i64, now: i64) -> bool {
    now < expires_at - REFRESH_SKEW_MS
}

/// A valid access token for `slug`, refreshing + persisting if near expiry.
async fn valid_token(db: &Db, slug: &str) -> Result<String> {
    let (row, tokens) = org_credentials(db, slug).await?;
    if usable_at(row.expires_at, now_ms()) {
        return Ok(tokens.access);
    }

    // Near expiry: serialize the refresh per org, then re-read — another caller
    // may have refreshed while we waited, so we'd reuse its fresh token. Re-reading
    // the *keychain* too (not just the row) is the load-bearing half: Linear rotates
    // the refresh token on every use, so the one we read before the lock is already
    // spent if someone else got there first.
    let lock = refresh_lock(slug);
    let _guard = lock.lock().await;
    let (row, tokens) = org_credentials(db, slug).await?;
    if usable_at(row.expires_at, now_ms()) {
        return Ok(tokens.access);
    }
    rotate(db, row, tokens).await
}

/// Mint a fresh access token for `slug` *regardless* of the stored expiry — for when
/// Linear rejects a token the expiry claimed was still good (see [`Session::query`]).
///
/// `spent` is the token that came back 401. Under the org's refresh lock we compare it
/// against what's on file: a concurrent caller may already have rotated it, and Linear
/// invalidates a refresh token the moment it's used, so re-spending ours would fail
/// *and* destroy the pair that other caller just persisted.
async fn force_refresh(db: &Db, slug: &str, spent: &str) -> Result<String> {
    let lock = refresh_lock(slug);
    let _guard = lock.lock().await;
    let (row, tokens) = org_credentials(db, slug).await?;
    if tokens.access != spent {
        return Ok(tokens.access);
    }
    rotate(db, row, tokens).await
}

/// Exchange the org's refresh token for a fresh pair, persist both, and return the new
/// access token. The caller holds the org's [`refresh_lock`] — Linear rotates the
/// refresh token on every use, so two concurrent exchanges would spend it twice.
async fn rotate(db: &Db, row: OrgRow, tokens: Tokens) -> Result<String> {
    let body = token_request(
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", tokens.refresh.as_str()),
        ],
        "Linear token refresh",
    )
    .await?;
    let updated = OrgRow {
        slug: row.slug,
        name: row.name,
        expires_at: now_ms() + body.expires_in * 1000,
        // A refresh response need not repeat the grant; keeping the recorded scopes
        // stops a routine token refresh from silently demoting the org to read-only.
        scopes: body
            .scope
            .as_ref()
            .map(GrantedScope::as_csv)
            .unwrap_or(row.scopes),
    };
    let rotated = Tokens {
        access: body.access_token,
        refresh: body.refresh_token,
    };
    upsert_org(db, &updated, rotated.clone()).await?;
    Ok(rotated.access)
}

// ── GraphQL fetch ────────────────────────────────────────────────────────

// `triage` is excluded alongside the terminal states: untriaged issues belong to
// the sidebar's Triage section, not the Issues dependency graph.
//
// NOTE: Linear caps query complexity at 10000. This query sits near that ceiling
// — `assignedIssues(first: 100)` × `inverseRelations(first: N)` × the per-issue
// fields (incl. `assignee`) is the dominant cost. Measured against the live API
// (2026-08-30, x-complexity header): `first: 12` on the relations costs 12351 —
// over the cap, a 400, and the graph goes empty — and each step of that `first`
// moves the total by ~940, so `first: 8` lands at 8591. Anyone adding a field
// here must re-measure; the cap failure is silent apart from the error toast.
// `dueDate` and `cycle { number name startsAt endsAt }` (2026-09-02) are on the top-level
// nodes only — a handful of scalars per issue, a few hundred against the ~1400
// of headroom, and deliberately not on the relation nodes, where every field is
// paid for eight times per issue.
//
// The blocker level carries the project's `targetDate` and its `projectMilestone`
// for a reason that isn't cosmetic: a ticket the viewer isn't assigned reaches the
// list ONLY through here, and without them its worktree renders a project band with
// no due chip and no milestone level at all (`map_related` had both hardcoded to
// `None`). If the cap ever does bite, this is the field set to trade away first.
const ASSIGNED_ISSUES_QUERY: &str = r#"
query AssignedIssues {
  viewer {
    assignedIssues(
      filter: { state: { type: { nin: ["triage", "completed", "canceled", "duplicate"] } } }
      orderBy: updatedAt
      first: 100
    ) {
      nodes {
        identifier
        title
        priority
        estimate dueDate
        cycle { number name startsAt endsAt }
        state { name type }
        project { name color icon targetDate }
        projectMilestone { id name targetDate sortOrder }
        parent { identifier }
        assignee { name displayName avatarUrl }
        inverseRelations(first: 8) {
          nodes {
            type
            issue { identifier title state { name type } project { name color icon targetDate } projectMilestone { id name targetDate sortOrder } assignee { name displayName avatarUrl } }
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}
"#;

#[derive(Deserialize)]
struct StateNode {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "type")]
    type_: String,
}
impl Default for StateNode {
    /// An issue that arrived without a state is treated as an unstarted "Unknown".
    fn default() -> Self {
        Self {
            id: None,
            name: "Unknown".into(),
            type_: "unstarted".into(),
        }
    }
}

#[derive(Deserialize)]
struct RelatedIssue {
    identifier: String,
    #[serde(default)]
    title: String,
    state: Option<StateNode>,
    #[serde(default)]
    project: Option<ProjectNode>,
    /// Explicitly renamed: unlike `IssueNode`/`TicketLookupNode` this struct has no
    /// `#[serde(rename_all = "camelCase")]`, so without it the wire's
    /// `projectMilestone` would quietly deserialize to `None` instead of failing.
    #[serde(default, rename = "projectMilestone")]
    project_milestone: Option<ProjectMilestoneNode>,
    #[serde(default)]
    assignee: Option<UserNode>,
}

#[derive(Deserialize)]
struct RelationNode {
    #[serde(default, rename = "type")]
    type_: String,
    /// The issue on the *other* side of an inverse relation (this issue's blocker).
    #[serde(default)]
    issue: Option<RelatedIssue>,
}

#[derive(Deserialize)]
struct ProjectNode {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default, rename = "targetDate")]
    target_date: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMilestoneNode {
    id: String,
    name: String,
    #[serde(default)]
    target_date: Option<String>,
    sort_order: f64,
}

#[derive(Deserialize)]
struct ParentIssueNode {
    identifier: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TicketLookupNode {
    identifier: String,
    title: String,
    priority: i64,
    #[serde(default)]
    project: Option<ProjectNode>,
    #[serde(default)]
    project_milestone: Option<ProjectMilestoneNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueNode {
    identifier: String,
    title: String,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    estimate: Option<f64>,
    #[serde(default)]
    due_date: Option<String>,
    #[serde(default)]
    cycle: Option<CycleNode>,
    state: Option<StateNode>,
    project: Option<ProjectNode>,
    #[serde(default)]
    project_milestone: Option<ProjectMilestoneNode>,
    #[serde(default)]
    parent: Option<ParentIssueNode>,
    #[serde(default)]
    assignee: Option<UserNode>,
    #[serde(default)]
    inverse_relations: Connection<RelationNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Viewer {
    assigned_issues: Connection<IssueNode>,
}
#[derive(Deserialize)]
struct QueryData {
    viewer: Viewer,
}

const TERMINAL_STATES: [&str; 3] = ["completed", "canceled", "duplicate"];

/// An assignee's `(name, avatar_url)` for a Task — the full name (falling back to
/// the @handle), and the avatar URL. `(None, None)` when unassigned.
fn assignee_fields(u: Option<UserNode>) -> (Option<String>, Option<String>) {
    match u {
        Some(u) => {
            let name = u
                .name
                .filter(|s| !s.is_empty())
                .or(u.display_name.filter(|s| !s.is_empty()));
            (name, u.avatar_url)
        }
        None => (None, None),
    }
}

/// A project's `(name, color, icon)` for a Task, defaulting the name when unset.
fn project_fields(
    p: Option<ProjectNode>,
) -> (String, Option<String>, Option<String>, Option<String>) {
    match p {
        Some(p) => (
            p.name.unwrap_or_else(|| "No Project".into()),
            p.color,
            p.icon,
            p.target_date,
        ),
        None => ("No Project".into(), None, None, None),
    }
}

fn project_milestone_ref(node: Option<ProjectMilestoneNode>) -> Option<ProjectMilestoneRef> {
    node.map(|node| ProjectMilestoneRef {
        id: node.id,
        name: node.name,
        target_date: node.target_date,
        sort_order: node.sort_order,
    })
}

/// An issue's cycle as Linear sends it (`number` is a Float there).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CycleNode {
    #[serde(default)]
    number: f64,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    ends_at: Option<String>,
    #[serde(default)]
    starts_at: Option<String>,
}

fn cycle_ref(node: Option<CycleNode>) -> Option<CycleRef> {
    node.map(|node| CycleRef {
        number: node.number,
        name: node.name,
        ends_at_ms: node.ends_at.as_deref().and_then(parse_ms).map(|v| v as f64),
        starts_at_ms: node
            .starts_at
            .as_deref()
            .and_then(parse_ms)
            .map(|v| v as f64),
    })
}

/// Map an assigned issue to an actionable Task, returning its blocker issues so
/// the caller can pull any that aren't themselves assigned into the graph as
/// grayed context nodes.
fn map_issue(node: IssueNode) -> (Task, Vec<RelatedIssue>) {
    let state = node.state.unwrap_or_default();
    let status: TaskStatus = core_linear::map_status(&state.name, &state.type_);

    // `inverseRelations` of type "blocks" point *at* this issue → its blockers.
    let mut blocked_by = Vec::new();
    let mut done_flags = Vec::new();
    let mut blockers = Vec::new();
    for rel in node.inverse_relations.nodes {
        if rel.type_ != "blocks" {
            continue;
        }
        if let Some(issue) = rel.issue {
            let state_type = issue
                .state
                .as_ref()
                .map(|s| s.type_.as_str())
                .unwrap_or_default();
            done_flags.push(TERMINAL_STATES.contains(&state_type));
            blocked_by.push(issue.identifier.clone());
            blockers.push(issue);
        }
    }

    let (project, project_color, project_icon, project_target_date) = project_fields(node.project);
    let project_milestone = project_milestone_ref(node.project_milestone);
    let parent_id = node.parent.map(|parent| parent.identifier);
    let (assignee, assignee_avatar_url) = assignee_fields(node.assignee);
    let task = Task {
        id: node.identifier,
        title: node.title,
        priority: core_linear::map_priority(node.priority),
        estimate: node.estimate,
        cycle: cycle_ref(node.cycle),
        due_date: node.due_date,
        project,
        project_color,
        project_icon,
        project_target_date,
        project_milestone,
        parent_id,
        status,
        // Ready only when all blockers are done *and* the work hasn't started
        // yet — an In Progress / In Review ticket is never "ready to start".
        ready: core_linear::is_ready(&done_flags) && status.is_startable(),
        blocked_by,
        actionable: true,
        assignee,
        assignee_avatar_url,
        x: 0,
        y: 0,
    };
    (task, blockers)
}

/// A blocker that isn't one of the viewer's assigned issues, mapped to a grayed,
/// non-actionable context node (no children — we don't recurse).
fn map_related(issue: RelatedIssue) -> Task {
    let state = issue.state.unwrap_or_default();
    let (project, project_color, project_icon, project_target_date) = project_fields(issue.project);
    let (assignee, assignee_avatar_url) = assignee_fields(issue.assignee);
    Task {
        id: issue.identifier,
        title: issue.title,
        priority: core_linear::map_priority(0),
        estimate: None,
        // Not fetched at the blocker level: neither groups anything, and a field
        // on a relation node costs eight times what it costs on the issue.
        cycle: None,
        due_date: None,
        project,
        project_color,
        project_icon,
        // A blocker still has to group like everything else: this is the only
        // path such a ticket takes into the list, so dropping its horizon here
        // is what left a coloured project band with no due chip and no
        // milestone level under it.
        project_target_date,
        project_milestone: project_milestone_ref(issue.project_milestone),
        parent_id: None,
        status: core_linear::map_status(&state.name, &state.type_),
        ready: false,
        blocked_by: vec![],
        actionable: false,
        assignee,
        assignee_avatar_url,
        x: 0,
        y: 0,
    }
}

/// Treat every known open subtask like a blocker of its parent. Linear's parent
/// relation is structural rather than a `blocks` relation, but the work cannot be
/// complete until its subtasks are. Keeping this in the domain result makes the
/// graph, inspector and launch-readiness rules agree.
fn apply_subtask_dependencies(tasks: &mut [Task]) {
    let children: Vec<(String, String, bool)> = tasks
        .iter()
        .filter_map(|task| {
            task.parent_id.as_ref().map(|parent| {
                (
                    parent.clone(),
                    task.id.clone(),
                    task.status == TaskStatus::Done,
                )
            })
        })
        .collect();
    let by_id: std::collections::HashMap<String, usize> = tasks
        .iter()
        .enumerate()
        .map(|(index, task)| (task.id.clone(), index))
        .collect();

    for (parent_id, child_id, child_done) in children {
        let Some(&parent_index) = by_id.get(&parent_id) else {
            continue;
        };
        let parent = &mut tasks[parent_index];
        if !parent.blocked_by.contains(&child_id) {
            parent.blocked_by.push(child_id);
        }
        if !child_done {
            parent.ready = false;
        }
    }
}

// ── Read caches ────────────────────────────────────────────────────────────

/// One key's cache slot: the fetch time and the value, behind a lock that is held
/// for the whole fetch so concurrent readers of the key wait on one result.
type Slot<T> = std::sync::Arc<tokio::sync::Mutex<Option<(Instant, std::sync::Arc<T>)>>>;

/// A per-key, TTL-bounded, single-flight cache for one kind of Linear read.
///
/// Each key owns a [`Slot`] whose `tokio::sync::Mutex` is held *across* the fetch, so
/// callers that arrive mid-flight wait on the first one's result rather than each
/// issuing the same query. [`TtlCache::invalidate`] drops the slot outright: a fetch
/// already in flight completes into the orphaned slot and is simply never served, so
/// a write never waits on a read to land.
struct TtlCache<T> {
    ttl: Duration,
    slots: std::sync::Mutex<HashMap<String, Slot<T>>>,
}

impl<T> TtlCache<T> {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            slots: Default::default(),
        }
    }

    fn slot(&self, key: &str) -> Slot<T> {
        // Poison-tolerant, like `refresh_lock`: the map holds only Arcs, so a thread
        // that panicked mid-access left it structurally sound.
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key.to_string())
            .or_default()
            .clone()
    }

    /// The value for `key` — served from the cache while younger than the TTL, else
    /// fetched exactly once however many callers arrive mid-flight. The flag reports
    /// which happened, so the caller can log a hit differently from a fetch. A failed
    /// fetch is not cached: the next caller tries again.
    async fn get_or_fetch<F, Fut>(&self, key: &str, fetch: F) -> Result<(std::sync::Arc<T>, bool)>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T>>,
    {
        let slot = self.slot(key);
        let mut entry = slot.lock().await;
        if let Some((at, value)) = entry.as_ref() {
            if at.elapsed() < self.ttl {
                return Ok((value.clone(), true));
            }
        }
        let value = std::sync::Arc::new(fetch().await?);
        *entry = Some((Instant::now(), value.clone()));
        Ok((value, false))
    }

    /// Forget `key` so the next read fetches. Never waits on an in-flight fetch.
    fn invalidate(&self, key: &str) {
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(key);
    }

    /// Forget every key — the manual refresh, which promises a real fetch.
    fn clear(&self) {
        self.slots.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

/// How long an org's assigned-issue list is reused. Every registered repo linked to
/// the same org asks for it — the sidebar and the Tickets page fan out per repo by
/// design — and those calls land within the same second, so the window only has to
/// outlive that burst. Writes invalidate it explicitly (see [`issues_changed`]), so
/// nothing the user just did reads back stale.
const ASSIGNED_ISSUES_TTL: Duration = Duration::from_secs(15);

/// Per-org assigned-issue cache, keyed by org slug alone. That is the whole identity
/// of the result: [`ASSIGNED_ISSUES_QUERY`] takes no variables and reads nothing per
/// repo, and an org has exactly one keychain credential, so the slug already pins
/// the viewer. The one event that can change the viewer behind a slug — a reconnect
/// — drops the entry via [`invalidate_org_caches`]. No token ever enters the key.
static ASSIGNED_ISSUES: std::sync::LazyLock<TtlCache<Vec<Task>>> =
    std::sync::LazyLock::new(|| TtlCache::new(ASSIGNED_ISSUES_TTL));

/// Drop the org's cached issue list after a write. Every mutation calls this once
/// the request has been *sent* — success or not, because a failure reply doesn't
/// prove the change didn't land — so the frontend's settle-time refetch fetches.
fn issues_changed(slug: &str) {
    ASSIGNED_ISSUES.invalidate(slug);
}

/// Drop everything cached for an org whose credential was just (re)issued — the
/// viewer behind the slug may be a different user now.
fn invalidate_org_caches(slug: &str) {
    ASSIGNED_ISSUES.invalidate(slug);
    TEAM_SCOPES.invalidate(slug);
}

/// Drop every org's caches. The manual refresh (⌘⇧R) calls this before it
/// refetches: a refresh that lands inside the TTL would otherwise be served
/// the very list the user is refreshing to get past.
pub fn invalidate_all_caches() {
    ASSIGNED_ISSUES.clear();
    TEAM_SCOPES.clear();
}

/// The assigned issues for `repo`'s org laid out as a graph, or `None` when no org is
/// connected. Returning `None` instead of erroring lets a not-yet-connected repo show
/// an empty graph rather than an error state.
///
/// Served from [`ASSIGNED_ISSUES`] when the org was fetched within the TTL: the
/// cross-repo views ask once per registered repo, and three repos on one org used to
/// cost three identical round-trips. A hit skips the keychain read as well as the
/// network — only a miss builds a session.
pub async fn list_issues(db: &Db, repo: &str) -> Result<Option<Vec<Task>>> {
    let Some(slug) = resolve_org_slug(db, repo).await? else {
        return Ok(None);
    };
    let (tasks, from_cache) = ASSIGNED_ISSUES
        .get_or_fetch(&slug, || fetch_assigned_issues(db, slug.clone(), repo))
        .await?;
    if from_cache {
        log::debug!(
            "served {} Linear issues for {repo} from the {slug} org cache",
            tasks.len()
        );
    } else {
        log::info!(
            "fetched {} Linear issues for {repo} (org {slug})",
            tasks.len()
        );
    }
    Ok(Some(tasks.as_ref().clone()))
}

/// The uncached half of [`list_issues`]: one [`ASSIGNED_ISSUES_QUERY`] round-trip for
/// `slug`, mapped and laid out. `repo` is only for the truncation warning.
async fn fetch_assigned_issues(db: &Db, slug: String, repo: &str) -> Result<Vec<Task>> {
    let session = org_session(db, slug).await?;
    let data: QueryData = session
        .query(ASSIGNED_ISSUES_QUERY, serde_json::json!({}))
        .await?;
    // Looping past the first page would multiply this query's cost, and it's
    // already near Linear's ~10000 complexity ceiling (see the NOTE above) — so a
    // >100-issue backlog is truncated rather than risking a 400. Warn instead of
    // silently dropping the rest.
    if data.viewer.assigned_issues.page_info.has_next_page {
        log::warn!(
            "assignedIssues truncated at 100 for repo {repo}: more assigned issues exist but \
             weren't fetched (looping risks exceeding Linear's query complexity cap)"
        );
    }
    let nodes = data.viewer.assigned_issues.nodes;

    let assigned: std::collections::HashSet<String> =
        nodes.iter().map(|n| n.identifier.clone()).collect();

    // Map assigned issues (actionable) and collect every blocker they reference.
    let mut tasks: Vec<Task> = Vec::with_capacity(nodes.len());
    // BTreeMap (not HashMap) so blockers drain in a stable identifier order —
    // HashMap's random iteration order shuffled graph node positions between fetches.
    let mut blockers: std::collections::BTreeMap<String, RelatedIssue> =
        std::collections::BTreeMap::new();
    for node in nodes {
        let (task, refs) = map_issue(node);
        for r in refs {
            if !assigned.contains(&r.identifier) {
                blockers.entry(r.identifier.clone()).or_insert(r);
            }
        }
        tasks.push(task);
    }

    // Pull any blockers that aren't the viewer's own work into the graph as
    // grayed, non-actionable context nodes (so every "blocked by" has a node).
    for (_, issue) in blockers {
        tasks.push(map_related(issue));
    }

    apply_subtask_dependencies(&mut tasks);
    layout::layout_tasks(&mut tasks);
    Ok(tasks)
}

/// Split a Linear identifier into its team key and issue number — `"AK-165"` →
/// `("AK", 165)`. `None` for anything that isn't the `<KEY>-<number>` shape, with
/// the same key rule the frontend's `ticketIdFor` uses (uppercase, alphanumeric,
/// 2–10 chars) so the two agree on what counts as an id.
fn split_identifier(id: &str) -> Option<(&str, u64)> {
    let (key, number) = id.rsplit_once('-')?;
    let key_ok = (2..=10).contains(&key.len())
        && key.starts_with(|c: char| c.is_ascii_uppercase())
        && key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    key_ok.then_some(())?;
    Some((key, number.parse().ok()?))
}

/// How many identifiers one lookup resolves. The Reviews inbox caps each section
/// at 50 PRs across a handful of sections, so this only bites on a very large
/// inbox — and truncating the *grouping* metadata is far better than risking
/// Linear's complexity cap and losing it entirely.
const TICKET_LOOKUP_CAP: usize = 200;

/// Resolve Linear identifiers (`AK-165`, …) to just enough to group PRs by project.
///
/// Deliberately not [`list_issues`], which fetches the *viewer's assigned* issues:
/// the whole point here is other people's tickets — the ones attached to PRs you
/// review — which that query never returns.
///
/// One round-trip for the whole batch. The filter is a cross-product (`team.key IN
/// (…) AND number IN (…)`), so it over-matches — `AK-5` + `MSG-9` also matches
/// `AK-9` and `MSG-5` — and the result is intersected back against the exact
/// identifiers asked for. `None` when no org is connected, so the sidebar simply
/// offers no project grouping rather than erroring.
pub async fn tickets_by_identifier(
    db: &Db,
    repo: &str,
    ids: &[String],
) -> Result<Option<Vec<TicketRef>>> {
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };

    let mut wanted: HashSet<&str> = HashSet::new();
    let mut keys: HashSet<&str> = HashSet::new();
    let mut numbers: HashSet<u64> = HashSet::new();
    for id in ids.iter().take(TICKET_LOOKUP_CAP) {
        if let Some((key, number)) = split_identifier(id) {
            wanted.insert(id.as_str());
            keys.insert(key);
            numbers.insert(number);
        }
    }
    if wanted.is_empty() {
        return Ok(Some(vec![]));
    }
    if ids.len() > TICKET_LOOKUP_CAP {
        log::warn!(
            "Reviews: resolving only the first {TICKET_LOOKUP_CAP} of {} ticket ids for project \
             grouping; the rest group as \"No Project\"",
            ids.len()
        );
    }

    #[derive(Deserialize)]
    struct QueryData {
        issues: Connection<TicketLookupNode>,
    }

    // The filter goes over as one `IssueFilter` variable rather than as separate
    // `[String!]!`/`[Float!]!` lists — it keeps the query free of Linear's exact
    // scalar choice for `number`, which is the sort of thing that 400s at runtime.
    const QUERY: &str = r"
        query TicketRefs($filter: IssueFilter!, $first: Int!) {
          issues(filter: $filter, first: $first) {
            nodes {
              identifier title priority
              project { name color icon targetDate }
              projectMilestone { id name targetDate sortOrder }
            }
          }
        }
    ";
    let keys: Vec<&str> = keys.into_iter().collect();
    let numbers: Vec<u64> = numbers.into_iter().collect();
    let data: QueryData = session
        .query(
            QUERY,
            serde_json::json!({
                "filter": { "team": { "key": { "in": keys } }, "number": { "in": numbers } },
                // Room for the cross-product's false positives on top of the real hits.
                "first": 250,
            }),
        )
        .await?;

    Ok(Some(
        data.issues
            .nodes
            .into_iter()
            .filter(|n| wanted.contains(n.identifier.as_str()))
            .map(|n| {
                let (project, project_color, project_icon, project_target_date) =
                    project_fields(n.project);
                TicketRef {
                    identifier: n.identifier,
                    title: n.title,
                    priority: core_linear::map_priority(n.priority),
                    project,
                    project_color,
                    project_icon,
                    project_target_date,
                    project_milestone: project_milestone_ref(n.project_milestone),
                }
            })
            .collect(),
    ))
}

/// Connection status for a repo: whether any org is connected, and which one this repo uses.
pub async fn auth_status(db: &Db, repo: &str) -> Result<LinearStatus> {
    let orgs = list_orgs(db).await?;
    let slug = resolve_org_slug(db, repo).await?;
    let resolved = slug
        .as_ref()
        .and_then(|s| orgs.iter().find(|o| &o.slug == s));
    Ok(LinearStatus {
        authenticated: !orgs.is_empty(),
        org: resolved.map(|o| o.name.clone()),
        can_write: resolved.is_some_and(|o| o.can_write),
        org_slug: slug,
    })
}

// ── Triage (live) ────────────────────────────────────────────────────────
// The triage queue is the viewer's assigned issues that sit in a `triage`
// workflow state (mirrors the santree CLI). Detail pulls the single issue with
// its description + comments; inline Linear-CDN images are downloaded with the
// access token and embedded as data URIs so the webview can render them.

/// A repo's Linear session: the org its queries go to, plus a currently-valid access
/// token. Every GraphQL call a command makes goes through one, so the token can be
/// re-minted mid-command when Linear rejects it (see [`Session::query`]).
struct Session<'a> {
    db: &'a Db,
    slug: String,
    token: tokio::sync::RwLock<String>,
}

impl Session<'_> {
    /// The current access token — for the calls that aren't GraphQL (the inline image
    /// downloads), which have no envelope to retry through.
    async fn token(&self) -> String {
        self.token.read().await.clone()
    }

    /// POST a GraphQL query, retrying **once** with a force-refreshed token when Linear
    /// answers 401.
    ///
    /// The stored `expires_at` said this token was good, so a 401 means the keychain and
    /// Linear have desynced (the token was revoked, or a keychain restored from an older
    /// backup) — without the retry the org stays bricked until that expiry finally
    /// passes. Only a 401 retries, and only once: a GraphQL `errors` array (permission,
    /// complexity) carries no HTTP status and would just repeat, and Linear's refresh
    /// grant is single-use, so spending one per failed call is worse than the failure.
    async fn query<T: DeserializeOwned>(
        &self,
        query: &str,
        variables: serde_json::Value,
    ) -> Result<T> {
        let spent = self.token().await;
        let err = match graphql_for(Some(&self.slug), &spent, query, &variables).await {
            Ok(data) => return Ok(data),
            Err(e) => e,
        };
        if gql::status_of(&err) != Some(reqwest::StatusCode::UNAUTHORIZED) {
            return Err(err);
        }
        log::warn!(
            "Linear rejected the stored access token for org {} before its recorded expiry \
             — re-minting it and retrying once",
            self.slug
        );
        let fresh = force_refresh(self.db, &self.slug, &spent).await?;
        *self.token.write().await = fresh.clone();
        graphql_for(Some(&self.slug), &fresh, query, &variables).await
    }
}

/// A session for the org this repo uses, or `None` when no org is connected.
/// Returning `None` (rather than erroring) lets each live command resolve the org
/// exactly once and return an empty result when not connected.
async fn repo_session<'a>(db: &'a Db, repo: &str) -> Result<Option<Session<'a>>> {
    let Some(slug) = resolve_org_slug(db, repo).await? else {
        return Ok(None);
    };
    org_session(db, slug).await.map(Some)
}

/// A session for a connected org, with a currently-valid token (reads the keychain).
async fn org_session(db: &Db, slug: String) -> Result<Session<'_>> {
    let token = valid_token(db, &slug).await?;
    Ok(Session {
        db,
        slug,
        token: tokio::sync::RwLock::new(token),
    })
}

/// [`repo_session`], refused up front when the workspace granted read-only.
///
/// Linear's own answer to a missing scope is a generic GraphQL permission error,
/// which reads as "santree is broken" rather than "you connected read-only". Every
/// mutating path resolves its session through here, so a new one can't quietly
/// skip the check — the UI gate is the courtesy, this is the guarantee.
async fn repo_write_session<'a>(db: &'a Db, repo: &str) -> Result<Option<Session<'a>>> {
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };
    if !can_write_to(db, &session.slug).await? {
        // Two causes, two fixes — saying "reconnect" to someone who only has to
        // flip a switch sends them through an OAuth round-trip for nothing.
        if read_only_mode(db).await? {
            anyhow::bail!(
                "santree is set to read-only for Linear. Change it under Settings → Integrations."
            );
        }
        anyhow::bail!(
            "This Linear workspace is connected read-only. Reconnect it with write access from Settings → Integrations."
        );
    }
    Ok(Some(session))
}

// ── Rate-limit budget ───────────────────────────────────────────────────────

/// The last budget Linear reported, per org.
///
/// Linear has no `/rate_limit` to ask; it answers only in the headers of a
/// request that already spent some of the budget. So every call the app makes
/// leaves its reading here and the settings screen reads the freshest one,
/// instead of spending budget to measure budget. In-memory on purpose — a
/// reading is only true for the hour it was taken in, and Linear refills the
/// pools on its own clock whether santree is running or not.
static BUDGETS: std::sync::LazyLock<std::sync::RwLock<HashMap<String, LinearApiBudget>>> =
    std::sync::LazyLock::new(Default::default);

/// How stale an observation may be before [`api_budget`] spends one request to
/// take a fresh one. Every ordinary Linear call also refreshes it, so on a
/// working session the probe almost never fires.
const BUDGET_TTL_MS: f64 = 60_000.0;

/// A numeric header, or `None` when absent or unparseable.
fn header_num(headers: &reqwest::header::HeaderMap, name: &str) -> Option<f64> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

/// One pool from its `limit`/`remaining`/`reset` header triple. Requires the two
/// counts — a window with no numbers in it is not a reading, and rendering it as
/// zero-remaining would be a lie in the alarming direction. `reset` is optional
/// and already epoch **milliseconds** (unlike GitHub's seconds).
fn header_window(
    headers: &reqwest::header::HeaderMap,
    kind: ApiBudgetKind,
    prefix: &str,
) -> Option<ApiBudgetWindow> {
    Some(ApiBudgetWindow {
        kind,
        limit: header_num(headers, &format!("{prefix}-Limit"))?,
        remaining: header_num(headers, &format!("{prefix}-Remaining"))?,
        resets_at_ms: header_num(headers, &format!("{prefix}-Reset")),
    })
}

/// File a response's rate-limit headers under the org that paid for it.
///
/// Never fails and never blocks the caller: a response carrying no rate-limit
/// headers (a proxy stripped them, Linear changed the contract) leaves the last
/// good reading in place rather than replacing it with an empty one.
fn record_budget(slug: &str, headers: &reqwest::header::HeaderMap) {
    let windows: Vec<_> = [
        header_window(headers, ApiBudgetKind::Requests, "X-RateLimit-Requests"),
        header_window(headers, ApiBudgetKind::Complexity, "X-RateLimit-Complexity"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if windows.is_empty() {
        return;
    }
    let mut map = BUDGETS.write().unwrap_or_else(|e| e.into_inner());
    let entry = map
        .entry(slug.to_string())
        .or_insert_with(|| LinearApiBudget {
            slug: slug.to_string(),
            name: String::new(),
            windows: Vec::new(),
            observed_at_ms: 0.0,
        });
    entry.windows = windows;
    entry.observed_at_ms = now_ms() as f64;
}

/// What is left of each connected workspace's Linear budget.
///
/// Returns an entry per connected org, freshest reading first-hand: an org whose
/// last observation has gone stale is probed with the cheapest query Linear
/// accepts (`viewer { id }`), which costs one request out of the hour's
/// thousands and is the only way to learn the number. An org that can't be
/// reached keeps whatever reading it had, and one that has never been reached at
/// all is simply absent — an unknown budget is not an empty one.
pub async fn api_budget(db: &Db) -> Result<Vec<LinearApiBudget>> {
    let orgs = list_orgs(db).await?;
    let now = now_ms() as f64;
    for org in &orgs {
        let fresh = BUDGETS
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&org.slug)
            .is_some_and(|b| now - b.observed_at_ms < BUDGET_TTL_MS);
        if fresh {
            continue;
        }
        let probe = async {
            let session = org_session(db, org.slug.clone()).await?;
            session
                .query::<serde_json::Value>("query { viewer { id } }", serde_json::json!({}))
                .await
        };
        if let Err(e) = probe.await {
            log::warn!("probing the Linear rate limit for {}: {e:#}", org.slug);
        }
    }

    let map = BUDGETS.read().unwrap_or_else(|e| e.into_inner());
    Ok(orgs
        .into_iter()
        .filter_map(|org| {
            map.get(&org.slug).map(|budget| LinearApiBudget {
                // The org's display name lives in the database, not in a header —
                // stamp it on the way out so the snapshot stays a pure reading.
                name: org.name,
                ..budget.clone()
            })
        })
        .collect())
}

/// POST a GraphQL query with a given token and return the typed `data` payload. Callers
/// inside a command go through [`Session::query`] (which can re-mint the token); this is
/// the raw call, for the OAuth flow's first request — where there's no org yet.
async fn graphql<T: DeserializeOwned>(
    token: &str,
    query: &str,
    variables: &serde_json::Value,
) -> Result<T> {
    graphql_for(None, token, query, variables).await
}

/// [`graphql`], attributing the call to the org whose token paid for it so the
/// response's rate-limit headers land in that org's budget snapshot. `slug` is
/// `None` only for the connect flow, which runs before an org exists to file it
/// under.
async fn graphql_for<T: DeserializeOwned>(
    slug: Option<&str>,
    token: &str,
    query: &str,
    variables: &serde_json::Value,
) -> Result<T> {
    let req = gql::client()
        .post(GRAPHQL_URL)
        .bearer_auth(token)
        .json(&serde_json::json!({ "query": query, "variables": variables }));
    crate::gql::post_observed(req, "Linear", |headers| {
        if let Some(slug) = slug {
            record_budget(slug, headers);
        }
    })
    .await
}

#[derive(Deserialize)]
struct LabelName {
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserNode {
    #[serde(default)]
    id: Option<String>,
    /// Full name ("Felipe Perdomo").
    #[serde(default)]
    name: Option<String>,
    /// The @handle ("felipeperdomo").
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    avatar_url: Option<String>,
}

/// How a user's name is rendered — mirrors Linear's "Display names" preference.
#[derive(Clone, Copy, PartialEq)]
enum NameStyle {
    Full,
    Username,
}

/// Read the global display-names preference (defaults to full name).
async fn name_style(db: &Db) -> NameStyle {
    match settings::get(db, "app", "display_names").await {
        Ok(Some(v)) if v == "username" => NameStyle::Username,
        _ => NameStyle::Full,
    }
}

/// Choose a user's label from (full name, @handle) per the preference, falling
/// back to whichever is present when the preferred one is missing.
fn pick_name(
    name: Option<String>,
    display_name: Option<String>,
    style: NameStyle,
) -> Option<String> {
    let name = name.filter(|s| !s.is_empty());
    let display_name = display_name.filter(|s| !s.is_empty());
    match style {
        NameStyle::Full => name.or(display_name),
        NameStyle::Username => display_name.or(name),
    }
}
/// A non-human comment author (integration / Linear system actor).
#[derive(Deserialize)]
struct BotActor {
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "avatarUrl")]
    avatar_url: Option<String>,
}

/// Resolve a comment/issue actor to `(display name, avatar url)`, preferring the
/// human user, then a bot actor.
fn actor(
    user: Option<UserNode>,
    bot: Option<BotActor>,
    style: NameStyle,
) -> (String, Option<String>) {
    if let Some(u) = user {
        let name = pick_name(u.name, u.display_name, style).unwrap_or_else(|| "Unknown".into());
        return (name, u.avatar_url);
    }
    if let Some(b) = bot {
        return (b.name.unwrap_or_else(|| "Unknown".into()), b.avatar_url);
    }
    ("Unknown".into(), None)
}

// The triage queue is the on-call inbox for the teams the viewer belongs to that
// run a triage rotation — issues in a `triage` workflow state, regardless of
// assignee (most triage items are unassigned until someone picks them up). We
// scope to *rotation* teams only: a team without a triage rotation has no on-call
// owner, so its triage state isn't anyone's responsibility and would just be
// noise here. This mirrors the schedule strips (build via `triage_schedule`), so
// the teams shown there are exactly the teams whose issues land in this queue.

const TRIAGE_INBOX_QUERY: &str = r#"
query TriageInbox($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: 100, after: $after) {
    nodes {
      identifier title priority slaBreachesAt snoozedUntilAt
      state { name type }
      team { key }
      assignee { id }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"#;

#[derive(Deserialize)]
struct TeamKeyNode {
    key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TriageRow {
    identifier: String,
    title: String,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    sla_breaches_at: Option<String>,
    #[serde(default)]
    snoozed_until_at: Option<String>,
    #[serde(default)]
    team: Option<TeamKeyNode>,
    #[serde(default)]
    assignee: Option<UserNode>,
}
#[derive(Deserialize)]
struct TriageInboxData {
    issues: Connection<TriageRow>,
}

/// The triage inbox for a repo's workspace, scoped to the viewer's teams.
/// Active issues first, snoozed sunk to the bottom (by SLA breach time within).
pub async fn triage_tickets(db: &Db, repo: &str) -> Result<Option<Vec<TriageTicket>>> {
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };
    // The viewer (for "mine") and their *rotation* teams (to scope the inbox). Propagate
    // a failure here rather than swallowing it into an empty scope — that used to render
    // a transient network/auth error as the positive "All caught up" empty state. A
    // genuinely empty scope (no rotation team configured) is the only legitimate
    // empty-inbox path.
    let scope = team_scope(&session).await?;
    // No rotation team → no on-call inbox. Show an empty queue rather than
    // flooding the list with the whole workspace's (un-owned) triage issues.
    if scope.teams.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let me = scope.viewer_id.as_deref();
    let keys: Vec<&str> = scope.teams.iter().map(|t| t.key.as_str()).collect();
    let filter = serde_json::json!({
        "state": { "type": { "eq": "triage" } },
        "team": { "key": { "in": keys } },
    });
    // A busy org's triage inbox can exceed one page; this filtered query is cheap
    // relative to the complexity budget (unlike assignedIssues), so loop the
    // cursor rather than silently truncating at 100.
    let mut nodes: Vec<TriageRow> = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let data: TriageInboxData = session
            .query(
                TRIAGE_INBOX_QUERY,
                serde_json::json!({ "filter": filter, "after": after }),
            )
            .await?;
        let page_info = data.issues.page_info;
        nodes.extend(data.issues.nodes);
        if !page_info.has_next_page {
            break;
        }
        let Some(cursor) = page_info.end_cursor else {
            break;
        };
        after = Some(cursor);
    }
    let now = now_ms();

    let mut rows: Vec<(TriageTicket, bool, i64)> = nodes
        .into_iter()
        .map(|r| {
            let snooze_ms = r.snoozed_until_at.as_deref().and_then(parse_ms);
            let snoozed = core_linear::is_snoozed(snooze_ms, now);
            let sla_ms = r.sla_breaches_at.as_deref().and_then(parse_ms);
            let team = r.team.map(|t| t.key);
            let mine = match (me, r.assignee.as_ref().and_then(|u| u.id.as_deref())) {
                (Some(me), Some(a)) => me == a,
                _ => false,
            };
            // Specta forbids exporting i64 (BigInt precision-loss risk), so the raw
            // millisecond timestamps cross the bridge as f64 — exact for epoch-ms
            // values for millennia to come.
            let ticket = TriageTicket {
                id: r.identifier,
                title: r.title,
                priority: core_linear::map_priority(r.priority),
                team,
                sla_breach_ms: sla_ms.map(|v| v as f64),
                snoozed_until_ms: snoozed.then_some(snooze_ms).flatten().map(|v| v as f64),
                mine,
            };
            (ticket, snoozed, sla_ms.unwrap_or(i64::MAX))
        })
        .collect();

    // Active first, snoozed last; within each, soonest SLA breach first.
    rows.sort_by(|a, b| a.1.cmp(&b.1).then(a.2.cmp(&b.2)));
    Ok(Some(rows.into_iter().map(|(t, _, _)| t).collect()))
}

// The nested `children` connections below are pinned to `first: 50` — Linear's
// default page size, i.e. exactly what these queries already cost. Complexity
// multiplies across nesting levels (100 comments × N replies) against the 10000
// cap, so raising it here would risk a 400 on the whole pane; a thread with more
// than 50 replies is paged out per-comment via [`COMMENT_REPLIES_PAGE_QUERY`]
// instead, which is cheap because it fetches one comment.
const ISSUE_DETAIL_QUERY: &str = r#"
query GetIssue($id: String!) {
  issue(id: $id) {
    identifier title description url priority estimate dueDate createdAt slaBreachesAt snoozedUntilAt
    cycle { number name startsAt endsAt }
    state { id name type }
    team { states(first: 50) { nodes { id name type color position } } }
    labels { nodes { name } }
    project { name }
    projectMilestone { id name targetDate sortOrder }
    assignee { name displayName avatarUrl }
    creator { name displayName avatarUrl }
    comments(first: 100) {
      nodes {
        id body createdAt parent { id }
        user { name displayName avatarUrl }
        botActor { name avatarUrl }
        children(first: 50) {
          nodes {
            id body createdAt
            user { name displayName avatarUrl }
            botActor { name avatarUrl }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;

/// Follow-up page of a single issue's top-level comments, keyed by cursor. Kept
/// separate from [`ISSUE_DETAIL_QUERY`] so paginating a chatty thread doesn't
/// re-fetch the description/labels/team states on every page.
const ISSUE_COMMENTS_PAGE_QUERY: &str = r#"
query GetIssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after) {
      nodes {
        id body createdAt parent { id }
        user { name displayName avatarUrl }
        botActor { name avatarUrl }
        children(first: 50) {
          nodes {
            id body createdAt
            user { name displayName avatarUrl }
            botActor { name avatarUrl }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;

/// The rest of one comment's replies, by cursor — for the rare thread that runs
/// past the first page of `children` (see the note above).
const COMMENT_REPLIES_PAGE_QUERY: &str = r#"
query GetCommentReplies($id: String!, $after: String) {
  comment(id: $id) {
    children(first: 100, after: $after) {
      nodes {
        id body createdAt
        user { name displayName avatarUrl }
        botActor { name avatarUrl }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;

/// A comment's parent reference. Its presence is all we use (to drop replies from
/// the top-level list), so the body is intentionally empty — the queried `id` is
/// ignored on deserialization.
#[derive(Deserialize)]
struct ParentRef {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentNode {
    #[serde(default)]
    id: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    parent: Option<ParentRef>,
    #[serde(default)]
    user: Option<UserNode>,
    #[serde(default)]
    bot_actor: Option<BotActor>,
    #[serde(default)]
    children: Option<Connection<CommentNode>>,
}
/// One of a team's workflow states (for the status picker).
#[derive(Deserialize, Default)]
struct WorkflowStateNode {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "type")]
    type_: String,
    #[serde(default)]
    color: String,
    #[serde(default)]
    position: f64,
}
#[derive(Deserialize, Default)]
struct TeamStates {
    #[serde(default)]
    states: Connection<WorkflowStateNode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueDetailNode {
    identifier: String,
    title: String,
    #[serde(default)]
    description: Option<String>,
    url: String,
    #[serde(default)]
    priority: i64,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    sla_breaches_at: Option<String>,
    #[serde(default)]
    snoozed_until_at: Option<String>,
    #[serde(default)]
    estimate: Option<f64>,
    #[serde(default)]
    due_date: Option<String>,
    #[serde(default)]
    cycle: Option<CycleNode>,
    state: Option<StateNode>,
    #[serde(default)]
    team: Option<TeamStates>,
    #[serde(default)]
    labels: Connection<LabelName>,
    project: Option<ProjectNode>,
    #[serde(default)]
    project_milestone: Option<ProjectMilestoneNode>,
    #[serde(default)]
    assignee: Option<UserNode>,
    #[serde(default)]
    creator: Option<UserNode>,
    #[serde(default)]
    comments: Connection<CommentNode>,
}
#[derive(Deserialize)]
struct IssueDetailData {
    issue: Option<IssueDetailNode>,
}

#[derive(Deserialize)]
struct IssueCommentsPage {
    comments: Connection<CommentNode>,
}
#[derive(Deserialize)]
struct IssueCommentsPageData {
    issue: Option<IssueCommentsPage>,
}

#[derive(Deserialize)]
struct CommentRepliesPage {
    children: Connection<CommentNode>,
}
#[derive(Deserialize)]
struct CommentRepliesPageData {
    comment: Option<CommentRepliesPage>,
}

/// Every reply under `comment_id`, starting from the page already fetched inline
/// with the issue. A failure while paging is logged and the replies we do have
/// are kept — a chatty thread shouldn't take the whole discussion pane down.
async fn all_replies(
    session: &Session<'_>,
    comment_id: &str,
    page: Connection<CommentNode>,
) -> Vec<CommentNode> {
    let mut nodes = page.nodes;
    let mut page_info = page.page_info;
    while page_info.has_next_page {
        let Some(after) = page_info.end_cursor.take() else {
            break;
        };
        let next: Result<CommentRepliesPageData> = session
            .query(
                COMMENT_REPLIES_PAGE_QUERY,
                serde_json::json!({ "id": comment_id, "after": after }),
            )
            .await;
        match next {
            Ok(data) => {
                let Some(more) = data.comment else { break };
                nodes.extend(more.children.nodes);
                page_info = more.children.page_info;
            }
            Err(e) => {
                log::warn!(
                    "couldn't page the replies under Linear comment {comment_id}: {e:#} — \
                     showing the {} already fetched",
                    nodes.len()
                );
                break;
            }
        }
    }
    nodes
}

/// Map one comment (and its one level of threaded replies) into the domain
/// type, downloading inline images in each body.
async fn map_comment(
    client: &reqwest::Client,
    mut node: CommentNode,
    session: &Session<'_>,
    style: NameStyle,
) -> TriageComment {
    let mut child_nodes =
        all_replies(session, &node.id, node.children.take().unwrap_or_default()).await;
    child_nodes.sort_by_key(|c| c.created_at.as_deref().and_then(parse_ms).unwrap_or(0));
    // Read the token *after* the replies are in: paging them can have re-minted it.
    let token = &session.token().await;
    // Inline each reply's images concurrently; join_all preserves order. Resolve
    // the timestamp up front so the per-reply futures don't borrow `ch`.
    let children = join_all(child_nodes.into_iter().map(|ch| {
        let created_at_ms = ch
            .created_at
            .as_deref()
            .and_then(parse_ms)
            .map(|v| v as f64)
            .unwrap_or_default();
        async move {
            let (author, avatar_url) = actor(ch.user, ch.bot_actor, style);
            TriageComment {
                id: ch.id,
                author,
                avatar_url,
                created_at_ms,
                body: inline_images(client, &ch.body, token).await,
                children: vec![],
            }
        }
    }))
    .await;

    let (author, avatar_url) = actor(node.user, node.bot_actor, style);
    TriageComment {
        id: node.id,
        author,
        avatar_url,
        created_at_ms: node
            .created_at
            .as_deref()
            .and_then(parse_ms)
            .map(|v| v as f64)
            .unwrap_or_default(),
        body: inline_images(client, &node.body, token).await,
        children,
    }
}

/// Whether a failed Linear query failed *because the id names nothing* — Linear's
/// answer to `issue(id: "not-a-ticket")`, which it reports as HTTP 200 with an
/// `errors` array rather than an empty `data`.
///
/// This is the seam between "there is no such ticket" (a state: a worktree cut from
/// a plain branch, a PR title with no ticket id) and "Linear could not answer" (a
/// failure: an expired token, a rate limit, a dead network, a complexity overflow).
/// Only the first may be swallowed, so the test is deliberately narrow:
///
/// - the failure has to be a GraphQL `errors` array at all — every transport failure
///   and every non-2xx status is a [`gql::HttpError`] or a reqwest error instead,
///   and none of those reach here;
/// - **every** entry has to be an entity-not-found, so a response that also carries a
///   permission or rate-limit error still surfaces;
/// - an entry counts by Linear's own `extensions.code` when it sends one, and
///   otherwise by its canonical message ("Entity not found: Issue — Could not find
///   referenced Issue."), which is what the API returns today.
fn entity_not_found(err: &anyhow::Error) -> bool {
    let Some(errors) = gql::graphql_errors(err) else {
        return false;
    };
    !errors.errors.is_empty()
        && errors.errors.iter().all(|e| {
            e.extensions
                .code
                .as_deref()
                .is_some_and(|c| c.eq_ignore_ascii_case("ENTITY_NOT_FOUND"))
                || e.message
                    .trim_start()
                    .to_ascii_lowercase()
                    .starts_with("entity not found")
        })
}

/// The full triage issue (description + comments) for the discussion pane, with
/// inline Linear-CDN images downloaded and embedded as data URIs.
///
/// `None` means *there is no ticket to show*: either no Linear org is connected, or
/// Linear answered definitively that this id names no issue — santree's worktrees are
/// keyed by a ticket id, but a worktree cut from a plain branch carries a branch slug
/// there instead, and a missing ticket is that worktree's normal state, not a fault.
/// Everything Linear *couldn't* answer still errors; see [`entity_not_found`].
pub async fn triage_detail(db: &Db, repo: &str, ticket_id: &str) -> Result<Option<TriageDetail>> {
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };
    let data: IssueDetailData = match session
        .query(ISSUE_DETAIL_QUERY, serde_json::json!({ "id": ticket_id }))
        .await
    {
        Ok(data) => data,
        Err(err) if entity_not_found(&err) => return Ok(None),
        Err(err) => return Err(err),
    };
    // Linear reports a missing issue through the `errors` array above rather than a
    // null field, but a null one says the same thing — no issue, not a failure.
    let Some(mut issue) = data.issue else {
        return Ok(None);
    };

    // A long-running thread can exceed one page of comments — pull the rest via
    // cursor. Comments are cheap relative to the complexity budget (unlike
    // assignedIssues), so looping here is safe.
    let mut cursor = issue.comments.page_info.end_cursor.clone();
    while issue.comments.page_info.has_next_page {
        let Some(after) = cursor.take() else { break };
        let page: IssueCommentsPageData = session
            .query(
                ISSUE_COMMENTS_PAGE_QUERY,
                serde_json::json!({ "id": ticket_id, "after": after }),
            )
            .await?;
        let Some(page_issue) = page.issue else { break };
        issue.comments.nodes.extend(page_issue.comments.nodes);
        issue.comments.page_info = page_issue.comments.page_info;
        cursor = issue.comments.page_info.end_cursor.clone();
    }

    let now = now_ms();
    let style = name_style(db).await;
    let client = gql::client();
    let token = session.token().await;

    let description = inline_images(client, &issue.description.unwrap_or_default(), &token).await;

    // Top-level comments (replies hang off each via `children`), oldest first.
    let mut top: Vec<CommentNode> = issue
        .comments
        .nodes
        .into_iter()
        .filter(|c| c.parent.is_none())
        .collect();
    top.sort_by_key(|c| c.created_at.as_deref().and_then(parse_ms).unwrap_or(0));
    // Map (and inline-fetch images for) each top-level comment concurrently;
    // join_all preserves the oldest-first order.
    let comments = join_all(
        top.into_iter()
            .map(|node| map_comment(client, node, &session, style)),
    )
    .await;

    let (author, author_avatar_url) = actor(issue.creator, None, style);
    // Named the way the author is (the display-name setting applies to both),
    // and absent rather than "Unknown" when nobody is assigned.
    let (assignee, assignee_avatar_url) = match issue.assignee {
        Some(user) => {
            let (name, avatar) = actor(Some(user), None, style);
            (Some(name), avatar)
        }
        None => (None, None),
    };
    let snooze_ms = issue.snoozed_until_at.as_deref().and_then(parse_ms);
    let state = issue.state;
    let state_id = state.as_ref().and_then(|s| s.id.clone());

    // The team's workflow states, ordered as in Linear, for the status picker.
    let mut state_nodes = issue.team.map(|t| t.states.nodes).unwrap_or_default();
    state_nodes.sort_by(|a, b| a.position.total_cmp(&b.position));
    let states: Vec<WorkflowState> = state_nodes
        .into_iter()
        .map(|s| WorkflowState {
            id: s.id,
            name: s.name,
            type_: s.type_,
            color: s.color,
        })
        .collect();

    Ok(Some(TriageDetail {
        id: issue.identifier,
        title: issue.title,
        priority: core_linear::map_priority(issue.priority),
        state: state.map(|s| s.name).unwrap_or_else(|| "Triage".into()),
        state_id,
        states,
        url: issue.url,
        author,
        author_avatar_url,
        created_at_ms: issue
            .created_at
            .as_deref()
            .and_then(parse_ms)
            .map(|v| v as f64)
            .unwrap_or_default(),
        labels: issue.labels.nodes.into_iter().map(|l| l.name).collect(),
        project: issue.project.and_then(|p| p.name),
        project_milestone: project_milestone_ref(issue.project_milestone),
        assignee,
        assignee_avatar_url,
        estimate: issue.estimate,
        cycle: cycle_ref(issue.cycle),
        due_date: issue.due_date,
        sla_breach_ms: issue
            .sla_breaches_at
            .as_deref()
            .and_then(parse_ms)
            .map(|v| v as f64),
        snoozed_until_ms: core_linear::is_snoozed(snooze_ms, now)
            .then_some(snooze_ms)
            .flatten()
            .map(|v| v as f64),
        description,
        comments,
    }))
}

const SET_STATE_MUTATION: &str = r#"
mutation SetState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { state { name } }
  }
}
"#;

/// Move an issue to a different workflow state (e.g. out of `triage` into
/// `backlog`/`unstarted` to "promote" it). Requires a write-scoped token.
pub async fn set_issue_state(
    db: &Db,
    repo: &str,
    ticket_id: &str,
    state_id: &str,
) -> Result<Option<()>> {
    let Some(session) = repo_write_session(db, repo).await? else {
        return Ok(None);
    };
    set_state(&session, ticket_id, state_id).await.map(Some)
}

/// [`set_issue_state`] on an established session — so a caller that already resolved one
/// ([`move_issue_to_started`]) doesn't re-resolve the org and re-read the keychain.
async fn set_state(session: &Session<'_>, ticket_id: &str, state_id: &str) -> Result<()> {
    #[derive(Deserialize)]
    struct UpdResult {
        #[serde(default)]
        success: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SetStateData {
        issue_update: Option<UpdResult>,
    }
    let sent = session
        .query::<SetStateData>(
            SET_STATE_MUTATION,
            serde_json::json!({ "id": ticket_id, "stateId": state_id }),
        )
        .await;
    issues_changed(&session.slug);
    let data = sent?;
    if data.issue_update.map(|u| u.success).unwrap_or(false) {
        Ok(())
    } else {
        // `Session::query` already surfaces any `errors` array (permission/scope
        // problems land there), so reaching here means a bare `success: false`
        // with no error — don't guess a specific cause.
        bail!("Linear rejected the status change")
    }
}

const SNOOZE_MUTATION: &str = r#"
mutation Snooze($id: String!, $until: DateTime, $by: String) {
  issueUpdate(id: $id, input: { snoozedUntilAt: $until, snoozedById: $by }) {
    success
  }
}
"#;

/// Snooze a triage issue until `until_ms` (epoch ms), or wake it with `None`.
///
/// Linear records *who* snoozed an issue beside *until when*, and its Triage
/// view reads both — so the viewer's id rides along on a snooze, and clearing
/// the pair is what wakes it. Requires a write-scoped token; `Ok(None)` when no
/// Linear org is connected for the repo.
pub async fn snooze_issue(
    db: &Db,
    repo: &str,
    ticket_id: &str,
    until_ms: Option<i64>,
) -> Result<Option<()>> {
    let Some(session) = repo_write_session(db, repo).await? else {
        return Ok(None);
    };
    let until = until_ms
        .map(|ms| {
            chrono::DateTime::from_timestamp_millis(ms)
                .map(|t| t.to_rfc3339())
                .context("snooze time out of range")
        })
        .transpose()?;

    #[derive(Deserialize)]
    struct ViewerId {
        id: String,
    }
    #[derive(Deserialize)]
    struct ViewerData {
        viewer: ViewerId,
    }
    let by = match until {
        Some(_) => Some(
            session
                .query::<ViewerData>("query { viewer { id } }", serde_json::json!({}))
                .await?
                .viewer
                .id,
        ),
        None => None,
    };

    #[derive(Deserialize)]
    struct UpdResult {
        #[serde(default)]
        success: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SnoozeData {
        issue_update: Option<UpdResult>,
    }
    let sent = session
        .query::<SnoozeData>(
            SNOOZE_MUTATION,
            serde_json::json!({ "id": ticket_id, "until": until, "by": by }),
        )
        .await;
    issues_changed(&session.slug);
    let data = sent?;
    if data.issue_update.map(|u| u.success).unwrap_or(false) {
        Ok(Some(()))
    } else {
        // As in `set_state`: a bare `success: false` with no `errors` — don't
        // guess a cause.
        bail!("Linear rejected the snooze")
    }
}

// `commentCreate.issueId` requires the issue's UUID, but the UI only holds the
// human identifier (e.g. "MSG-5147"), so resolve the UUID first.
const ISSUE_UUID_QUERY: &str = r#"
query IssueUuid($id: String!) { issue(id: $id) { id } }
"#;

const CREATE_COMMENT_MUTATION: &str = r#"
mutation CreateComment($issueId: String!, $parentId: String, $body: String!) {
  commentCreate(input: { issueId: $issueId, parentId: $parentId, body: $body }) {
    success
  }
}
"#;

/// Post a comment on an issue — a top-level comment, or a reply when `parent_id`
/// is the id of the comment being replied to. Requires a write-scoped token;
/// returns `Ok(None)` when no Linear org is connected for the repo.
pub async fn create_comment(
    db: &Db,
    repo: &str,
    ticket_id: &str,
    parent_id: Option<&str>,
    body: &str,
) -> Result<Option<()>> {
    let Some(session) = repo_write_session(db, repo).await? else {
        return Ok(None);
    };

    #[derive(Deserialize)]
    struct IssueId {
        id: String,
    }
    #[derive(Deserialize)]
    struct IssueIdData {
        issue: Option<IssueId>,
    }
    let id_data: IssueIdData = session
        .query(ISSUE_UUID_QUERY, serde_json::json!({ "id": ticket_id }))
        .await?;
    let issue_uuid = id_data
        .issue
        .ok_or_else(|| anyhow!("issue {ticket_id} not found"))?
        .id;

    #[derive(Deserialize)]
    struct CreateResult {
        #[serde(default)]
        success: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CreateCommentData {
        comment_create: Option<CreateResult>,
    }
    let sent = session
        .query::<CreateCommentData>(
            CREATE_COMMENT_MUTATION,
            serde_json::json!({ "issueId": issue_uuid, "parentId": parent_id, "body": body }),
        )
        .await;
    issues_changed(&session.slug);
    let data = sent?;
    if data.comment_create.map(|c| c.success).unwrap_or(false) {
        Ok(Some(()))
    } else {
        // `Session::query` surfaces any `errors` array, so a bare `success: false`
        // here has no specific cause to report.
        bail!("Linear rejected the comment")
    }
}

const STARTED_STATE_QUERY: &str = r#"
query StartedState($id: String!) {
  issue(id: $id) {
    state { type }
    team {
      states(filter: { type: { eq: "started" } }) {
        nodes { id position }
      }
    }
  }
}
"#;

/// Move an issue into its team's "started" (In Progress) workflow state — used
/// when a worktree begins so Linear reflects active work. Best-effort: no token →
/// `Ok(None)`; already started/done/canceled → left as-is. Picks the lowest-
/// position "started" state. Requires a write-scoped token.
pub async fn move_issue_to_started(db: &Db, repo: &str, issue_id: &str) -> Result<Option<()>> {
    #[derive(Deserialize)]
    struct StateType {
        #[serde(rename = "type")]
        kind: Option<String>,
    }
    #[derive(Deserialize)]
    struct StartedState {
        id: String,
        #[serde(default)]
        position: f64,
    }
    #[derive(Deserialize)]
    struct TeamStates {
        states: Connection<StartedState>,
    }
    #[derive(Deserialize)]
    struct IssueNode {
        #[serde(default)]
        state: Option<StateType>,
        #[serde(default)]
        team: Option<TeamStates>,
    }
    #[derive(Deserialize)]
    struct Data {
        issue: Option<IssueNode>,
    }

    let Some(session) = repo_write_session(db, repo).await? else {
        return Ok(None);
    };
    let data: Data = session
        .query(STARTED_STATE_QUERY, serde_json::json!({ "id": issue_id }))
        .await?;
    let Some(issue) = data.issue else {
        return Ok(None);
    };
    // Never drag an issue backwards — only promote one that hasn't started yet.
    let kind = issue.state.and_then(|s| s.kind).unwrap_or_default();
    if matches!(
        kind.as_str(),
        "started" | "completed" | "canceled" | "duplicate"
    ) {
        return Ok(Some(()));
    }
    let mut states = issue.team.map(|t| t.states.nodes).unwrap_or_default();
    states.sort_by(|a, b| a.position.total_cmp(&b.position));
    let Some(target) = states.first() else {
        return Ok(None); // team has no started state — nothing to do
    };
    set_state(&session, issue_id, &target.id).await.map(Some)
}

const TRIAGE_SCHEDULES_QUERY: &str = r#"
query TriageSchedules($after: String) {
  viewer {
    id
    teamMemberships(first: 100, after: $after) {
      nodes {
        team {
          key name
          triageResponsibility {
            currentUser { id }
            timeSchedule { name entries { startsAt endsAt userId userEmail } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}
"#;

#[derive(Deserialize, Clone)]
struct IdRef {
    #[serde(default)]
    id: Option<String>,
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SchedEntry {
    #[serde(default)]
    starts_at: Option<String>,
    #[serde(default)]
    ends_at: Option<String>,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    user_email: Option<String>,
}
#[derive(Deserialize, Clone)]
struct TimeSchedule {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    entries: Vec<SchedEntry>,
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TriageResp {
    #[serde(default)]
    current_user: Option<IdRef>,
    #[serde(default)]
    time_schedule: Option<TimeSchedule>,
}
/// `Clone` because the fetched teams are shared (behind an `Arc`) by both Triage reads,
/// and [`build_schedule`] consumes one — a handful of teams, so cloning is nothing next
/// to re-running the query.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TeamNode {
    key: String,
    name: String,
    #[serde(default)]
    triage_responsibility: Option<TriageResp>,
}

/// A team runs a triage rotation when its responsibility is backed by a non-empty
/// time schedule; a team without one has no on-call owner, so its triage issues
/// aren't anyone's responsibility. The queue and the schedule strips share this.
fn is_rotation_team(t: &TeamNode) -> bool {
    t.triage_responsibility
        .as_ref()
        .and_then(|r| r.time_schedule.as_ref())
        .is_some_and(|s| !s.entries.is_empty())
}

/// Team membership alone is not rotation membership. Linear keeps people on a
/// team after they leave its triage schedule, so only a schedule that actually
/// contains the viewer belongs in that viewer's Triage scope.
fn viewer_participates(t: &TeamNode, viewer_id: &str) -> bool {
    t.triage_responsibility
        .as_ref()
        .and_then(|r| r.time_schedule.as_ref())
        .is_some_and(|schedule| {
            schedule
                .entries
                .iter()
                .any(|entry| entry.user_id.as_deref() == Some(viewer_id))
        })
}
#[derive(Deserialize)]
struct Membership {
    #[serde(default)]
    team: Option<TeamNode>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedViewer {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    team_memberships: Option<Connection<Membership>>,
}
#[derive(Deserialize)]
struct SchedQueryData {
    viewer: Option<SchedViewer>,
}

/// Fetch every page of the viewer's team memberships. A user rarely belongs to
/// more than a handful of teams, so unlike `assignedIssues` this is cheap to loop
/// in full rather than truncate — a team past the first 100 would otherwise drop
/// silently out of both the triage queue's scope and the schedule strips.
async fn fetch_all_team_memberships(session: &Session<'_>) -> Result<SchedQueryData> {
    let mut data: SchedQueryData = session
        .query(TRIAGE_SCHEDULES_QUERY, serde_json::json!({}))
        .await?;
    let Some(viewer) = data.viewer.as_mut() else {
        return Ok(data);
    };
    let Some(conn) = viewer.team_memberships.as_mut() else {
        return Ok(data);
    };
    let mut cursor = conn.page_info.end_cursor.clone();
    while conn.page_info.has_next_page {
        let Some(after) = cursor.take() else { break };
        let page: SchedQueryData = session
            .query(
                TRIAGE_SCHEDULES_QUERY,
                serde_json::json!({ "after": after }),
            )
            .await?;
        let Some(mut page_conn) = page.viewer.and_then(|v| v.team_memberships) else {
            break;
        };
        conn.nodes.append(&mut page_conn.nodes);
        conn.page_info = page_conn.page_info;
        cursor = conn.page_info.end_cursor.clone();
    }
    Ok(data)
}

/// The viewer and the teams they're on call for — everything both Triage reads derive
/// from the memberships query: the queue scopes itself to `teams`' keys and marks its
/// own tickets with `viewer_id`; the schedule strips render `teams`' rotations.
struct TeamScope {
    viewer_id: Option<String>,
    /// Only teams that run a triage rotation (see [`is_rotation_team`]) — a team without
    /// one has no on-call owner, so its triage issues aren't anyone's responsibility.
    teams: Vec<TeamNode>,
}

/// Reduce the raw memberships payload to the [`TeamScope`] both reads want.
fn scope_of(data: SchedQueryData) -> TeamScope {
    let Some(viewer) = data.viewer else {
        return TeamScope {
            viewer_id: None,
            teams: Vec::new(),
        };
    };
    let viewer_id = viewer.id;
    TeamScope {
        viewer_id: viewer_id.clone(),
        teams: viewer
            .team_memberships
            .map(|c| c.nodes)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|m| m.team)
            .filter(|team| {
                is_rotation_team(team)
                    && viewer_id
                        .as_deref()
                        .is_some_and(|id| viewer_participates(team, id))
            })
            .collect(),
    }
}

/// How long a fetched [`TeamScope`] is reused. Triage's queue and its schedule strips are
/// separate commands that mount together and both need this paginated query — the window
/// only has to outlive that pair. Rotations change on a human timescale and the
/// frontend's own triage cache is minutes long, so nothing observable goes stale.
const TEAM_SCOPE_TTL: Duration = Duration::from_secs(60);

/// Per-org [`TeamScope`] cache — a [`TtlCache`], so the second of the two concurrent
/// Triage loads waits on the first's result instead of issuing its own copy of the
/// same query.
static TEAM_SCOPES: std::sync::LazyLock<TtlCache<TeamScope>> =
    std::sync::LazyLock::new(|| TtlCache::new(TEAM_SCOPE_TTL));

/// The org's [`TeamScope`], fetched at most once per [`TEAM_SCOPE_TTL`] — and exactly
/// once when both Triage commands ask at the same time. `fetch` is a parameter so the
/// coalescing is unit-testable without a network.
async fn cached_team_scope<F, Fut>(slug: &str, fetch: F) -> Result<std::sync::Arc<TeamScope>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<TeamScope>>,
{
    Ok(TEAM_SCOPES.get_or_fetch(slug, fetch).await?.0)
}

/// The [`TeamScope`] for this session's org.
async fn team_scope(session: &Session<'_>) -> Result<std::sync::Arc<TeamScope>> {
    cached_team_scope(&session.slug, || async {
        Ok(scope_of(fetch_all_team_memberships(session).await?))
    })
    .await
}

/// A user's display name + avatar, keyed by id in the resolved name map.
#[derive(Clone)]
struct UserInfo {
    name: String,
    avatar_url: Option<String>,
}
#[derive(Deserialize)]
struct UsersData {
    users: Connection<UserNode>,
}

/// The viewer's triage on-call rotations — one per team that has a
/// time-schedule-backed triage responsibility (empty when none do). Rotations
/// the viewer participates in are surfaced first.
pub async fn triage_schedule(db: &Db, repo: &str) -> Result<Option<Vec<TriageSchedule>>> {
    let Some(session) = repo_session(db, repo).await? else {
        return Ok(None);
    };
    // Shared with the queue (which mounts alongside this one) — see [`cached_team_scope`].
    let scope = team_scope(&session).await?;
    if scope.teams.is_empty() {
        return Ok(Some(Vec::new()));
    }

    // Resolve all referenced user ids → display names in one batch.
    let mut ids: Vec<String> = Vec::new();
    for t in &scope.teams {
        if let Some(r) = &t.triage_responsibility {
            if let Some(cu) = r.current_user.as_ref().and_then(|c| c.id.clone()) {
                ids.push(cu);
            }
            for e in r.time_schedule.iter().flat_map(|s| &s.entries) {
                if let Some(uid) = &e.user_id {
                    ids.push(uid.clone());
                }
            }
        }
    }
    ids.sort();
    ids.dedup();
    let style = name_style(db).await;
    let names = resolve_user_names(&session, &ids, style)
        .await
        .unwrap_or_default();
    let now = now_ms();

    let mut schedules: Vec<TriageSchedule> = scope
        .teams
        .iter()
        .cloned()
        .map(|t| build_schedule(t, scope.viewer_id.as_deref(), &names, now))
        .collect();
    // Surface rotations the viewer is part of first.
    schedules.sort_by_key(|s| !s.shifts.iter().any(|sh| sh.is_me));
    Ok(Some(schedules))
}

fn build_schedule(
    team: TeamNode,
    viewer_id: Option<&str>,
    names: &std::collections::HashMap<String, UserInfo>,
    now: i64,
) -> TriageSchedule {
    let resp = team.triage_responsibility.unwrap_or(TriageResp {
        current_user: None,
        time_schedule: None,
    });
    let schedule_name = resp
        .time_schedule
        .as_ref()
        .and_then(|s| s.name.clone())
        .unwrap_or_else(|| format!("{} triage", team.name));

    let mut shifts: Vec<(TriageShift, i64)> = resp
        .time_schedule
        .into_iter()
        .flat_map(|s| s.entries)
        .map(|e| {
            let start = e.starts_at.as_deref().and_then(parse_ms);
            let end = e.ends_at.as_deref().and_then(parse_ms);
            let is_current = matches!((start, end), (Some(s), Some(en)) if now >= s && now < en);
            let is_me = viewer_id.is_some() && e.user_id.as_deref() == viewer_id;
            let info = e.user_id.as_deref().and_then(|id| names.get(id));
            let name = info
                .map(|u| u.name.clone())
                .or(e.user_email)
                .unwrap_or_else(|| "Unknown".into());
            let avatar_url = info.and_then(|u| u.avatar_url.clone());
            (
                TriageShift {
                    name,
                    avatar_url,
                    starts_at_ms: start.map(|v| v as f64),
                    ends_at_ms: end.map(|v| v as f64),
                    is_current,
                    is_me,
                },
                start.unwrap_or(0),
            )
        })
        .collect();
    shifts.sort_by_key(|(_, start)| *start);
    let shifts: Vec<TriageShift> = shifts.into_iter().map(|(s, _)| s).collect();

    let current = shifts.iter().find(|s| s.is_current);
    let current_user_id = resp.current_user.and_then(|c| c.id);
    let current_name = current.map(|s| s.name.clone()).or_else(|| {
        current_user_id
            .as_deref()
            .and_then(|id| names.get(id))
            .map(|u| u.name.clone())
    });
    let current_avatar_url = current.and_then(|s| s.avatar_url.clone()).or_else(|| {
        current_user_id
            .as_deref()
            .and_then(|id| names.get(id))
            .and_then(|u| u.avatar_url.clone())
    });
    let current_is_me = current
        .map(|s| s.is_me)
        .unwrap_or_else(|| viewer_id.is_some() && current_user_id.as_deref() == viewer_id);

    TriageSchedule {
        team: team.name,
        schedule_name,
        current_name,
        current_avatar_url,
        current_is_me,
        shifts,
    }
}

async fn resolve_user_names(
    session: &Session<'_>,
    ids: &[String],
    style: NameStyle,
) -> Result<std::collections::HashMap<String, UserInfo>> {
    if ids.is_empty() {
        return Ok(Default::default());
    }
    const QUERY: &str = r#"
query ResolveUsers($ids: [ID!]!) {
  users(filter: { id: { in: $ids } }, first: 250) { nodes { id name displayName avatarUrl } }
}
"#;
    let data: UsersData = session
        .query(QUERY, serde_json::json!({ "ids": ids }))
        .await?;
    Ok(data
        .users
        .nodes
        .into_iter()
        .filter_map(|u| {
            let id = u.id?;
            let name = pick_name(u.name, u.display_name, style).unwrap_or_else(|| id.clone());
            Some((
                id,
                UserInfo {
                    name,
                    avatar_url: u.avatar_url,
                },
            ))
        })
        .collect())
}

// ── Timestamp + image helpers ──────────────────────────────────────────────

/// Parse an RFC3339 timestamp (Linear's format) to epoch milliseconds.
fn parse_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// The CDN host image URLs are inlined from.
const IMAGE_HOST: &str = "https://uploads.linear.app";

/// Byte-offset spans (in order) of every `https://uploads.linear.app/...` image
/// URL in `md`. Pure and synchronous so the scan (the part that shipped a
/// substring-corruption bug) is unit-testable without mocking a fetch.
fn image_spans(md: &str) -> Vec<(usize, usize)> {
    let bytes = md.as_bytes();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut search = 0;
    while let Some(rel) = md[search..].find(IMAGE_HOST) {
        let start = search + rel;
        // Require a path boundary ('/' or end-of-match) right after the host so a
        // prefix match like `https://uploads.linear.app.evil.com` (which contains
        // our string as a prefix, not the real host) is skipped, not treated as a
        // trusted Linear URL. fetch_data_uri re-validates the host as a second layer.
        if !matches!(
            md.as_bytes().get(start + IMAGE_HOST.len()),
            Some(b'/') | None
        ) {
            search = start + IMAGE_HOST.len();
            continue;
        }
        let mut end = start;
        while end < md.len()
            && !matches!(
                bytes[end],
                b')' | b' ' | b'\n' | b'\t' | b'"' | b']' | b'>' | b'<'
            )
        {
            end += 1;
        }
        spans.push((start, end));
        search = end;
    }
    spans
}

/// Rebuild `md` with each `spans` entry replaced by its match in
/// `replacements` (keyed by the exact URL substring). A span with no entry
/// (e.g. its fetch failed) is left untouched. Splices by span rather than
/// `str::replace` so one URL being a substring of another can't corrupt the
/// output, and the whole body is rewritten in a single pass.
fn splice_images(
    md: &str,
    spans: &[(usize, usize)],
    replacements: &std::collections::HashMap<&str, &str>,
) -> String {
    let mut out = String::with_capacity(md.len());
    let mut cursor = 0;
    for &(start, end) in spans {
        out.push_str(&md[cursor..start]);
        out.push_str(
            replacements
                .get(&md[start..end])
                .copied()
                .unwrap_or(&md[start..end]),
        );
        cursor = end;
    }
    out.push_str(&md[cursor..]);
    out
}

/// Replace `https://uploads.linear.app/...` image URLs in markdown with
/// base64 data URIs, downloading each with the access token. URLs that fail to
/// fetch are left untouched.
async fn inline_images(client: &reqwest::Client, md: &str, token: &str) -> String {
    if !md.contains(IMAGE_HOST) {
        return md.to_string();
    }
    let spans = image_spans(md);
    if spans.is_empty() {
        return md.to_string();
    }

    // Fetch each distinct URL once, concurrently.
    let mut distinct: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for &(start, end) in &spans {
        if seen.insert(&md[start..end]) {
            distinct.push(md[start..end].to_string());
        }
    }
    let fetched = join_all(
        distinct
            .iter()
            .map(|url| async move { fetch_data_uri(client, url, token).await.ok() }),
    )
    .await;
    let replacements: std::collections::HashMap<&str, &str> = distinct
        .iter()
        .zip(&fetched)
        .filter_map(|(url, uri)| uri.as_deref().map(|u| (url.as_str(), u)))
        .collect();

    splice_images(md, &spans, &replacements)
}

/// Cap on a single inlined image so one huge attachment can't balloon the IPC
/// payload / memory (the data URI is ~1.33× the raw bytes on top of that).
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// Session cache of fetched image data URIs (keyed by URL), so reopening a ticket
/// doesn't re-download its images. Bounded by *total bytes* with FIFO eviction —
/// a count cap could still pin hundreds of MB since each entry is up to
/// `MAX_IMAGE_BYTES`. The token is stable for the session, so URL is a safe key.
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct ImageCache {
    map: std::collections::HashMap<String, String>,
    order: std::collections::VecDeque<String>,
    bytes: usize,
}
impl ImageCache {
    fn get(&self, url: &str) -> Option<String> {
        self.map.get(url).cloned()
    }
    fn insert(&mut self, url: String, uri: String) {
        self.insert_bounded(url, uri, MAX_CACHE_BYTES);
    }

    /// `insert` with the byte cap as a parameter, so the FIFO eviction logic is
    /// unit-testable without allocating real megabytes of string data.
    fn insert_bounded(&mut self, url: String, uri: String, max_bytes: usize) {
        if self.map.contains_key(&url) {
            return;
        }
        self.bytes += uri.len();
        self.order.push_back(url.clone());
        self.map.insert(url, uri);
        while self.bytes > max_bytes {
            let Some(evicted) = self.order.pop_front() else {
                break;
            };
            if let Some(v) = self.map.remove(&evicted) {
                self.bytes -= v.len();
            }
        }
    }
}

static IMAGE_CACHE: std::sync::LazyLock<tokio::sync::Mutex<ImageCache>> =
    std::sync::LazyLock::new(Default::default);

async fn fetch_data_uri(client: &reqwest::Client, url: &str, token: &str) -> Result<String> {
    // Re-validate the host by parsing (not string-prefix) right before the token
    // goes out over the wire — the last line of defense against sending the org's
    // Linear OAuth token to a lookalike host (e.g. uploads.linear.app.evil.com).
    let parsed = reqwest::Url::parse(url)?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("uploads.linear.app") {
        bail!("refusing to fetch image from untrusted host: {url}");
    }
    if let Some(hit) = IMAGE_CACHE.lock().await.get(url) {
        return Ok(hit);
    }
    let res = client.get(url).bearer_auth(token).send().await?;
    if !res.status().is_success() {
        bail!("image fetch returned {}", res.status());
    }
    if let Some(len) = res.content_length() {
        if len > MAX_IMAGE_BYTES {
            bail!("image too large to inline ({len} bytes)");
        }
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    // Stream the body with a running cap rather than buffering it whole and
    // checking after: a missing or lying Content-Length defeats the pre-check
    // above, so without this a huge response would spike memory before we noticed.
    let mut data: Vec<u8> = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if data.len() as u64 + chunk.len() as u64 > MAX_IMAGE_BYTES {
            bail!("image too large to inline (exceeds {MAX_IMAGE_BYTES} bytes)");
        }
        data.extend_from_slice(&chunk);
    }
    let uri = format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(&data)
    );
    IMAGE_CACHE
        .lock()
        .await
        .insert(url.to_string(), uri.clone());
    Ok(uri)
}

// ── OAuth PKCE connect flow ──────────────────────────────────────────────

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

/// Run the OAuth flow, persist the org's tokens, and return the updated org list.
pub async fn connect(db: &Db) -> Result<Vec<LinearOrg>> {
    let verifier = b64url(&random_bytes(32));
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = hex(&random_bytes(16));

    let redirect_uri = format!("http://localhost:{OAUTH_PORT}");
    let scope = requested_scope(db).await?;
    let params = [
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect_uri.as_str()),
        ("response_type", "code"),
        // `write` lets the app move issues between workflow states, comment and
        // promote tickets. Which one we ask for is the user's choice — a workspace
        // that only approves reads still connects, and the UI disables the rest.
        ("scope", scope),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ];
    let query = params
        .iter()
        .map(|(k, v)| format!("{k}={}", urlencode(v)))
        .collect::<Vec<_>>()
        .join("&");
    open_browser(&format!("{AUTHORIZE_URL}?{query}"));

    let expected_state = state.clone();
    let code = tokio::task::spawn_blocking(move || wait_for_code(&expected_state))
        .await
        .context("oauth listener task")??;

    let (access_token, refresh_token, expires_at, scopes) =
        exchange_code(&code, &redirect_uri, &verifier).await?;
    let (slug, name) = fetch_viewer_org(&access_token).await?;

    let org = OrgRow {
        slug,
        name,
        expires_at,
        scopes,
    };
    upsert_org(
        db,
        &org,
        Tokens {
            access: access_token,
            refresh: refresh_token,
        },
    )
    .await?;
    invalidate_org_caches(&org.slug);
    list_orgs(db).await
}

/// How long the whole browser round-trip gets before the connect is abandoned.
const OAUTH_TIMEOUT: Duration = Duration::from_secs(120);

/// How long an accepted connection gets to send its request line. Clamped to the
/// remaining [`OAUTH_TIMEOUT`] budget, so a peer that connects and then says
/// nothing (a browser preconnect, a port scan) can't park the thread past it.
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(5);

fn wait_for_code(expected_state: &str) -> Result<String> {
    let listener = TcpListener::bind(("127.0.0.1", OAUTH_PORT)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            anyhow!(
                "Port {OAUTH_PORT} is already in use — another Linear sign-in may be in progress. Close it and try again."
            )
        } else {
            anyhow::Error::new(e).context("binding oauth port")
        }
    })?;
    accept_code(&listener, expected_state, Instant::now() + OAUTH_TIMEOUT)
}

/// Serve the OAuth callback until the browser delivers a `code` for our `state`,
/// the user declines, or `deadline` passes. Split from [`wait_for_code`] so it can
/// be driven over an ephemeral port in tests.
fn accept_code(listener: &TcpListener, expected_state: &str, deadline: Instant) -> Result<String> {
    // Non-blocking only so the accept loop can notice the deadline; each accepted
    // socket is put back into blocking mode before it's read (see `read_request`).
    listener.set_nonblocking(true)?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<String>>();

    loop {
        if Instant::now() > deadline {
            bail!("timed out waiting for Linear authorization");
        }
        match listener.accept() {
            // One thread per connection: a peer that connects and then says nothing
            // (a browser preconnect, a port scan) sits on its read timeout, and must
            // not hold the real callback behind it.
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
        // Doubles as the accept loop's idle sleep.
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(outcome) => return outcome,
            // We hold a `tx`, so the channel can't disconnect.
            Err(_) => continue,
        }
    }
}

/// Answer one connection to the callback port. `Some` when it *was* the callback —
/// a `code` carrying our `state` (Ok) or the user declining (Err) — and `None` for
/// anything else: a stray request must neither end the flow nor tell a still-open
/// tab that authentication failed.
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
    // Linear's deny redirect carries `error=access_denied` (no code) rather than a
    // failure status — without this, a user who declines sits on the full timeout
    // before seeing an error. Only trust the error when the state matches, so a stray
    // request to the callback port can't abort the flow.
    error
        .filter(|_| state_matches)
        .map(|error| Err(anyhow!("Linear authorization failed: {error}")))
}

/// Read an accepted callback connection's request line.
///
/// The socket has to be put back into blocking mode first: on macOS/BSD an accepted
/// socket *inherits* the listener's non-blocking flag (on Linux it doesn't), so the
/// first `read` would return `WouldBlock` before the browser's bytes landed — which
/// used to be swallowed as an empty request, answered with "Authentication failed",
/// and the auth code dropped on the floor. The read timeout is the other half: a
/// connection that never sends anything must not hold the flow past its deadline.
fn read_request(stream: &mut std::net::TcpStream, deadline: Instant) -> std::io::Result<String> {
    stream.set_nonblocking(false)?;
    let budget = deadline
        .saturating_duration_since(Instant::now())
        .min(CALLBACK_READ_TIMEOUT)
        // `set_read_timeout` rejects a zero duration (it means "block forever").
        .max(Duration::from_millis(50));
    stream.set_read_timeout(Some(budget))?;

    let mut buf = [0u8; 2048];
    let mut len = 0;
    while len < buf.len() {
        match stream.read(&mut buf[len..]) {
            Ok(0) => break,
            Ok(n) => {
                len += n;
                // The request line is all we need — don't wait for headers/body.
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

/// Extract `code`, `state`, and `error` from a callback path like
/// `/?code=…&state=…` (success) or `/?error=access_denied&state=…` (the user
/// declined), percent-decoding each value (a `%`-escaped code would otherwise
/// mismatch).
fn parse_callback(path: &str) -> (Option<String>, Option<String>, Option<String>) {
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

/// Exchange an auth code for `(access_token, refresh_token, expires_at_ms)`.
async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<(String, String, i64, String)> {
    let body = token_request(
        &[
            ("grant_type", "authorization_code"),
            ("client_id", CLIENT_ID),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ],
        "Linear token exchange",
    )
    .await?;
    Ok((
        body.access_token,
        body.refresh_token,
        now_ms() + body.expires_in * 1000,
        body.scope
            .as_ref()
            .map(GrantedScope::as_csv)
            .unwrap_or_default(),
    ))
}

/// Returns the viewer's organization `(url_key, name)`.
async fn fetch_viewer_org(access_token: &str) -> Result<(String, String)> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Org {
        url_key: String,
        name: String,
    }
    #[derive(Deserialize)]
    struct ViewerOrg {
        organization: Org,
    }
    #[derive(Deserialize)]
    struct Data {
        viewer: ViewerOrg,
    }

    let data: Data = graphql(
        access_token,
        "query { viewer { organization { urlKey name } } }",
        &serde_json::json!({}),
    )
    .await?;
    let org = data.viewer.organization;
    Ok((org.url_key, org.name))
}

fn open_browser(url: &str) {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(cmd).arg(url).spawn();
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        accept_code, apply_subtask_dependencies, cached_team_scope, cycle_ref, decode_tokens,
        encode_tokens, entity_not_found, header_window, image_spans, map_issue, map_related,
        migrate_tokens_to_keychain, parse_callback, parse_ms, record_budget, refresh_lock,
        resolve_org_slug, resolved_org, scope_from_setting, scope_of, splice_images,
        split_identifier, usable_at, CommentNode, CycleNode, ImageCache, IssueDetailNode,
        IssueNode, ParentIssueNode, ProjectMilestoneNode, ProjectNode, RelatedIssue, RelationNode,
        SchedQueryData, StateNode, TeamScope, TicketLookupNode, Tokens, TriageRow, TtlCache,
        UserNode, BUDGETS, IMAGE_HOST, REFRESH_SKEW_MS,
    };
    use crate::gql::{Connection, GqlError, GraphQlErrors, PageInfo};
    use anyhow::anyhow;
    use santree_core::domain::{ApiBudgetKind, Task, TaskStatus};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// Build the failure `gql::post` raises for an HTTP 200 + `errors` response,
    /// decoding the array exactly as the wire path does.
    fn gql_failure(errors_json: serde_json::Value) -> anyhow::Error {
        let errors: Vec<GqlError> = serde_json::from_value(errors_json).unwrap();
        anyhow::Error::new(GraphQlErrors::new("Linear", errors))
    }

    /// The whole point of the classifier: a worktree whose id is a branch slug, not a
    /// ticket, must resolve to "no ticket" instead of a red toast.
    #[test]
    fn a_missing_issue_is_recognised_as_not_found() {
        assert!(entity_not_found(&gql_failure(serde_json::json!([{
            "message": "Entity not found: Issue - Could not find referenced Issue.",
            "path": ["issue"],
            "extensions": { "type": "invalid_input", "userError": true }
        }]))));
        // Same answer via Linear's machine-readable code, whatever the wording.
        assert!(entity_not_found(&gql_failure(serde_json::json!([{
            "message": "no such thing",
            "extensions": { "code": "ENTITY_NOT_FOUND" }
        }]))));
    }

    /// The other half, and the one that matters more: a Linear that *couldn't answer*
    /// must keep failing loudly. Collapsing these to "no ticket" would present an
    /// expired token or a throttled org as a worktree with nothing linked to it.
    #[test]
    fn a_real_linear_failure_is_not_mistaken_for_a_missing_issue() {
        for errors in [
            serde_json::json!([{ "message": "Authentication required" }]),
            serde_json::json!([{ "message": "Ratelimit exceeded",
                                 "extensions": { "code": "RATELIMITED" } }]),
            // A mixed response: the issue is missing *and* something else broke. The
            // second error is the one the user needs, so nothing gets swallowed.
            serde_json::json!([
                { "message": "Entity not found: Issue" },
                { "message": "Ratelimit exceeded" },
            ]),
            serde_json::json!([]),
        ] {
            assert!(!entity_not_found(&gql_failure(errors.clone())), "{errors}");
        }

        // And a failure that never carried a GraphQL `errors` array at all — every
        // transport error, timeout and non-2xx status (a 401, a 429) arrives this
        // way, carrying the wording but never the structure the classifier reads.
        assert!(!entity_not_found(&anyhow!("connection reset")));
        assert!(!entity_not_found(&anyhow!(
            "Linear: Entity not found: Issue"
        )));
    }

    #[test]
    fn linear_scope_requires_an_explicit_write_choice() {
        assert_eq!(scope_from_setting(Some("read_write")), "read,write");
        assert_eq!(scope_from_setting(Some("read")), "read");
        assert_eq!(scope_from_setting(None), "read");
        assert_eq!(scope_from_setting(Some("")), "read");
        assert_eq!(scope_from_setting(Some("read,write")), "read");
    }

    /// Both tokens share one keychain entry, so the blob is the only thing
    /// standing between a refresh and a bricked org — it has to round-trip
    /// exactly (Linear tokens are opaque and may contain any of `.`, `-`, `_`).
    #[test]
    fn token_blob_round_trips() {
        let tokens = Tokens {
            access: "lin_oauth_ac.ce-ss_1/2+3".into(),
            refresh: "lin_oauth_re\"fresh\"".into(),
        };
        let blob = encode_tokens(&tokens).unwrap();
        assert_eq!(decode_tokens(&blob).unwrap(), tokens);
    }

    /// A garbage / foreign credential must be a loud error, not a silent
    /// "disconnected org" (which would send the user round the OAuth flow again
    /// with no idea why).
    #[test]
    fn token_blob_rejects_garbage() {
        assert!(decode_tokens("not json").is_err());
        assert!(decode_tokens(r#"{"access":"a"}"#).is_err());
    }

    async fn memory_db() -> crate::db::Db {
        sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap()
    }

    /// The startup drain has to be a no-op once the columns are gone — otherwise
    /// it would hit the keychain (and could prompt) on every launch.
    #[tokio::test]
    async fn token_migration_is_a_noop_without_the_legacy_columns() {
        let db = memory_db().await;
        sqlx::query(
            "CREATE TABLE linear_orgs (slug TEXT PRIMARY KEY, name TEXT, expires_at INTEGER)",
        )
        .execute(&db)
        .await
        .unwrap();
        assert!(!migrate_tokens_to_keychain(&db).await.unwrap());
    }

    /// …and on a legacy schema with nothing to move (org rows are only written
    /// with tokens today, but a cleared row must not re-trigger the migration).
    #[tokio::test]
    async fn token_migration_skips_rows_without_tokens() {
        let db = memory_db().await;
        sqlx::query(
            "CREATE TABLE linear_orgs (slug TEXT PRIMARY KEY, name TEXT, access_token TEXT,
             refresh_token TEXT, expires_at INTEGER)",
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query("INSERT INTO linear_orgs VALUES ('acme', 'Acme', '', '', 0)")
            .execute(&db)
            .await
            .unwrap();
        assert!(!migrate_tokens_to_keychain(&db).await.unwrap());
    }

    /// The exact bug class that previously shipped: naive `str::replace` on a
    /// URL that is a strict prefix of another URL in the same doc corrupted the
    /// longer one (replacing its prefix and stranding the suffix). Span-based
    /// splicing must keep both intact.
    #[test]
    fn prefix_url_does_not_corrupt_longer_url() {
        let md = format!("![a]({IMAGE_HOST}/abc) ![b]({IMAGE_HOST}/abc/nested)");
        let spans = image_spans(&md);
        assert_eq!(spans.len(), 2);

        let short = format!("{IMAGE_HOST}/abc");
        let long = format!("{IMAGE_HOST}/abc/nested");
        let replacements: HashMap<&str, &str> =
            HashMap::from([(short.as_str(), "DATA_A"), (long.as_str(), "DATA_B")]);

        let out = splice_images(&md, &spans, &replacements);
        assert_eq!(out, "![a](DATA_A) ![b](DATA_B)");
    }

    #[test]
    fn url_at_end_of_string_is_captured() {
        let md = format!("see {IMAGE_HOST}/end");
        let spans = image_spans(&md);
        assert_eq!(spans, vec![(4, md.len())]);

        let key = format!("{IMAGE_HOST}/end");
        let replacements: HashMap<&str, &str> = HashMap::from([(key.as_str(), "DATA")]);
        assert_eq!(splice_images(&md, &spans, &replacements), "see DATA");
    }

    #[test]
    fn repeated_url_is_replaced_at_every_occurrence() {
        let md = format!("{IMAGE_HOST}/x and again {IMAGE_HOST}/x");
        let spans = image_spans(&md);
        assert_eq!(spans.len(), 2);

        let key = format!("{IMAGE_HOST}/x");
        let replacements: HashMap<&str, &str> = HashMap::from([(key.as_str(), "DATA")]);
        assert_eq!(
            splice_images(&md, &spans, &replacements),
            "DATA and again DATA"
        );
    }

    /// A failed fetch means no entry lands in the replacements map — the span
    /// must be left exactly as-is, not corrupted or dropped.
    #[test]
    fn missing_replacement_leaves_span_untouched() {
        let md = format!("![a]({IMAGE_HOST}/missing)");
        let spans = image_spans(&md);
        let replacements: HashMap<&str, &str> = HashMap::new();
        assert_eq!(splice_images(&md, &spans, &replacements), md);
    }

    #[test]
    fn every_boundary_terminator_ends_the_span() {
        for term in [')', ' ', '\n', '\t', '"', ']', '>', '<'] {
            let md = format!("{IMAGE_HOST}/x{term}rest");
            let spans = image_spans(&md);
            assert_eq!(
                spans,
                vec![(0, IMAGE_HOST.len() + 2)],
                "terminator {term:?} did not close the span"
            );
        }
    }

    /// The critical fix this refactor must not regress: a lookalike host that
    /// merely has our host as a string *prefix* (not the real host) is skipped,
    /// so its token-bearing URL is never queued for fetch.
    #[test]
    fn lookalike_host_is_not_a_match() {
        let md = format!("{IMAGE_HOST}.evil.com/x");
        assert!(image_spans(&md).is_empty());
    }

    // ── Token refresh ─────────────────────────────────────────────────────

    /// Linear rotates the refresh token on every use, so both directions of this
    /// check are load-bearing: refreshing too eagerly burns the stored grant on
    /// every call, and refreshing too late sends a token that expires in flight.
    #[test]
    fn a_token_is_reused_until_the_refresh_skew() {
        let now = 1_700_000_000_000;
        let expires = |mins: i64| now + mins * 60 * 1000;
        assert_eq!(REFRESH_SKEW_MS, 5 * 60 * 1000);

        assert!(usable_at(expires(6), now), "still well inside its lifetime");
        assert!(
            !usable_at(expires(5), now),
            "inside the skew — refresh before it expires mid-call"
        );
        assert!(!usable_at(expires(1), now));
        assert!(!usable_at(expires(-1), now), "already expired");
    }

    // ── Triage team scope ─────────────────────────────────────────────────

    /// The scope both Triage reads share is derived from the raw memberships payload:
    /// the viewer's id, and only rotations the viewer actually participates in.
    #[test]
    fn the_scope_keeps_rotation_teams_and_drops_the_rest() {
        let data: SchedQueryData = serde_json::from_value(serde_json::json!({
            "viewer": {
                "id": "u1",
                "teamMemberships": { "nodes": [
                    { "team": { "key": "ENG", "name": "Engineering", "triageResponsibility": {
                        "currentUser": { "id": "u1" },
                        "timeSchedule": { "name": "Eng on-call", "entries": [
                            { "startsAt": "2024-01-01T00:00:00Z", "endsAt": "2024-01-08T00:00:00Z", "userId": "u1" }
                        ] }
                    } } },
                    // No triage responsibility at all → no on-call owner.
                    { "team": { "key": "DES", "name": "Design", "triageResponsibility": null } },
                    // Responsibility, but its schedule has no shifts → still no owner.
                    { "team": { "key": "OPS", "name": "Ops", "triageResponsibility": {
                        "currentUser": null,
                        "timeSchedule": { "name": "unused", "entries": [] }
                    } } },
                    // A real rotation on a team the viewer belongs to, but the
                    // viewer was removed from its schedule → out of their Triage.
                    { "team": { "key": "MSG", "name": "Messaging", "triageResponsibility": {
                        "currentUser": { "id": "u2" },
                        "timeSchedule": { "name": "Messaging on-call", "entries": [
                            { "startsAt": "2024-01-01T00:00:00Z", "endsAt": "2024-01-08T00:00:00Z", "userId": "u2" }
                        ] }
                    } } },
                ] }
            }
        }))
        .unwrap();

        let scope = scope_of(data);
        assert_eq!(scope.viewer_id.as_deref(), Some("u1"));
        assert_eq!(
            scope
                .teams
                .iter()
                .map(|t| t.key.as_str())
                .collect::<Vec<_>>(),
            ["ENG"]
        );
    }

    #[test]
    fn an_absent_viewer_scopes_to_nothing() {
        let data: SchedQueryData =
            serde_json::from_value(serde_json::json!({ "viewer": null })).unwrap();
        let scope = scope_of(data);
        assert!(scope.viewer_id.is_none());
        assert!(scope.teams.is_empty());
    }

    fn empty_scope() -> TeamScope {
        TeamScope {
            viewer_id: Some("u1".into()),
            teams: Vec::new(),
        }
    }

    /// The point of the cache: the queue and the schedule strips are separate commands
    /// that mount together, and each used to run the whole paginated memberships query.
    /// Concurrently, they must now cost exactly one fetch — the second waits on the
    /// first's result rather than starting its own.
    #[tokio::test]
    async fn the_two_concurrent_triage_reads_share_one_fetch() {
        let slug = "scope-concurrent";
        let fetches = AtomicUsize::new(0);
        let fetch = || async {
            fetches.fetch_add(1, Ordering::SeqCst);
            // Long enough that the second caller is guaranteed to arrive mid-flight.
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok(empty_scope())
        };
        let (queue, strips) = tokio::join!(
            cached_team_scope(slug, fetch),
            cached_team_scope(slug, fetch),
        );

        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        // …and both read the *same* scope, not two equal copies.
        assert!(std::sync::Arc::ptr_eq(&queue.unwrap(), &strips.unwrap()));
    }

    /// A second load inside the TTL (a refetch, a tab revisit) reuses it too — and a
    /// different org never does.
    #[tokio::test]
    async fn the_scope_is_cached_per_org_within_the_ttl() {
        let fetches = AtomicUsize::new(0);
        let fetch = || async {
            fetches.fetch_add(1, Ordering::SeqCst);
            Ok(empty_scope())
        };
        cached_team_scope("scope-org-a", fetch).await.unwrap();
        cached_team_scope("scope-org-a", fetch).await.unwrap();
        assert_eq!(fetches.load(Ordering::SeqCst), 1);

        cached_team_scope("scope-org-b", fetch).await.unwrap();
        assert_eq!(
            fetches.load(Ordering::SeqCst),
            2,
            "another org is another scope"
        );
    }

    /// A failed fetch must not be cached — the next load has to try again rather than
    /// serve an empty scope (which Triage renders as the positive "All caught up").
    #[tokio::test]
    async fn a_failed_fetch_is_not_cached() {
        let slug = "scope-failure";
        assert!(
            cached_team_scope(slug, || async { anyhow::bail!("network down") })
                .await
                .is_err()
        );

        let fetches = AtomicUsize::new(0);
        cached_team_scope(slug, || async {
            fetches.fetch_add(1, Ordering::SeqCst);
            Ok(empty_scope())
        })
        .await
        .unwrap();
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
    }

    // ── TtlCache (the assigned-issues cache) ──────────────────────────────

    /// The log line that motivated the cache: three repos on one org each asked for
    /// the same assigned-issue list within a second. Concurrent reads of one key must
    /// cost one fetch, and every waiter must be told it was served from cache.
    #[tokio::test]
    async fn concurrent_reads_of_one_key_share_one_fetch() {
        let cache = TtlCache::<u32>::new(Duration::from_secs(15));
        let fetches = AtomicUsize::new(0);
        let fetch = || async {
            fetches.fetch_add(1, Ordering::SeqCst);
            // Long enough that the other callers are guaranteed to arrive mid-flight.
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok(7)
        };
        let (a, b, c) = tokio::join!(
            cache.get_or_fetch("acme", fetch),
            cache.get_or_fetch("acme", fetch),
            cache.get_or_fetch("acme", fetch),
        );
        assert_eq!(fetches.load(Ordering::SeqCst), 1);

        let (a, a_hit) = a.unwrap();
        let (b, b_hit) = b.unwrap();
        let (c, c_hit) = c.unwrap();
        assert!(std::sync::Arc::ptr_eq(&a, &b) && std::sync::Arc::ptr_eq(&b, &c));
        // Exactly one of them did the fetch; the rest waited for it.
        assert_eq!([a_hit, b_hit, c_hit].iter().filter(|hit| !**hit).count(), 1);
    }

    /// A read inside the TTL is a hit; one past it fetches again.
    #[tokio::test]
    async fn an_entry_expires_after_the_ttl() {
        let cache = TtlCache::<u32>::new(Duration::from_millis(20));
        let fetches = AtomicUsize::new(0);
        let fetch = || async {
            fetches.fetch_add(1, Ordering::SeqCst);
            Ok(1)
        };
        assert!(!cache.get_or_fetch("acme", fetch).await.unwrap().1);
        assert!(cache.get_or_fetch("acme", fetch).await.unwrap().1);
        assert_eq!(fetches.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(!cache.get_or_fetch("acme", fetch).await.unwrap().1);
        assert_eq!(fetches.load(Ordering::SeqCst), 2);
    }

    /// A write invalidates its own org and nothing else: the next read of that key
    /// fetches even though the TTL hasn't lapsed, while another org's entry stays.
    #[tokio::test]
    async fn invalidating_a_key_forces_its_next_read_to_fetch() {
        let cache = TtlCache::<u32>::new(Duration::from_secs(15));
        let fetches = AtomicUsize::new(0);
        let fetch = || async {
            fetches.fetch_add(1, Ordering::SeqCst);
            Ok(1)
        };
        cache.get_or_fetch("acme", fetch).await.unwrap();
        cache.get_or_fetch("globex", fetch).await.unwrap();
        assert_eq!(fetches.load(Ordering::SeqCst), 2);

        cache.invalidate("acme");
        assert!(!cache.get_or_fetch("acme", fetch).await.unwrap().1);
        assert!(cache.get_or_fetch("globex", fetch).await.unwrap().1);
        assert_eq!(fetches.load(Ordering::SeqCst), 3);
    }

    /// Invalidating a key that is mid-fetch must not wait on that fetch (a write would
    /// otherwise stall behind a read), and the read that started before the write
    /// must not be what a read *after* the write sees.
    #[tokio::test]
    async fn invalidation_never_waits_on_an_in_flight_fetch() {
        let cache = std::sync::Arc::new(TtlCache::<&'static str>::new(Duration::from_secs(15)));
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let stale = {
            let cache = cache.clone();
            tokio::spawn(async move {
                cache
                    .get_or_fetch("acme", || async {
                        release_rx.await.unwrap();
                        Ok("before the write")
                    })
                    .await
                    .unwrap()
                    .0
            })
        };
        // Give the spawned read time to take the slot lock and block in its fetch.
        tokio::time::sleep(Duration::from_millis(20)).await;

        // Must return immediately even though the fetch above is still blocked.
        tokio::time::timeout(Duration::from_millis(100), async {
            cache.invalidate("acme")
        })
        .await
        .expect("invalidate blocked on an in-flight fetch");

        let (fresh, hit) = cache
            .get_or_fetch("acme", || async { Ok("after the write") })
            .await
            .unwrap();
        assert!(!hit);
        assert_eq!(*fresh, "after the write");

        release_tx.send(()).unwrap();
        assert_eq!(*stale.await.unwrap(), "before the write");
        // …and the orphaned pre-write result is never what the key serves now.
        assert_eq!(
            *cache
                .get_or_fetch("acme", || async { Ok("unreachable") })
                .await
                .unwrap()
                .0,
            "after the write"
        );
    }

    // ── refresh_lock ──────────────────────────────────────────────────────

    #[test]
    fn refresh_lock_same_slug_returns_the_same_arc() {
        let a = refresh_lock("refresh-lock-test-same");
        let b = refresh_lock("refresh-lock-test-same");
        assert!(std::sync::Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn refresh_lock_different_slugs_return_different_arcs() {
        let a = refresh_lock("refresh-lock-test-a");
        let b = refresh_lock("refresh-lock-test-b");
        assert!(!std::sync::Arc::ptr_eq(&a, &b));
    }

    // ── ImageCache ────────────────────────────────────────────────────────

    #[test]
    fn image_cache_evicts_oldest_entry_once_over_the_byte_cap() {
        let mut cache = ImageCache::default();
        cache.insert_bounded("a".into(), "x".repeat(10), 15);
        // Total is now 20 bytes > the 15-byte cap: the oldest entry ("a") must
        // be evicted to bring the running total back under the cap.
        cache.insert_bounded("b".into(), "x".repeat(10), 15);
        assert!(cache.get("a").is_none());
        assert_eq!(cache.get("b"), Some("x".repeat(10)));
    }

    #[test]
    fn image_cache_insert_is_a_no_op_for_an_existing_key() {
        let mut cache = ImageCache::default();
        cache.insert_bounded("a".into(), "one".into(), 1000);
        cache.insert_bounded("a".into(), "two".into(), 1000);
        // The first value wins; a re-insert of the same URL doesn't overwrite it
        // (or double-count its bytes against the cap).
        assert_eq!(cache.get("a"), Some("one".into()));
    }

    #[test]
    fn image_cache_keeps_entries_under_the_cap() {
        let mut cache = ImageCache::default();
        cache.insert_bounded("a".into(), "12345".into(), 100);
        cache.insert_bounded("b".into(), "67890".into(), 100);
        assert_eq!(cache.get("a"), Some("12345".into()));
        assert_eq!(cache.get("b"), Some("67890".into()));
    }

    // ── parse_callback ────────────────────────────────────────────────────

    #[test]
    fn parse_callback_reads_code_and_state() {
        let (code, state, error) = parse_callback("/?code=abc123&state=xyz789");
        assert_eq!(code.as_deref(), Some("abc123"));
        assert_eq!(state.as_deref(), Some("xyz789"));
        assert_eq!(error, None);
    }

    #[test]
    fn parse_callback_percent_decodes_values() {
        // A `%`-escaped code (e.g. one containing `+` or `/`) must come back
        // decoded, or it would mismatch the raw code sent in the token exchange.
        let (code, state, _) = parse_callback("/?code=a%2Bb%2Fc&state=has%20space");
        assert_eq!(code.as_deref(), Some("a+b/c"));
        assert_eq!(state.as_deref(), Some("has space"));
    }

    #[test]
    fn parse_callback_reads_error_on_deny() {
        // Linear's deny redirect: no code, an `error`, and the original `state`.
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

    // ── parse_ms ──────────────────────────────────────────────────────────

    #[test]
    fn parse_ms_parses_a_real_linear_timestamp() {
        let got = parse_ms("2024-06-15T12:34:56.789Z").unwrap();
        let want = chrono::DateTime::parse_from_rfc3339("2024-06-15T12:34:56.789Z")
            .unwrap()
            .timestamp_millis();
        assert_eq!(got, want);
    }

    #[test]
    fn parse_ms_rejects_a_non_rfc3339_string() {
        assert_eq!(parse_ms("not-a-timestamp"), None);
    }

    // ── map_issue / map_related ───────────────────────────────────────────

    fn state(name: &str, type_: &str) -> StateNode {
        StateNode {
            id: None,
            name: name.into(),
            type_: type_.into(),
        }
    }

    fn related(identifier: &str, state_type: &str) -> RelatedIssue {
        RelatedIssue {
            identifier: identifier.into(),
            title: format!("{identifier} title"),
            state: Some(state("Some State", state_type)),
            project: None,
            project_milestone: None,
            assignee: None,
        }
    }

    fn task_for_subtask_test(id: &str, parent_id: Option<&str>, status: TaskStatus) -> Task {
        Task {
            id: id.into(),
            title: id.into(),
            priority: santree_core::domain::Priority::None,
            estimate: None,
            cycle: None,
            due_date: None,
            project: "Project".into(),
            project_color: None,
            project_icon: None,
            project_target_date: None,
            project_milestone: None,
            parent_id: parent_id.map(str::to_owned),
            status,
            ready: true,
            blocked_by: vec![],
            actionable: true,
            assignee: None,
            assignee_avatar_url: None,
            x: 0,
            y: 0,
        }
    }

    #[test]
    fn subtasks_become_parent_dependencies_and_hold_readiness_until_done() {
        let mut tasks = vec![
            task_for_subtask_test("ENG-1", None, TaskStatus::Todo),
            task_for_subtask_test("ENG-2", Some("ENG-1"), TaskStatus::Done),
            task_for_subtask_test("ENG-3", Some("ENG-1"), TaskStatus::Todo),
        ];

        apply_subtask_dependencies(&mut tasks);

        assert_eq!(tasks[0].blocked_by, ["ENG-2", "ENG-3"]);
        assert!(!tasks[0].ready);
    }

    #[test]
    fn ticket_lookup_deserializes_graphql_milestone_camel_case() {
        let node: TicketLookupNode = serde_json::from_value(serde_json::json!({
            "identifier": "ENG-1",
            "title": "Grouped work",
            "priority": 2,
            "project": null,
            "projectMilestone": {
                "id": "milestone-1",
                "name": "Beta",
                "targetDate": "2026-09-01",
                "sortOrder": 3.0
            }
        }))
        .expect("ticket lookup response");

        let milestone = node.project_milestone.expect("milestone");
        assert_eq!(milestone.name, "Beta");
        assert_eq!(milestone.target_date.as_deref(), Some("2026-09-01"));
    }

    /// The Issues graph, decoded from the wire rather than built as a struct.
    ///
    /// [`IssueNode`] leans entirely on `rename_all = "camelCase"`: without it
    /// `projectMilestone` and `inverseRelations` are unknown keys that fall to
    /// their defaults, so *every* ticket loses its milestone and its blockers and
    /// the dependency graph reports the whole backlog as "ready". Both are
    /// `#[serde(default)]`, so nothing fails — the graph is just wrong.
    #[test]
    fn an_issue_decodes_the_milestone_and_the_blockers_the_graph_is_built_from() {
        let node: IssueNode = serde_json::from_value(serde_json::json!({
            "identifier": "ENG-10",
            "title": "Do the thing",
            "priority": 2,
            "estimate": 3.0,
            "dueDate": "2026-09-05",
            "cycle": { "number": 17, "name": null, "startsAt": "2026-08-31T16:00:00.000Z", "endsAt": "2026-09-07T16:00:00.000Z" },
            "state": { "name": "Todo", "type": "unstarted" },
            "project": { "name": "Roadmap", "color": "#5e6ad2", "icon": null, "targetDate": "2026-09-30" },
            "projectMilestone": {
                "id": "milestone-1", "name": "Public beta",
                "targetDate": "2026-09-01", "sortOrder": 42.0
            },
            "parent": { "identifier": "ENG-9" },
            "assignee": {
                "name": "Ada Lovelace", "displayName": "ada",
                "avatarUrl": "https://example.com/a.png"
            },
            "inverseRelations": { "nodes": [
                { "type": "blocks", "issue": {
                    "identifier": "ENG-1", "title": "Done blocker",
                    "state": { "name": "Done", "type": "completed" } } },
                { "type": "blocks", "issue": {
                    "identifier": "ENG-2", "title": "Open blocker",
                    "state": { "name": "Todo", "type": "unstarted" } } },
                { "type": "duplicate", "issue": {
                    "identifier": "ENG-3", "title": "Not a blocker",
                    "state": { "name": "Todo", "type": "unstarted" } } }
            ] }
        }))
        .expect("assigned-issues response");

        let (task, blockers) = map_issue(node);

        let milestone = task.project_milestone.as_ref().expect("milestone");
        assert_eq!(milestone.id, "milestone-1");
        assert_eq!(milestone.sort_order, 42.0);
        assert_eq!(task.parent_id.as_deref(), Some("ENG-9"));
        assert_eq!(task.project_target_date.as_deref(), Some("2026-09-30"));
        assert_eq!(task.assignee.as_deref(), Some("Ada Lovelace"));
        // `dueDate` and `cycle` ride on `rename_all` too: without it the list
        // shows every ticket as undated and out of any cycle.
        assert_eq!(task.due_date.as_deref(), Some("2026-09-05"));
        let cycle = task.cycle.as_ref().expect("cycle");
        assert_eq!(cycle.number, 17.0);
        assert_eq!(cycle.name, None);
        assert_eq!(cycle.ends_at_ms, Some(1_788_796_800_000.0));
        assert_eq!(cycle.starts_at_ms, Some(1_788_192_000_000.0));
        // The two `blocks` relations, and not the duplicate.
        assert_eq!(task.blocked_by, ["ENG-1", "ENG-2"]);
        assert_eq!(blockers.len(), 2);
        // One blocker is still open, so this is not startable — the assertion that
        // would flip to `true` for every ticket if `inverseRelations` fell away.
        assert!(!task.ready);
    }

    /// The triage queue's ordering, decoded from the wire.
    ///
    /// [`TriageRow`] carries both of its camelCase timestamps behind `rename_all`,
    /// and both are `Option`: lose the attribute and they read `None`, which
    /// silently costs the queue its SLA ordering (everything ties at `i64::MAX`)
    /// and stops sinking snoozed tickets to the bottom.
    #[test]
    fn a_triage_row_decodes_the_timestamps_the_queue_is_ordered_by() {
        let row: TriageRow = serde_json::from_value(serde_json::json!({
            "identifier": "SUP-7",
            "title": "Customer can't log in",
            "priority": 1,
            "slaBreachesAt": "2026-08-30T17:00:00.000Z",
            "snoozedUntilAt": "2026-09-02T08:00:00.000Z",
            "state": { "name": "Triage", "type": "triage" },
            "team": { "key": "SUP" },
            "assignee": { "id": "u1" }
        }))
        .expect("triage inbox response");

        assert_eq!(
            row.sla_breaches_at.as_deref(),
            Some("2026-08-30T17:00:00.000Z"),
            "without this the whole queue ties at i64::MAX and loses its ordering"
        );
        assert_eq!(
            row.snoozed_until_at.as_deref(),
            Some("2026-09-02T08:00:00.000Z"),
            "without this a snoozed ticket stays at the top of the inbox"
        );
        assert_eq!(row.team.expect("team").key, "SUP");
        // The assignee id is what decides `mine`.
        assert_eq!(
            row.assignee.expect("assignee").id.as_deref(),
            Some("u1"),
            "without this every ticket reads as someone else's"
        );
        // …and the timestamps really are parseable into what the sort compares.
        assert!(row.sla_breaches_at.as_deref().and_then(parse_ms).is_some());
    }

    /// The discussion pane's issue, decoded from the wire. Same class again:
    /// `createdAt`/`slaBreachesAt`/`snoozedUntilAt` are `Option`s reached only
    /// through `rename_all`, and the nested `team { states }` is what fills the
    /// status picker.
    #[test]
    fn an_issue_detail_decodes_the_stamps_and_the_status_picker() {
        let node: IssueDetailNode = serde_json::from_value(serde_json::json!({
            "identifier": "SUP-7",
            "title": "Customer can't log in",
            "description": "Steps to reproduce…",
            "url": "https://linear.app/acme/issue/SUP-7",
            "priority": 1,
            "estimate": 2,
            "dueDate": "2026-09-05",
            "cycle": { "number": 17, "name": null, "startsAt": "2026-08-31T16:00:00.000Z", "endsAt": "2026-09-07T16:00:00.000Z" },
            "createdAt": "2026-08-20T09:00:00.000Z",
            "slaBreachesAt": "2026-08-30T17:00:00.000Z",
            "snoozedUntilAt": "2026-09-02T08:00:00.000Z",
            "state": { "id": "st-1", "name": "Triage", "type": "triage" },
            "team": { "states": { "nodes": [
                { "id": "st-1", "name": "Triage", "type": "triage", "color": "#eee", "position": 0.0 },
                { "id": "st-2", "name": "Todo", "type": "unstarted", "color": "#ddd", "position": 1.0 }
            ] } },
            "labels": { "nodes": [{ "name": "bug" }] },
            "project": { "name": "Support" },
            "projectMilestone": { "id": "m1", "name": "GA", "targetDate": "2026-10-01", "sortOrder": 1.0 },
            "assignee": { "name": "Grace Hopper", "displayName": "grace", "avatarUrl": null },
            "creator": { "name": "Ada Lovelace", "displayName": "ada", "avatarUrl": null },
            "comments": { "nodes": [], "pageInfo": { "hasNextPage": false, "endCursor": null } }
        }))
        .expect("issue detail response");

        assert_eq!(node.created_at.as_deref(), Some("2026-08-20T09:00:00.000Z"));
        assert_eq!(
            node.sla_breaches_at.as_deref(),
            Some("2026-08-30T17:00:00.000Z")
        );
        assert_eq!(
            node.snoozed_until_at.as_deref(),
            Some("2026-09-02T08:00:00.000Z")
        );
        assert_eq!(node.estimate, Some(2.0));
        assert_eq!(node.due_date.as_deref(), Some("2026-09-05"));
        let cycle = cycle_ref(node.cycle).expect("cycle");
        assert_eq!(cycle.number, 17.0);
        assert_eq!(cycle.ends_at_ms, Some(1_788_796_800_000.0));
        assert_eq!(cycle.starts_at_ms, Some(1_788_192_000_000.0));
        let states = node.team.expect("team").states;
        assert_eq!(states.nodes.len(), 2, "the status picker's options");
        assert_eq!(states.nodes[1].name, "Todo");
        assert_eq!(
            node.creator.expect("creator").display_name.as_deref(),
            Some("ada")
        );
        assert_eq!(
            node.assignee.expect("assignee").name.as_deref(),
            Some("Grace Hopper")
        );
        assert_eq!(node.project_milestone.expect("milestone").name, "GA");
    }

    /// A comment, decoded from the wire. `createdAt`, `botActor` and `children`
    /// all hang off `rename_all`: without it every comment is undated, every bot
    /// comment loses its author, and every reply thread renders empty while the
    /// query still fetches the replies.
    #[test]
    fn a_comment_decodes_its_date_its_bot_author_and_its_replies() {
        let node: CommentNode = serde_json::from_value(serde_json::json!({
            "id": "c1",
            "body": "Looks like a token refresh race.",
            "createdAt": "2026-08-21T10:00:00.000Z",
            "user": null,
            "botActor": { "name": "Devin", "avatarUrl": "https://example.com/d.png" },
            "children": {
                "nodes": [{
                    "id": "c2",
                    "body": "Agreed.",
                    "createdAt": "2026-08-21T11:00:00.000Z",
                    "user": { "name": "Ada Lovelace", "displayName": "ada", "avatarUrl": null }
                }],
                "pageInfo": { "hasNextPage": true, "endCursor": "c2cursor" }
            }
        }))
        .expect("comment response");

        assert_eq!(node.created_at.as_deref(), Some("2026-08-21T10:00:00.000Z"));
        assert_eq!(
            node.bot_actor.expect("bot actor").name.as_deref(),
            Some("Devin")
        );
        // A top-level comment: `parent` absent is what keeps it out of the replies.
        assert!(node.parent.is_none());
        let children = node.children.expect("children");
        assert_eq!(children.nodes.len(), 1);
        assert_eq!(children.nodes[0].body, "Agreed.");
        // The reply page's own cursor, which `all_replies` loops on.
        assert!(children.page_info.has_next_page);
        assert_eq!(children.page_info.end_cursor.as_deref(), Some("c2cursor"));
    }

    #[test]
    fn map_issue_maps_status_project_assignee_and_open_blockers() {
        let node = IssueNode {
            identifier: "ENG-10".into(),
            title: "Do the thing".into(),
            priority: 2,
            estimate: Some(3.0),
            due_date: Some("2026-09-05".into()),
            cycle: Some(CycleNode {
                number: 17.0,
                name: Some("Sprint 17".into()),
                ends_at: Some("2026-09-07T16:00:00.000Z".into()),
                starts_at: Some("2026-08-31T16:00:00.000Z".into()),
            }),
            state: Some(state("Todo", "unstarted")),
            project: Some(ProjectNode {
                name: Some("Roadmap".into()),
                color: Some("#fff".into()),
                icon: None,
                target_date: Some("2026-09-30".into()),
            }),
            project_milestone: Some(ProjectMilestoneNode {
                id: "milestone-1".into(),
                name: "Public beta".into(),
                target_date: Some("2026-09-01".into()),
                sort_order: 42.0,
            }),
            parent: Some(ParentIssueNode {
                identifier: "ENG-9".into(),
            }),
            assignee: Some(UserNode {
                id: Some("u1".into()),
                name: Some("Ada Lovelace".into()),
                display_name: Some("ada".into()),
                avatar_url: Some("https://example.com/a.png".into()),
            }),
            inverse_relations: Connection {
                nodes: vec![
                    RelationNode {
                        type_: "blocks".into(),
                        issue: Some(related("ENG-1", "completed")),
                    },
                    RelationNode {
                        type_: "blocks".into(),
                        issue: Some(related("ENG-2", "unstarted")),
                    },
                    // A non-"blocks" relation (e.g. duplicate) must be ignored.
                    RelationNode {
                        type_: "duplicate".into(),
                        issue: Some(related("ENG-3", "completed")),
                    },
                ],
                page_info: PageInfo::default(),
            },
        };

        let (task, blockers) = map_issue(node);

        assert_eq!(task.id, "ENG-10");
        assert_eq!(task.priority, santree_core::domain::Priority::High);
        assert_eq!(task.estimate, Some(3.0));
        assert_eq!(task.due_date.as_deref(), Some("2026-09-05"));
        let cycle = task.cycle.as_ref().expect("cycle");
        assert_eq!(cycle.number, 17.0);
        assert_eq!(cycle.name.as_deref(), Some("Sprint 17"));
        assert_eq!(cycle.ends_at_ms, Some(1_788_796_800_000.0));
        assert_eq!(cycle.starts_at_ms, Some(1_788_192_000_000.0));
        assert_eq!(task.project, "Roadmap");
        assert_eq!(task.parent_id.as_deref(), Some("ENG-9"));
        assert_eq!(task.project_target_date.as_deref(), Some("2026-09-30"));
        let milestone = task.project_milestone.as_ref().expect("milestone");
        assert_eq!(milestone.id, "milestone-1");
        assert_eq!(milestone.name, "Public beta");
        assert_eq!(milestone.target_date.as_deref(), Some("2026-09-01"));
        assert_eq!(milestone.sort_order, 42.0);
        assert_eq!(task.assignee.as_deref(), Some("Ada Lovelace"));
        assert_eq!(
            task.assignee_avatar_url.as_deref(),
            Some("https://example.com/a.png")
        );
        assert_eq!(
            task.blocked_by,
            vec!["ENG-1".to_string(), "ENG-2".to_string()]
        );
        // One of the two "blocks" blockers is still open -> not ready.
        assert!(!task.ready);
        assert!(task.actionable);
        assert_eq!(blockers.len(), 2);
    }

    #[test]
    fn map_issue_is_ready_when_every_blocker_is_done() {
        let node = IssueNode {
            identifier: "ENG-11".into(),
            title: "Unblocked".into(),
            priority: 0,
            estimate: None,
            due_date: None,
            cycle: None,
            state: Some(state("Todo", "unstarted")),
            project: None,
            project_milestone: None,
            parent: None,
            assignee: None,
            inverse_relations: Connection {
                nodes: vec![RelationNode {
                    type_: "blocks".into(),
                    issue: Some(related("ENG-1", "completed")),
                }],
                page_info: PageInfo::default(),
            },
        };
        let (task, _) = map_issue(node);
        assert!(task.ready);
        assert_eq!(task.project, "No Project");
        assert_eq!(task.assignee, None);
    }

    #[test]
    fn map_issue_in_progress_is_never_ready_even_with_no_blockers() {
        // Ready means "not yet started AND unblocked" — an already-started
        // ticket is never re-offered as ready to start.
        let node = IssueNode {
            identifier: "ENG-12".into(),
            title: "Already going".into(),
            priority: 0,
            estimate: None,
            due_date: None,
            cycle: None,
            state: Some(state("In Progress", "started")),
            project: None,
            project_milestone: None,
            parent: None,
            assignee: None,
            inverse_relations: Connection::default(),
        };
        let (task, _) = map_issue(node);
        assert!(!task.ready);
    }

    #[test]
    fn map_issue_defaults_missing_state_to_unstarted_unknown() {
        let node = IssueNode {
            identifier: "ENG-13".into(),
            title: "No state on the wire".into(),
            priority: 0,
            estimate: None,
            due_date: None,
            cycle: None,
            state: None,
            project: None,
            project_milestone: None,
            parent: None,
            assignee: None,
            inverse_relations: Connection::default(),
        };
        let (task, _) = map_issue(node);
        // TaskStatus::Todo is map_status("Unknown", "unstarted"); ready because
        // there are no blockers and the status is startable.
        assert!(task.ready);
    }

    #[test]
    fn map_related_keeps_the_blockers_project_horizon_and_milestone() {
        // Deserialized from JSON rather than built as a struct: `RelatedIssue`
        // has no `rename_all`, so a missing `rename` on `projectMilestone` would
        // read as `None` here and the assertion below is what catches it.
        let issue: RelatedIssue = serde_json::from_value(serde_json::json!({
            "identifier": "ENG-42",
            "title": "Someone else's blocker",
            "state": { "name": "In Progress", "type": "started" },
            "project": {
                "name": "KB Dupes and Conflicts",
                "color": "#5e6ad2",
                "icon": null,
                "targetDate": "2026-09-11"
            },
            "projectMilestone": {
                "id": "milestone-7",
                "name": "Cutover",
                "targetDate": "2026-09-04",
                "sortOrder": 1.5
            },
            "assignee": null
        }))
        .expect("related issue response");

        let task = map_related(issue);

        assert_eq!(task.project, "KB Dupes and Conflicts");
        assert_eq!(task.project_target_date.as_deref(), Some("2026-09-11"));
        let milestone = task.project_milestone.as_ref().expect("milestone");
        assert_eq!(milestone.id, "milestone-7");
        assert_eq!(milestone.name, "Cutover");
        assert_eq!(milestone.target_date.as_deref(), Some("2026-09-04"));
        assert_eq!(milestone.sort_order, 1.5);
        // A blocker is context, never the viewer's own work.
        assert!(!task.actionable);
    }

    #[test]
    fn map_related_without_a_project_or_milestone_maps_to_none() {
        let issue: RelatedIssue = serde_json::from_value(serde_json::json!({
            "identifier": "ENG-43",
            "title": "Unfiled blocker",
            "state": { "name": "Todo", "type": "unstarted" },
            "project": null,
            "assignee": null
        }))
        .expect("related issue response");

        let task = map_related(issue);

        assert_eq!(task.project, "No Project");
        assert_eq!(task.project_target_date, None);
        assert!(task.project_milestone.is_none());
    }

    // ── Repo → org resolution ─────────────────────────────────────────────

    #[test]
    fn an_explicit_link_wins_and_a_stale_one_falls_back() {
        let orgs = vec![
            ("alpha".to_string(), "Alpha".to_string()),
            ("zulu".to_string(), "Zulu".to_string()),
        ];
        assert_eq!(
            resolved_org(&orgs, Some("zulu")).map(|(s, _)| s.as_str()),
            Some("zulu")
        );
        // Defensive: `repos.linear_org_slug` is FK'd `ON DELETE SET NULL`, so a link
        // to a disconnected org shouldn't exist — if one ever did, both callers would
        // still agree on the fallback rather than one querying a dead workspace.
        assert_eq!(
            resolved_org(&orgs, Some("gone")).map(|(s, _)| s.as_str()),
            Some("alpha")
        );
        assert_eq!(
            resolved_org(&orgs, None).map(|(s, _)| s.as_str()),
            Some("alpha")
        );
        assert_eq!(resolved_org(&[], Some("zulu")), None);
    }

    /// The invariant the repo list's tracker column promises: the workspace it
    /// names is the one the repo's issue queries actually go to.
    #[tokio::test]
    async fn the_repo_list_names_the_org_its_queries_resolve_to() {
        let dir = std::env::temp_dir().join(format!("santree-org-resolve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = crate::db::init(dir.join("test.db")).await.unwrap();

        // Not in slug order — the fallback is "first by *name*".
        for (slug, name) in [("zzz", "Alpha"), ("aaa", "Zulu")] {
            sqlx::query("INSERT INTO linear_orgs (slug, name, expires_at) VALUES (?, ?, 0)")
                .bind(slug)
                .bind(name)
                .execute(&db)
                .await
                .unwrap();
        }
        sqlx::query(
            "INSERT INTO repos (name, tracker, path) VALUES ('acme/app', 'GitHub Issues', '/tmp/acme-app')",
        )
        .execute(&db)
        .await
        .unwrap();

        // Unlinked: the resolver and the list must land on the *same* first org —
        // first by name, which is neither the first by slug nor by insertion.
        assert_eq!(
            resolve_org_slug(&db, "acme/app").await.unwrap().as_deref(),
            Some("zzz")
        );
        assert_eq!(
            crate::repo::list(&db).await.unwrap()[0].tracker,
            "Linear · Alpha"
        );

        // …and with an explicit link, both follow it.
        sqlx::query("UPDATE repos SET linear_org_slug = 'aaa' WHERE name = 'acme/app'")
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            resolve_org_slug(&db, "acme/app").await.unwrap().as_deref(),
            Some("aaa")
        );
        assert_eq!(
            crate::repo::list(&db).await.unwrap()[0].tracker,
            "Linear · Zulu"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── OAuth callback ────────────────────────────────────────────────────

    /// The bug this guards: the accepted socket inherits the listener's
    /// non-blocking flag on macOS/BSD, so the first `read` returned `WouldBlock`
    /// before the browser's bytes arrived — the request was read as empty, answered
    /// with "Authentication failed", and the auth code was lost. A silent peer
    /// (browser preconnect) accepted first must not consume the flow either.
    #[test]
    fn the_callback_waits_for_a_slow_browser_and_ignores_a_silent_peer() {
        use std::io::{Read as _, Write as _};
        use std::net::{TcpListener, TcpStream};
        use std::time::{Duration, Instant};

        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let addr = listener.local_addr().unwrap();

        let client = std::thread::spawn(move || {
            let _silent = TcpStream::connect(addr).unwrap();
            let mut real = TcpStream::connect(addr).unwrap();
            // The request lands only after the socket has been accepted.
            std::thread::sleep(Duration::from_millis(150));
            real.write_all(b"GET /?code=abc%2F123&state=st HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
            let mut resp = String::new();
            real.read_to_string(&mut resp).unwrap();
            assert!(resp.contains("successful"), "{resp}");
        });

        let code = accept_code(&listener, "st", Instant::now() + Duration::from_secs(10)).unwrap();
        // Percent-decoded, and not truncated to whatever arrived in the first read.
        assert_eq!(code, "abc/123");
        client.join().unwrap();
    }

    /// A peer that connects and says nothing must not park the flow past its
    /// deadline (it used to be read on the accept thread, with no read timeout).
    #[test]
    fn a_silent_peer_cannot_park_the_callback_past_its_deadline() {
        use std::net::{TcpListener, TcpStream};
        use std::time::{Duration, Instant};

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

    /// Declining in Linear redirects with `error=…` and no code: the flow ends
    /// immediately instead of sitting out the timeout.
    #[test]
    fn a_denied_authorization_fails_fast() {
        use std::io::Write as _;
        use std::net::{TcpListener, TcpStream};
        use std::time::{Duration, Instant};

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

    #[test]
    fn split_identifier_accepts_real_linear_ids() {
        assert_eq!(split_identifier("AK-165"), Some(("AK", 165)));
        assert_eq!(split_identifier("MSG-5033"), Some(("MSG", 5033)));
        // Digits are legal *inside* a team key, and the split is from the right.
        assert_eq!(split_identifier("A11Y-7"), Some(("A11Y", 7)));
    }

    #[test]
    fn split_identifier_rejects_things_that_only_look_like_ids() {
        // Lower-case is how `ticketIdFor` avoids reading prose as an id; keep the
        // two sides of the bridge agreeing on that, or grouping silently over-matches.
        assert_eq!(split_identifier("ak-165"), None);
        assert_eq!(split_identifier("A-1"), None); // key too short
        assert_eq!(split_identifier("TOOLONGAKEY-1"), None);
        assert_eq!(split_identifier("AK-"), None);
        assert_eq!(split_identifier("AK-1a"), None);
        assert_eq!(split_identifier("AK-1.5"), None);
        assert_eq!(split_identifier("AK165"), None);
        assert_eq!(split_identifier("AK--1"), None);
    }

    /// Linear's rate-limit headers, verbatim.
    ///
    /// The names are the whole contract — nothing else in the codebase mentions
    /// them, and a typo produces no error anywhere: the meter just stays empty
    /// and reads as "no budget information" forever. This asserts the exact
    /// spellings from Linear's own docs, and that the reset time is passed
    /// through as the epoch **milliseconds** Linear sends (GitHub's equivalent
    /// is seconds, and the two meet in one frontend component).
    #[test]
    fn a_response_records_linears_own_rate_limit_header_names() {
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("X-RateLimit-Requests-Limit", "5000"),
            ("X-RateLimit-Requests-Remaining", "4812"),
            ("X-RateLimit-Requests-Reset", "1787938231000"),
            ("X-RateLimit-Complexity-Limit", "2000000"),
            ("X-RateLimit-Complexity-Remaining", "1904221"),
            ("X-RateLimit-Complexity-Reset", "1787938231000"),
        ] {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_static(value),
            );
        }
        record_budget("header-names-org", &headers);

        let map = BUDGETS.read().unwrap();
        let budget = map.get("header-names-org").expect("a recorded reading");
        assert_eq!(
            budget.windows.iter().map(|w| w.kind).collect::<Vec<_>>(),
            vec![ApiBudgetKind::Requests, ApiBudgetKind::Complexity]
        );
        assert_eq!(budget.windows[0].remaining, 4812.0);
        assert_eq!(budget.windows[0].limit, 5000.0);
        assert_eq!(
            budget.windows[0].resets_at_ms,
            Some(1_787_938_231_000.0),
            "Linear already sends epoch milliseconds — do not scale it"
        );
        assert_eq!(budget.windows[1].limit, 2_000_000.0);
        assert!(budget.observed_at_ms > 0.0, "the reading is stamped");
    }

    /// A response with no rate-limit headers leaves the last good reading alone.
    /// Overwriting it with an empty one would render as "0 of 0 left", which is
    /// a claim we never had grounds to make.
    #[test]
    fn a_response_without_the_headers_keeps_the_last_reading() {
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("X-RateLimit-Requests-Limit", "5000"),
            ("X-RateLimit-Requests-Remaining", "4000"),
        ] {
            headers.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_static(value),
            );
        }
        record_budget("silent-org", &headers);
        record_budget("silent-org", &HeaderMap::new());

        let map = BUDGETS.read().unwrap();
        let budget = map.get("silent-org").expect("the earlier reading survives");
        assert_eq!(budget.windows.len(), 1);
        assert_eq!(budget.windows[0].remaining, 4000.0);
    }

    /// A half-reported pool is dropped rather than defaulted. `limit` without
    /// `remaining` would meter as fully spent.
    #[test]
    fn a_pool_missing_one_of_its_counts_is_not_recorded() {
        use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_bytes(b"X-RateLimit-Requests-Limit").unwrap(),
            HeaderValue::from_static("5000"),
        );
        assert!(header_window(&headers, ApiBudgetKind::Requests, "X-RateLimit-Requests").is_none());
    }
}
