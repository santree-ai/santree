import { describe, expect, it } from "vitest";

import { classifyAgentTitle } from "./agentTitle";

/**
 * Every string below was **captured**, not invented: each CLI was run under a
 * real PTY on 2026-08-28 and every `ESC ] 0 ; … BEL` it wrote was recorded. A
 * classifier tested against made-up title text proves only that it agrees with
 * whoever made the text up.
 */
const CLAUDE = {
  /** `claude` 2.x, at rest before the first turn, and again once one finishes. */
  idle: ["✳ Claude Code", "✳ Notes.txt poem"],
  /** Quarter-circle spinner frames, animated ~2×/second through a turn. */
  working: ["◐ Claude Code", "◑ Claude Code", "◐ Notes.txt poem", "◑ Notes.txt poem"],
};

const CODEX = {
  /** `codex` 0.150.1 at rest: the bare cwd basename, no status glyph at all. */
  idle: ["titlelab2"],
  /** Braille spinner frames, animated ~10×/second through a turn. */
  working: [
    "⠋ titlelab2",
    "⠙ titlelab2",
    "⠹ titlelab2",
    "⠸ titlelab2",
    "⠼ titlelab2",
    "⠴ titlelab2",
    "⠦ titlelab2",
    "⠧ titlelab2",
    "⠇ titlelab2",
    "⠏ titlelab2",
  ],
};

describe("classifyAgentTitle", () => {
  it("reads every captured Claude Code and Codex spinner frame as working", () => {
    for (const title of [...CLAUDE.working, ...CODEX.working]) {
      expect(classifyAgentTitle(title), title).toBe("working");
    }
    // Claude's working title is `<spinner> <task summary>`, and the summary is
    // arbitrary text — including text the idle check would otherwise match.
    expect(classifyAgentTitle("◐ rename ✳ in the header")).toBe("working");
  });

  it("reads Claude Code's ✳ as at rest, before and after a turn", () => {
    for (const title of CLAUDE.idle) expect(classifyAgentTitle(title), title).toBe("idle");
  });

  /** "No evidence" lets the caller's own default stand instead of dressing a
   *  guess up as a reading. */
  it("takes a title that says nothing as no evidence", () => {
    for (const title of [
      // Codex at rest: just the cwd basename — no glyph, no agent name.
      ...CODEX.idle,
      // Claude clears the title (`ESC ] 0 ; BEL`) as it exits.
      null,
      undefined,
      "",
      "   ",
      // An ordinary shell.
      "~/dev/santree-app",
      "zsh",
      "npm run dev",
    ]) {
      expect(classifyAgentTitle(title), String(title)).toBeNull();
    }
  });
});
