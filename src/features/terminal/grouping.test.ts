import { describe, expect, it } from "vitest";

import type { WorktreeTab } from "../../bindings";
import {
  BASE_TICKET,
  groupByProject,
  groupSessions,
  parseSessionRef,
  sessionMeta,
  type TicketGroup,
} from "./grouping";
import type { TerminalTab } from "./orchestrator";

function tab(key: string, source: TerminalTab["source"], refId?: string, title = key): TerminalTab {
  return { key, title, source, refId };
}

describe("parseSessionRef", () => {
  it("maps a triage investigation to its ticket", () => {
    expect(parseSessionRef(tab("t1", "triage", "AK-1"))).toEqual({
      ticket: "AK-1",
      extraTabId: null,
      investigation: true,
    });
  });

  it("maps a worktree main terminal to its ticket", () => {
    expect(parseSessionRef(tab("t1", "issue", "tree:AK-1"))).toEqual({
      ticket: "AK-1",
      extraTabId: null,
      investigation: false,
    });
  });

  it("maps a persisted extra tab to its ticket + tab id", () => {
    expect(parseSessionRef(tab("t1", "issue", "tree:AK-1:tab:6f9a"))).toEqual({
      ticket: "AK-1",
      extraTabId: "6f9a",
      investigation: false,
    });
  });

  it("treats a plain shell (or an unknown refId shape) as ticketless", () => {
    expect(parseSessionRef(tab("t1", "shell")).ticket).toBeNull();
    expect(parseSessionRef(tab("t2", "issue", "not-a-tree-ref")).ticket).toBeNull();
  });
});

describe("groupSessions", () => {
  it("splits shells from ticket groups and merges triage + worktree sessions per ticket", () => {
    const { shells, tickets } = groupSessions([
      tab("s1", "shell"),
      tab("w1", "issue", "tree:AK-1"),
      tab("i1", "triage", "AK-1"),
      tab("w2", "issue", "tree:AK-2"),
    ]);
    expect(shells.map((t) => t.key)).toEqual(["s1"]);
    expect(tickets.map((g) => g.ticket)).toEqual(["AK-1", "AK-2"]);
    expect(tickets[0].tabs.map((t) => t.key)).toEqual(["w1", "i1"]);
  });

  it("orders a ticket's sessions main → extra tabs (open order) → investigation", () => {
    const { tickets } = groupSessions([
      tab("i1", "triage", "AK-1"),
      tab("e1", "issue", "tree:AK-1:tab:aa"),
      tab("w1", "issue", "tree:AK-1"),
      tab("e2", "issue", "tree:AK-1:tab:bb"),
    ]);
    expect(tickets[0].tabs.map((t) => t.key)).toEqual(["w1", "e1", "e2", "i1"]);
  });
});

describe("groupByProject", () => {
  const groups: TicketGroup[] = [
    { ticket: "AK-9", tabs: [] },
    { ticket: "AK-1", tabs: [] },
    { ticket: "AK-5", tabs: [] },
  ];

  it("buckets tickets by project, named projects alphabetically, no-project last", () => {
    const projectOf = (t: string) => (t === "AK-1" ? "Core" : t === "AK-9" ? "Auth" : null);
    const sections = groupByProject(groups, projectOf);
    expect(sections.map((s) => s.project)).toEqual(["Auth", "Core", null]);
    expect(sections[2].tickets.map((g) => g.ticket)).toEqual(["AK-5"]);
  });

  it("sorts tickets by id within a section", () => {
    const sections = groupByProject(groups, () => "Core");
    expect(sections[0].tickets.map((g) => g.ticket)).toEqual(["AK-1", "AK-5", "AK-9"]);
  });
});

describe("sessionMeta", () => {
  const rows = new Map<string, WorktreeTab>([
    ["aa", { id: "aa", worktreeId: "AK-1", kind: "claude", title: "Debugging the parser" }],
    ["bb", { id: "bb", worktreeId: "AK-1", kind: "terminal", title: "Terminal 2" }],
  ]);

  it("labels the main work terminal 'Terminal' with the work kind", () => {
    expect(sessionMeta(tab("w1", "issue", "tree:AK-1"), rows)).toEqual({
      label: "Terminal",
      kind: "work",
    });
    expect(sessionMeta(tab("w2", "issue", `tree:${BASE_TICKET}`), rows).kind).toBe("work");
  });

  it("labels an investigation session", () => {
    expect(sessionMeta(tab("i1", "triage", "AK-1"), rows)).toEqual({
      label: "Investigation",
      kind: "investigation",
    });
  });

  it("takes an extra tab's live title + kind from its persisted row (renames show up)", () => {
    expect(sessionMeta(tab("e1", "issue", "tree:AK-1:tab:aa"), rows)).toEqual({
      label: "Debugging the parser",
      kind: "claude",
    });
    expect(sessionMeta(tab("e2", "issue", "tree:AK-1:tab:bb"), rows)).toEqual({
      label: "Terminal 2",
      kind: "shell",
    });
  });

  it("falls back to the PTY title for rows that no longer exist and for shells", () => {
    expect(sessionMeta(tab("e1", "issue", "tree:AK-1:tab:gone", "old title"), rows)).toEqual({
      label: "old title",
      kind: "shell",
    });
    expect(sessionMeta(tab("s1", "shell", undefined, "htop"), rows)).toEqual({
      label: "htop",
      kind: "shell",
    });
  });
});
