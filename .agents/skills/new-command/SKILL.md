---
name: new-command
description: End-to-end checklist for adding or changing a Tauri command in santree-app — domain type, #[tauri::command], bindings regeneration, query hook, view wiring, and the IPC security gate. Use whenever adding a new backend capability the frontend will call, or changing an existing command's signature.
---

# Adding a Tauri command, end to end

The typed bridge is sacred: React view → hook in `src/lib/queries.ts` →
generated `src/bindings.ts` → `#[tauri::command]` → backend module. Never
`invoke` directly, never hand-edit `bindings.ts`.

## Steps

1. **Domain types** — `crates/core/src/domain.rs`, derive
   `Serialize, Deserialize, specta::Type` (+ `Clone, Debug`). Ship plain enums;
   presentation (colors/labels) is the frontend's job via `src/theme/colors.ts`.
   For GraphQL-backed structs: explicit `#[serde(rename_all = "camelCase")]`,
   and `#[serde(default)]` requires the field type to implement `Default`.
   Paginated lists reuse the generic `Connection<T>` — don't add a new
   `*Conn` struct. Avoid `f64` fields on types that need `Eq` (it breaks the
   derive cascade).
2. **Command** — thin wrapper in `src-tauri/src/commands.rs`; real logic in the
   backend module (`linear.rs`, `github.rs`, `repo.rs`, …). When the backend
   isn't connected, return real-but-empty (`unwrap_or_default()`, `Ok(vec![])`)
   — never sample data, never hardcoded placeholder field values.
3. **Register** it in the `collect_commands![...]` list in `src-tauri/src/lib.rs`.
4. **Security gate** (load-bearing — run this checklist on every param):
   - Any param that becomes a **path or id**: through `git.rs` `safe_path` /
     `safe_real_path` (single normal component; reject `..`, absolute,
     symlink-escape). Never raw `Path::join`.
   - Any param that becomes a **git argv** (branch, ref, base): reject leading
     `-` (flag injection). Shell via the `git.rs` helpers, never raw.
   - Any **URL/host check**: parse at the sink — `url.host_str() == Some("…")`,
     never `starts_with(...)`.
   - Secrets go to the OS keychain, never a plaintext SQLite column.
5. **Regenerate bindings** — `pnpm gen:bindings`, commit the changed
   `bindings.ts` with the same change (CI fails on drift).
6. **Query hook** — in `src/lib/queries.ts`, nowhere else. Result-typed
   commands → `useUnwrappedQuery`; raw values → plain `useQuery`; writes →
   `useOptimisticMutation` (cancel → patch → rollback → invalidate) or
   `useActionMutation` for fire-and-invalidate. Cross-check every invalidation
   key against a real registered `useQuery` key — dead keys fail silently.
7. **Wire the view** — feature state in `features/<view>/model.tsx`, shared
   state in `AppContext`, server data only via the hook.
8. **Verify** — run the /verify skill (at minimum its static gates).

## Recurring bug classes to check before finishing

- **Linear state-type filters**: any query filtering by state type must handle
  the full terminal/non-startable set — `"triage"`, `"duplicate"`, and the
  custom "Blocked" (type `unstarted`) have each been missed once already.
- **GraphQL**: HTTP 200 with `{data: null, errors: [...]}` needs an explicit
  error check; watch query complexity (cap 10000) when adding fields.
- **Non-idempotent effects** driven by the new data (PTY spawn, setup scripts,
  worktree create) must stay mounted with `display:none`, never `cond && <C/>`.
- **New SQLite state**: add a migration in `src-tauri/migrations/`; test CHECK
  constraints against real values.
