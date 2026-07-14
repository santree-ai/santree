import { describe, expect, it } from "vitest";

import { ticketIdFor } from "./ticket";

describe("ticketIdFor", () => {
  const found: [string, string, string][] = [
    // title, headRef, expected
    ["[AK-201] Booking webhook", "you/whatever-9", "AK-201"],
    ["Fix AK-9 flake", "you/whatever", "AK-9"],
    // The title wins over a branch that carries a different id.
    ["[AK-201] Booking webhook", "jd/msg-5033-other", "AK-201"],
    // Linear's "copy git branch name".
    [
      "Hide unactioned service-ticket sources in AI explanation",
      "jonathansandoval/msg-5033-ai-explanation-servi",
      "MSG-5033",
    ],
    // santree's own worktree branch.
    ["Login throttling", "santree/ak-123-login-throttling", "AK-123"],
    ["Login throttling", "feat/jd/ak-7-fix-it", "AK-7"],
    ["Login throttling", "JD/AK-7-Fix-It", "AK-7"],
  ];
  it.each(found)("reads %j / %j as %s", (title, headRef, expected) => {
    expect(ticketIdFor({ title, headRef })).toBe(expected);
  });

  const none: [string, string][] = [
    // GitHub's own branch shorthand — the id-shaped `pr-483` is the PR number.
    ["Booking webhook retries", "you/pr-483"],
    // A version bump: `<word>-<number>` mid-branch is not a ticket.
    ["Bump node to 20", "bump-node-20"],
    ["Bump node to 20", "chore/bump-node-20"],
    ["Upgrade node", "node-20-upgrade"],
    ["Cut a release", "release-2-0-1"],
    // Bot branches.
    ["Bump vite", "dependabot/npm_and_yarn/vite-8.1.2"],
    ["Update react", "renovate/react-19.x"],
    // Prose must not false-match, in the title or the branch.
    ["Fix the service-ticket bug", "feature/no-id"],
    ["Plain title", "you/pr88"],
    ["Plain title", "main"],
    ["Plain title", ""],
  ];
  it.each(none)("reads no ticket from %j / %j", (title, headRef) => {
    expect(ticketIdFor({ title, headRef })).toBeNull();
  });
});
