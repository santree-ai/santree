/**
 * What a coding CLI's terminal title says it is doing.
 *
 * **This is a read-only signal and must stay one.** `COMPLIANCE.md` bars
 * output-parsing that drives input: santree never scrapes a terminal to decide
 * what to send back to it. Reading the OSC 0/2 title sequence to pick a *status
 * dot* is passive and display-only — the classification below reaches
 * `lib/attention.ts` and stops there. It must never gate a launch, never choose
 * a prompt, and never become an argument to a command. If you find yourself
 * wanting a title here to influence a PTY write, that is the line this file
 * exists on the safe side of.
 *
 * It is also deliberately a *fallback*. The hook events santree's own
 * `santree-hook` writes are the authority (see `levelOf`); a title only speaks
 * when the last hook event is too old to be believed, which is exactly the
 * failure this exists for: a `Stop` lands, the next turn's `UserPromptSubmit`
 * never fires, and the row reads idle while the agent works for another hour.
 *
 * ## The real titles
 *
 * Captured on 2026-08-28 by running each CLI under a PTY and recording every
 * `ESC ] 0 ; … BEL` it emitted — not guessed, and not copied from a vendor doc.
 *
 * **Claude Code** (`claude` 2.x, the native binary) — ~2 title writes/second:
 * ```
 * "✳ Claude Code"        idle, no turn yet          (U+2733)
 * "◐ Claude Code"        working                    (U+25D0)
 * "◑ Notes.txt poem"     working, with a task label (U+25D1)
 * "✳ Notes.txt poem"     turn finished, at rest
 * ```
 * The leading glyph is the whole signal: an eight-spoked asterisk at rest, a
 * quarter-circle spinner frame while a turn runs. (Older Claude builds animated
 * the same slot with braille frames; both blocks are matched below so an
 * upgrade or a downgrade can't silently turn every agent idle.)
 *
 * **Codex** (`codex` 0.150.1) — ~10 title writes/second while running:
 * ```
 * "titlelab2"            idle — the bare cwd basename, no glyph
 * "⠋ titlelab2"          working                    (U+280B, braille)
 * "⠙ titlelab2"          working                    (U+2819)
 * ```
 * Codex names no agent and marks no state at rest, so its idle title carries
 * *no evidence at all* and classifies as `null` rather than as idle. That is the
 * honest answer and costs nothing: with nothing to say, the arbiter falls
 * through to its own "at rest" default anyway.
 */
import type { AttentionLevel } from "../../lib/attention";

/**
 * What a title can assert. A strict subset of {@link AttentionLevel} — there is
 * one agent-state vocabulary in this app and a title speaks it, rather than
 * introducing a second one that something downstream would have to translate.
 *
 * `needs-you` is deliberately absent. Neither CLI marks "blocked on you" in its
 * title (Claude keeps the same glyph through a permission prompt), so inferring
 * it would be a guess — and a false "needs you" is the one error this tree
 * cannot afford: it is an alarm you can't act on or dismiss. Blocked stays a
 * hook-only fact.
 */
export type TitleActivity = Extract<AttentionLevel, "working" | "idle">;

/** Claude Code's at-rest glyph: ✳ U+2733 EIGHT SPOKED ASTERISK. */
const CLAUDE_IDLE = "✳";

/** Spinner frames. Quarter circles (◐◑◒◓, U+25D0–U+25D3) are what Claude Code
 *  animates today; braille (U+2800–U+28FF) is what Codex uses and what Claude
 *  used before. Whole blocks rather than the frames actually observed, so a
 *  vendor adding a frame can't read as "the agent stopped". */
const SPINNER_RE = /[\u25d0-\u25d3\u2800-\u28ff]/u;

/**
 * The status a terminal title asserts, or `null` when it asserts nothing.
 *
 * Only ever asked about a session santree already knows is an agent — it has a
 * `session_state` row and a live PTY seeded with `exec <cli>` — so a spinner
 * here is a coding CLI's spinner, not an arbitrary TUI's.
 */
export function classifyAgentTitle(title: string | null | undefined): TitleActivity | null {
  if (!title) return null;
  const trimmed = title.trim();
  if (!trimmed) return null;
  // The spinner first: Claude's working titles carry a task label that may
  // itself contain anything, including the idle glyph.
  if (SPINNER_RE.test(trimmed)) return "working";
  if (trimmed === CLAUDE_IDLE || trimmed.startsWith(`${CLAUDE_IDLE} `)) return "idle";
  return null;
}
