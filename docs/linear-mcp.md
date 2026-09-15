# Linear through its MCP server

The last-resort way to connect Linear, for workspaces that won't let santree's
OAuth app in and won't hand out API keys, but do allow Linear's hosted MCP
server. The full OAuth connection stays the default; this one is offered
beneath it, says what it can't do before it starts, and steps aside the moment
the same workspace is connected the normal way.

Status: **in progress** — phase 0 (measuring the server), phase 1 (sign-in),
phase 2 (reads), phase 3 (writes) and phase 4 (the UI's feature gating) are
done. What
the measuring found is in "Measured" at the end, and the fallbacks below are
written against it.

## Why it works, and why it is the last resort

`mcp.linear.app` is Linear's own OAuth 2.1 authorization server, separate from
the `linear.app/oauth` one santree's app is registered with. A client registers
itself there, so a workspace that only approves the MCP server still lets
santree sign in — measured against a real workspace where the OAuth app was
blocked. But:

- **The token only works at the MCP server.** `api.linear.app/graphql` answers
  it with a 401, so none of `linear.rs`'s GraphQL is reusable. Everything goes
  through MCP tool calls.
- **The tools are narrower than GraphQL.** No triage rotations, no snooze, no
  batch lookup by identifier.
- **Tool output is not a contract.** Results are JSON inside MCP text content,
  written for a model to read, with no output schema. Linear can reshape them
  without notice; the mapping has to be defensive and pinned by tests.
- **It exists for AI clients.** Linear may throttle or restrict other callers.

## Shape

An MCP connection is still **Linear**: `TicketProvider::Linear`, the same logo,
links (`linear.app/<slug>/issue/<id>`), prompts and tracker switch. What differs
is *how the org is connected*, recorded per org:

- `linear_orgs.auth` — `'oauth'` (default; every existing row) or `'mcp'`;
  `linear_orgs.mcp_client_id` — the MCP client an `'mcp'` grant belongs to
  (migration `0033`).
- `LinearOrg.via` / `LinearStatus.via` — `LinearConnection::{OAuth, Mcp}`, so the
  UI knows which features exist.
- `tracker::repo_tracker` hands a Linear repo to `LinearTracker` or
  `LinearMcpTracker` by its org's `auth`. Every provider-neutral command already
  dispatches through `tracker::*`, so none of them change.
- Tokens live in the keychain under `linear-mcp:{slug}`, never `linear:{slug}`:
  a row and a credential of different kinds must not be able to pair up and
  refresh against the wrong token endpoint.
- Connecting the same org through full OAuth later flips the row to `'oauth'`
  and deletes the `linear-mcp:` entry — the normal connection always wins.

Code: `src-tauri/src/linear_mcp/` — `auth.rs` (sign-in, on top of `oauth.rs`),
`client.rs` (JSON-RPC over Streamable HTTP), `tracker.rs` (the
`TicketTracker` impl: which tools a read calls, fan-out and caches), `wire.rs`
(the tools' shapes and the pure tool → domain mapping).

## Sign-in

On top of `oauth.rs` (PKCE, the `localhost:8420` callback, refresh locks,
`token_request`), plus what the MCP authorization spec requires:
`resource=https://mcp.linear.app/mcp` on both the authorize and token requests.
Scope follows the existing `linear_scope` setting (`read` or `read write`). The
org slug comes from `get_workspace`'s url, matched by parse
(`host == linear.app`, first path segment), never by prefix.

## Fallbacks

Each decision below has a preferred path and the one santree takes when the
preferred one isn't available. They are the load-bearing choices; change one
here before changing it in code.

### Client identity: metadata document, else dynamic registration

- **Preferred — Client ID Metadata Document.** The MCP spec's recommended
  mechanism, and Linear advertises it (`client_id_metadata_document_supported`).
  santree's `client_id` is an https URL on the website
  (`https://santree.toscanini.me/oauth/linear-mcp-client.json`, served from
  `website/public/`), naming santree and `http://localhost:8420` as the
  redirect. One stable identity for every install, and nothing to store.
- **Fallback — Dynamic Client Registration.** `POST /register` on **every**
  connect (a public client, `token_endpoint_auth_method: none`), its
  `client_id` stored on the org row (`linear_orgs.mcp_client_id`): a refresh
  and a revocation must present the client the grant was issued to, so the id
  belongs with the grant, not with the install. Nothing to keep valid, and no
  `invalid_client` recovery. Proven against a real workspace; the spec marks
  DCR deprecated, which is why it is second.
- **Why DCR ships first:** the metadata document can only be tested once it is
  live on the website, which deploys from `main`. Until then Linear rejects a
  URL client id with the same "Invalid client" as a made-up one, so there is
  nothing to measure. Switch once the document is published and a sign-in
  through it succeeds; keep DCR behind it for as long as Linear offers it.

### Writes: read-only when the tools aren't there

- **Preferred:** status changes, comments and "move to started" through MCP's
  write tools, gated exactly as today (`linear_scope` + the granted scope).
  They exist: `save_issue` (`id` + `state` — a state id, name or type) and
  `save_comment` (`issueId`, `parentId` for a reply, `body`). Both are annotated
  destructive and non-idempotent, so neither is resent after a response that
  could mean it was applied (a gateway failure, a timeout). A 401 or a
  dropped-session 404 is a refusal, and those alone are sent again. Their
  output is not decoded (`client::call_write`): it was never measured, and a
  write that landed must not report failure because its confirmation didn't
  parse — only the tool's own error flag fails it. Every write, sent or
  failed, drops the org's issue list (as a GraphQL write does) and that issue's
  own cached copy (which only the MCP reads keep).
- **"Move to started" has no position to go by.** `list_issue_statuses` returns
  `id`, `name`, `type` only, so GraphQL's "lowest-position started state" can't
  be computed. It takes the first `started` state that `core::linear::map_status`
  reads as in progress — not one named like Blocked or In Review — and failing
  that, the first `started` state.
- **Fallback:** if a write tool is missing — gone from a later `tools/list`, or
  the org was connected read-only — that write is off for MCP orgs: the command
  refuses it with a message naming the connection, and `useTrackerFeatures`
  turns the control off with the reason. Read-only is a supported shape, not a
  broken one.

### Triage scope: the teams you belong to

- **GraphQL:** the saved `triage_teams` rules — rotations you're in, teams
  holding a ticket of yours, member teams, picks — plus your own triage tickets
  wherever they are.
- **MCP:** only the triage inboxes of the teams you're a **member** of
  (`wire::mcp_triage_rules`). There are no rotations to read, and a team where
  you merely hold a ticket isn't yours to triage — neither it nor your tickets
  on other teams are included. Saved rules can only narrow this: a hidden team
  stays hidden; the rotation, assigned and picked rules don't apply. The Teams
  card says so for MCP orgs and greys the rules that don't apply.
- **The team filter isn't exact.** Asked for a viewer's seven teams, `list_issues`
  answered with 1,072 triage tickets, many on teams they aren't in (measured
  2026-09-14). A ticket is kept only when the team key in its identifier is one
  of the teams in scope; the log line counts what was left out.
- **"Your teams" is Linear's answer.** `get_user me` lists parent teams (an
  "Engineering" above the team you work in) beside the team itself, and MCP has
  no way to tell the two apart — a parent team's own triage inbox is included.
- **The team list is narrower.** No tool lists an org's teams with their keys
  (`list_teams` and `get_team` have none), so an MCP org's teams are the ones a
  key can come from: the viewer's own (`get_user me`) and those holding a triage
  ticket of theirs (off the identifier). A team outside both can't be picked.

### Triage rotations and snooze: not offered

- `triage_schedule` returns an empty list, as Jira's does: no rotation chips.
  Never a fabricated "no rotation" — that would claim something Linear didn't
  say. `LinearTeam`'s rotation fields are unknown over MCP, not `false`.
- MCP issues carry no `snoozedUntilAt`: every triage ticket is active, there is
  no Snoozed lane, and `triage_snooze` refuses like it does for Jira.

### Blockers and lookups by id: one issue at a time

- `list_issues` carries no relations, and there is no lookup by identifier list.
  Blockers (`Task.blocked_by`) and `tickets_by_id` fall back to `get_issue` per
  ticket, at capped concurrency, cached briefly. Slower than GraphQL's batch;
  same result. An issue's blockers are cached by its id *and* `updatedAt`, so
  only issues that changed are read again; ten minutes bounds what a change
  that doesn't touch `updatedAt` leaves stale.

### Images: the signed url, else the link

- **Preferred:** the `uploads.linear.app` urls in MCP markdown are pre-signed
  (`?signature=`, a 300-second lifetime) and load **without a token**. Inline
  them right after the `get_issue` / `list_comments` that returned them, through
  `linear.rs`'s existing span scan, size cap and cache — keyed on the url
  *without* its signature, or every fetch is a cache miss. Never attach the MCP
  token to that request: the MCP spec forbids sending its tokens anywhere but
  the MCP server, and the signature makes it unnecessary.
- **Fallback:** a fetch that fails (the signature lapsed on a slow page) leaves
  the url in the markdown, as a failed fetch does for GraphQL. Reopening the
  ticket reads fresh urls.
- Not `extract_images`: it failed to fetch the same attachment the plain
  request loaded.

### Missing fields: derive, or leave empty

Never a placeholder shown as data. Where MCP has no field:

- `WorkflowState.color` — MCP statuses have none; Linear's default colour for
  the state's type (`wire::state_type_color`), as Jira's statuses are coloured by
  category. The picker's order is by category too: there is no position.
- estimate, cycle and milestone on the ticket page — `get_issue` carries none.
  Taken from the viewer's own issue list when the ticket is in it (usually: it
  is their work), else empty.
- a PR's ticket (Reviews' project grouping) — no milestone, for the same reason.
- cycle — `list_issues` carries only `cycleId`; `list_cycles` (per team,
  cached) gives `number`, `startsAt`, `endsAt`. MCP cycles have no name, and
  `CycleRef.name` is already optional.
- milestone — issues carry `{id, name}`. `sort_order` comes from
  `list_milestones` (which has no target date) and `target_date` from
  `get_project` with `includeMilestones` (which has no sort order); both cached
  per project. A milestone missing from both lists is left off rather than
  given a made-up order.
- project colour / icon / target date — from `get_project`, cached per project.
- estimate — `{value, name}`; `value` is `Task.estimate`.
- assignee / creator avatar — issues carry names and ids only; `get_user` per
  distinct id (cached five minutes) gives `avatarUrl`, which many users don't
  have. `list_users` would page through the whole org. The creator's *name*
  comes from the same lookup: issues give only `createdBy` as an email.
- team key — from the identifier, as `linear::team_ref` already does.

### API budget: omitted

The budget card reads Linear's rate-limit headers off GraphQL responses. The
MCP server sends none, so MCP orgs have no budget entry.

### Staying signed in: refresh, else ask to reconnect

- **Preferred:** refresh the access token before it expires (it lasts
  86 100 s, just under a day), through `oauth.rs`'s per-org refresh lock, as
  Linear's GraphQL connection does. The lock is load-bearing here, not
  belt-and-braces: the server rotates the refresh token, briefly still accepts
  the parent, and a second refresh with that parent **revokes the child the
  first one just stored**. Two concurrent refreshes would sign the org out.
  Inside the lock, re-read the keychain before refreshing (as `valid_token`
  does), and write the rotated pair before releasing it.
- **Measure it in phase 1:** why a refresh token can be rejected on first use
  is unexplained (see "Measured"). Log every `invalid_grant` with the refresh
  token's age — never the token — so dogfooding says whether the reconnect
  below is a rare event or a daily one.
- **Fallback:** a refresh answered `invalid_grant` means the grant is gone. The
  org stays in the list but reads as *needs reconnecting* — reads return the
  error rather than an empty queue (an empty queue would claim Linear has no
  tickets), and Settings and the rail's connect prompt offer **Reconnect via
  MCP**, which runs the same sign-in and replaces the credential in place. If
  refresh tokens don't work at all (see "Measured"), that is a once-a-day
  sign-in: worse, but still a working connection.

### Transport retries: declared by the caller

`gql::send` only resends a POST whose body is a GraphQL query without a
mutation; a `tools/call` body has no `query`, so it would never be resent.
Callers declare it instead: read tools resend once on a gateway failure (502,
503, 504), write tools never — the server's own `idempotentHint: false` agrees.
A 401 forces a token refresh and retries once, as `Session::query` does.

The server is stateless: `initialize` returns no `mcp-session-id`. The client
still sends one back if a future server hands it out, and re-initializes on the
404 the spec prescribes for an expired session.

## UI

- **Settings → Integrations → Linear:** Connect stays the brand-coloured
  primary. Beneath the card, a quiet row — "Can't connect? Some workspaces block
  OAuth apps…" — with a secondary **Connect via MCP**. A confirm dialog lists
  what won't work before the browser opens. The org row wears a `via MCP` badge.
- **Per-repo tracker card:** unchanged — one Connect. The last resort lives only
  in Integrations.
- **`useTrackerFeatures(repo)`** (`lib/tracker` `trackerFeatures`) —
  `{ snoozeUnavailable, threadedComments, memberTeamsOnly }` from the provider
  and the Linear connection. The Jira branch's `provider === "Jira"` checks
  moved onto it, so another kind of connection is one entry, not a check per
  view:
  - a triage row's menu keeps its snooze rows, disabled with the reason;
  - a comment offers Reply only where comments are threaded;
  - Settings → Triage → Teams says an MCP org triages its member teams, shows
    the rules as they apply there, and leaves only "Never show" to change.

  While the Linear status loads it reads as OAuth, so an ordinary install never
  flickers disabled; the backend refuses what an MCP org can't do either way.
- **No flag needed:** rotation chips and the Snoozed lane draw from data an MCP
  org never has (no schedules, no snoozed tickets); the API budget card lists
  only orgs with a reading; writes are gated by `LinearStatus.canWrite`, as for
  any read-only connection.

## Phases

0. Measure the server with a `read write` sign-in: write tools and arguments,
   `list_issue_statuses` / milestone / estimate shapes, `extract_images`,
   rate-limit headers, refresh-token rotation, session lifetime. Sanitised
   responses become test fixtures.
1. Sign-in: migration, `via`, `linear_mcp::auth` + `client`, `linear_mcp_connect`,
   the Settings row.
2. Reads: issues, triage, detail, `tickets_by_id`, team scope, images.
3. Writes, for the tools phase 0 found.
4. `useTrackerFeatures` gating across the UI, fixtures, CLAUDE.md.

## Measured

Phase 0, against a real workspace whose admins block OAuth apps, on 2026-09-13.
The server is not a contract; re-measure before trusting a line here that a
bug report contradicts.

| | |
|---|---|
| Sign-in | DCR (`POST /register`, `token_endpoint_auth_method: none`) + PKCE + `resource` works, with `http://localhost:8420` as the redirect; `read` and `read write` both granted to a non-admin |
| Metadata document | untested — Linear answers a URL `client_id` whose document doesn't exist yet with the same "Invalid client" as a bogus id |
| Token | bearer, `expires_in` 86 100 s, a refresh token issued. **401 at `api.linear.app/graphql`** — MCP only |
| Refresh | **rotates**, and only the newest refresh token is good. Straight after sign-in: refreshing with R0 → 200 and R1; replaying R0 → 200 again (a short grace for the parent) — and that replay revoked R1 (`invalid_grant`). Separately, a refresh token first used ~15 minutes after its sign-in was rejected outright while its access token still worked: cause unknown, possibly a short refresh-token lifetime |
| Revocation | `POST /token` with `token` + `token_type_hint` + `client_id` → 200 for both tokens, and the access token 401s immediately after. A replaced MCP credential is revoked once its replacement is stored (there is no disconnect yet) |
| Transport | Streamable HTTP, protocol `2025-06-18`, **no `mcp-session-id`** (stateless), no rate-limit headers |
| Read tools | `list_issues` (≤250/page, cursor; `fields` includes `estimate {value,name}`, `projectMilestone {id,name}`, `cycleId`, `parentId`, `sla*`, `triageIntel`; `state` takes one type), `get_issue` (relations, attachments, state history — no estimate, cycle or milestone), `list_comments` (`parentId`, `author {id,name}`), `list_issue_statuses` (`id,name,type` only), `list_cycles` (`number,startsAt,endsAt`, no name), `list_milestones` (`sortOrder`, no target date), `get_project`/`list_projects` (`color,icon,targetDate`, milestones with target date), `list_users` (`avatarUrl` when set), `get_user me` (teams with keys), `get_workspace` (`url`) |
| Write tools | `save_issue` (`id`, `state`, …), `save_comment` (`issueId`, `parentId`, `body`) — `destructiveHint: true`, `idempotentHint: false`. No issue snooze (`mark_notification` snoozes inbox notifications only). A status change, a comment, a reply and move-to-started all worked from the app (2026-09-15) |
| Absent | triage rotations / `triageResponsibility`, `snoozedUntilAt`, lookup by identifier list, workflow-state colour and position |
| Images | `uploads.linear.app` urls are pre-signed for 300 s and load without a token; `extract_images` failed on one the plain request loaded |
| Descriptions | mentions arrive as `<issue id=… href=…>` / `<user id=…>` tags, not markdown links; list results truncate descriptions |
