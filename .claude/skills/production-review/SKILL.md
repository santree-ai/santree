---
name: production-review
description: Run a full production-readiness review of santree-app (multi-agent fan-out, adversarial verification, PRODUCTION_REVIEW.md with checkbox tracking), or burn down an existing PRODUCTION_REVIEW.md via the disjoint-file wave pattern. Use when asked for a full/production/pre-release review of the codebase, or to fix the findings of one. Pass `fix` as args to go straight to fix mode.
---

# Production-readiness review

Two modes. **Review mode** produces/refreshes `PRODUCTION_REVIEW.md`. **Fix mode**
burns down an existing `PRODUCTION_REVIEW.md`. The user prefers these as separate
sessions — don't slide from one into the other unasked.

Both modes: read `CLAUDE.md` and `COMPLIANCE.md` first. If `PRODUCTION_REVIEW.md`
already exists, read it — its own checkboxes are the source of truth for what's
done; never trust remembered "N of M fixed" counts, they go stale.

## Review mode

Use the **Workflow tool** for the fan-out (it's resumable via `resumeFromRunId` —
a previous run of this review died mid-dispatch and lost everything; a workflow
run would not have).

**Phase 1 — finders**, one agent per disjoint slice, each returning structured
findings. Slices: core crates (`crates/core`, `crates/pty`); Rust backend split
into 2–3 disjoint file groups (`commands.rs`+`lib.rs` / `linear.rs`+`github.rs`+
`reviews.rs` / `db.rs`+`repo.rs`+`settings.rs`+`terminal.rs`+`git.rs`+migrations);
frontend data layer (`queries.ts`, `main.tsx`, `state/`, `bindings.ts` usage);
each feature view (`features/*`); shared UI (`components/`, `theme/`); ops
(CI, bundling, logging, updater). Every view is real — nothing is mocked, so
nothing is out of scope on "still mocked" grounds.

Categories per finder: correctness; React/TanStack idioms; Rust/tokio/Tauri
idioms; security (the CLAUDE.md invariants: IPC path/id/branch validation,
parse-at-sink host matching, keychain-only secrets); COMPLIANCE.md drift; perf;
architecture; readability; UX responsiveness (optimistic updates); ops
readiness; testing gaps; deps; a11y.

Per-finding format: Title / Location (`file:line`) / Category / Severity /
Effort / Confidence / Problem / Why it matters / Suggested fix.

**Phase 2 — adversarial verify**: every High (and any low-Confidence) finding
gets an independent skeptic agent prompted to REFUTE it against the actual
code. Drop refuted findings.

**Phase 3 — synthesize**: dedupe, then triage with this project's philosophy
(zero users, runs locally): bucket findings as **(1) Do now** — bites daily
local use, especially silent data loss/repo corruption; **(2) Before
distributing** — signing, updater, release pipeline; **(3) Security,
threat-model-dependent**. Lead with tier 1; severity labels alone are not the
ordering. Respect existing `⏸ deferred` markers (e.g. signing/notarization) —
don't re-raise parked work.

**Write `PRODUCTION_REVIEW.md`** with checkbox tracking: every findings table
leads with a `Done` column (`[ ]` per row); quick wins, roadmap, and readiness
checklist are real `- [ ]` task lists; genuinely-clean categories are
pre-checked `[x]`; a short "how to use this doc" note at the top states the
rule: only flip `[ ]` → `[x]` when the fix is real and verified.

## Fix mode

Work order: quick wins → phase 1 → 2 → 3, higher severity first within a phase.

**Wave pattern** (proven across 5+ waves, ~150 findings, zero surviving
regressions):

1. Group findings into **disjoint-file batches** — two concurrent agents never
   touch the same file. Give each agent the finding's full tracker text, not a
   summary. Big structural findings touching shared state (`model.tsx`,
   `queries.ts`, `domain.rs`, `linear.rs`) are done serially by the main
   session, not parallelized.
2. Dispatch the whole wave at once; don't verify agents one-by-one.
3. **One consolidated verification pass after the wave lands** — the /verify
   skill's static gates, in its order. Only then spot-check each finding's fix
   is actually in the diff.
4. **Never chase mid-wave failures.** Agents report "pre-existing" compile/lint
   errors that are just another agent's edit mid-flight; they resolve when the
   wave lands. Investigate only failures still present in the consolidated pass.
5. **Fixes must be real**: open the cited code → confirm it still reproduces →
   fix → verify the behavior changed → only then tick. A non-reproducing
   finding is a valid outcome: leave `[ ]` with a note, never force a tick.
6. **Only the orchestrating session edits `PRODUCTION_REVIEW.md`** — subagents
   never touch it.
7. Autonomy: internal/security/perf fixes — just do them. User-visible changes
   (new UI, copy, defaults) — batch into one question, don't interrupt per item.
8. High-risk changes (wire formats, PTY, migrations) get manual review beyond
   the agent's report: read the diff, exercise it live.
9. At the end, clean up stray agent worktrees/stashes after confirming their
   contents are superseded in the main tree. Leave committing to the user.
