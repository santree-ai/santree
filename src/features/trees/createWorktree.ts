/**
 * The pure half of the "Create worktree" dialog: which branches it may offer,
 * what a typed branch name is allowed to be, and what the three sources
 * (a ticket, an existing branch, a new branch) turn into at the command boundary.
 *
 * Kept out of the component because every one of these is a rule with a wrong
 * answer that only shows up as a failed git command: a branch git already holds,
 * a name `git check-ref-format` refuses, a parent worktree that must become the
 * new tree's *base* rather than a second notion of nesting.
 */
import type { RepoBranch, WorktreeBranchSource } from "../../bindings";

/** Why git would refuse this branch name, or `null` when it wouldn't.
 *
 *  Mirrors `git::safe_branch` on the Rust side, which is the authority — this
 *  copy exists so the dialog can *disable* the Create button with a reason
 *  instead of letting the user click into a backend error. The two are tested
 *  against the same cases; the backend re-checks whatever this lets through.
 */
export function invalidBranchReason(name: string): string | null {
  if (name.length === 0) return "Enter a branch name";
  // Ours, not git's: branch names are passed positionally to git, so a leading
  // dash would be read as an option.
  if (name.startsWith("-")) return "A branch name can't start with “-”";
  if (name.includes("..") || name.includes("@{") || name === "@")
    return "A branch name can't contain “..” or “@{”";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git's own rule is literally about control characters.
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name))
    return "A branch name can't contain spaces, control characters, or ~ ^ : ? * [ \\";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//"))
    return "A branch name can't start, end, or double up on “/”";
  if (name.endsWith(".")) return "A branch name can't end with “.”";
  for (const part of name.split("/")) {
    if (part.startsWith(".") || part.endsWith(".lock"))
      return "No part of a branch name may start with “.” or end with “.lock”";
  }
  return null;
}

/** What the branch picker shows for one query. */
export interface BranchPickerRows {
  /** Branches a worktree can still be created from. */
  available: RepoBranch[];
  /** Matching branches git already holds in a worktree. Listed, but disabled:
   *  git allows one checkout per branch, so this is a failure that is knowable
   *  up front — and hiding them outright leaves "why isn't `main` here?"
   *  unanswered. */
  taken: RepoBranch[];
  /** The "Create new branch <query>" row, offered whenever the typed name isn't
   *  already a branch. `reason` is the tooltip when git would refuse the name,
   *  and `null` when the row is usable. */
  create: { name: string; reason: string | null } | null;
}

/**
 * Split the repo's branches into what this query can and can't pick, plus the
 * create-a-branch fallback.
 *
 * The query is matched case-insensitively on a substring, which is what a
 * branch picker is for; the create row uses the query *verbatim*, because a
 * branch name is not something to normalise on the user's behalf.
 */
export function branchPickerRows(branches: RepoBranch[], query: string): BranchPickerRows {
  const typed = query.trim();
  const needle = typed.toLowerCase();
  const matches = needle
    ? branches.filter((b) => b.name.toLowerCase().includes(needle))
    : [...branches];

  return {
    available: matches.filter((b) => !b.hasWorktree),
    taken: matches.filter((b) => b.hasWorktree),
    // An exact hit is that branch, not a new one — offering "create feature/x"
    // beside the existing `feature/x` is an error the user can only find out
    // about by clicking it.
    create:
      typed && !branches.some((b) => b.name === typed)
        ? { name: typed, reason: invalidBranchReason(typed) }
        : null,
  };
}

/** What the dialog has been asked to create. */
export type WorktreeChoice =
  | { kind: "ticket"; id: string; title: string; project: string | null }
  | { kind: "existing"; branch: string }
  | { kind: "new"; branch: string };

/** The `createManualWorktree` payload. */
export interface CreateWorktreeArgs {
  issueId: string;
  title: string;
  project: string | null;
  source: WorktreeBranchSource;
  base: string | null;
}

/**
 * The id a branch-sourced worktree is filed under — which is also its directory
 * name under `.santree/worktrees/`, so it has to be a single, plain path
 * component (the backend's `validate_issue_id` rejects anything else, and
 * `feature/x` is two).
 */
export function worktreeIdForBranch(branch: string): string {
  const slug = branch
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // A leading dot would make a hidden directory; a trailing one is noise.
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64)
    .replace(/[.-]+$/g, "");
  // A name made entirely of separators slugs down to nothing — never hand the
  // backend an empty id (or one it would read as `.`/`..`).
  return slug || "worktree";
}

/**
 * Turn a choice plus the picked parent into the command's arguments.
 *
 * **The parent worktree is the base.** santree already has exactly one notion of
 * "this branch is stacked on that one": the new worktree's `base_branch`, which
 * `git::BaseKind::LocalBranch` recognises as a sibling worktree's branch rather
 * than an upstream ref. So a picked parent is passed as `base` and nothing else
 * — no second nesting concept, and the stacked-branch rendering, diffing and
 * restack-on-remove behaviour all come for free.
 */
export function createArgsFor(
  choice: WorktreeChoice,
  parentBranch: string | null,
): CreateWorktreeArgs {
  const base = parentBranch ?? null;
  switch (choice.kind) {
    case "ticket":
      return {
        issueId: choice.id,
        title: choice.title,
        project: choice.project,
        source: { type: "derived" },
        base,
      };
    case "existing":
      return {
        issueId: worktreeIdForBranch(choice.branch),
        // No ticket behind this one, so the branch is the only name it has.
        title: choice.branch,
        project: null,
        source: { type: "existing", branch: choice.branch },
        base,
      };
    case "new":
      return {
        issueId: worktreeIdForBranch(choice.branch),
        title: choice.branch,
        project: null,
        source: { type: "new", branch: choice.branch },
        base,
      };
  }
}
