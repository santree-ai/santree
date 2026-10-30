/** Which face an agent tab shows — its terminal or its conversation — chosen per
 *  tab, remembered across restarts. A tab with no choice of its own shows the
 *  default from Settings → Experimental (Terminal unless changed there). Every
 *  switch is stored as the tab's own choice, either way, so changing the default
 *  later never flips a tab the user set by hand. With the Conversation view off
 *  there, every tab shows its terminal ({@link useConversationOffer}).
 *
 *  The choice is the user's alone, and it only ever changes what is drawn: the
 *  tab's PTY runs, at its size, whichever face is up. One store for every host
 *  (Trees, Reviews, Triage), keyed by the tab's term key, so the strip's toggle,
 *  the tab's menu row, the pane and ⌘J agree without being wired to each other.
 *
 *  Chrome state, so it lives in this browser's storage — and storage can refuse
 *  (a private window, a full quota): every read and write is wrapped, and a
 *  refusal costs the memory across restarts, never the switch. */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { AgentKind, WorktreeTab } from "../../bindings";
import { MessageSquareIcon, TerminalIcon } from "../../components/icons";
import { type ContextMenuItem, Segmented } from "../../components/primitives";
import { useSplitPane } from "../../components/split/SplitPaneContext";
import { CLAUDE_TAB_FACE_KEY, useExperimental, useRepos, useSetting } from "../../lib/queries";
import { targetOwnsKey } from "../../lib/useKeyboardShortcuts";
import { agentProvider } from "../terminal/agentProvider";

export type AgentTabView = "terminal" | "conversation";

const STORAGE_KEY = "santree.agentTabView";

/** Each switched tab's own choice, by term key; a tab never switched has no
 *  entry. Builds from before the default existed stored only a conversation,
 *  as `true` (a terminal was the absence of an entry): read as "conversation"
 *  until that tab is switched again. Parsed, not validated: {@link faceOf}
 *  reads anything else as no choice. */
type Choices = Readonly<Record<string, unknown>>;

let choices: Choices | null = null;
const listeners = new Set<() => void>();

function current(): Choices {
  if (choices) return choices;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    choices =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Choices) : {};
  } catch {
    choices = {};
  }
  return choices;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A tab's face from its stored entry: its own choice when it made one, else
 *  `fallback`, the default. */
function faceOf(entry: unknown, fallback: AgentTabView): AgentTabView {
  if (entry === "terminal" || entry === "conversation") return entry;
  return entry === true ? "conversation" : fallback;
}

/** The face `termKey` shows, with `fallback` as the default for a tab that was
 *  never switched. */
export function agentTabView(termKey: string, fallback: AgentTabView): AgentTabView {
  return faceOf(current()[termKey], fallback);
}

/** Record `view` as `termKey`'s own choice, which the default no longer moves. */
export function setAgentTabView(termKey: string, view: AgentTabView): void {
  if (current()[termKey] === view) return;
  const next = { ...current(), [termKey]: view };
  choices = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Remembered for this session only.
  }
  for (const listener of listeners) listener();
}

/** Switch `termKey` to the face that is not up, as its own choice. */
export function toggleAgentTabView(termKey: string, fallback: AgentTabView): void {
  setAgentTabView(
    termKey,
    agentTabView(termKey, fallback) === "conversation" ? "terminal" : "conversation",
  );
}

/** The face a tab with no choice of its own shows: the {@link CLAUDE_TAB_FACE_KEY}
 *  setting, Terminal while it loads and when it was never set. Only a tab that is
 *  offered its conversation ({@link useConversationOffer}) can follow a
 *  Conversation default; every other tab shows its terminal whatever it says. */
export function useDefaultAgentTabView(): AgentTabView {
  return useSetting("app", CLAUDE_TAB_FACE_KEY).data === "conversation"
    ? "conversation"
    : "terminal";
}

/** One tab's face, live. */
export function useAgentTabView(termKey: string): [AgentTabView, (view: AgentTabView) => void] {
  const fallback = useDefaultAgentTabView();
  const view = useSyncExternalStore(
    subscribe,
    () => agentTabView(termKey, fallback),
    () => fallback,
  );
  // Picking the face that is already up is not a switch: storing it would pin a
  // tab that is only following the default.
  const set = useCallback(
    (next: AgentTabView) => {
      if (next !== view) setAgentTabView(termKey, next);
    },
    [termKey, view],
  );
  return [view, set];
}

/** Every tab's face, live — for a strip that draws several tabs' menus. */
export function useAgentTabViews(): (termKey: string) => AgentTabView {
  const all = useSyncExternalStore(subscribe, current, current);
  const fallback = useDefaultAgentTabView();
  return useCallback((termKey: string) => faceOf(all[termKey], fallback), [all, fallback]);
}

/** Whether an agent's tabs can show a conversation at all. */
export function offersConversation(kind: AgentKind | null | undefined): boolean {
  return !!kind && agentProvider(kind).capabilities.conversationView;
}

/** Which of `repo`'s tabs can switch to their conversation: none while
 *  Settings → Experimental → Conversation view is off (nor while it loads);
 *  otherwise those of an agent whose provider draws one, in a project on this
 *  Mac. The view reads a session's record where Claude writes it, and a
 *  Daedalus project's is on the box, which it doesn't read yet — so its tabs
 *  keep the terminal alone rather than offering a face with nothing to show and
 *  a composer beneath it. None until the project registry has answered.
 *
 *  The one gate on the switch: the strip's control, the tab menu's row, ⌘J,
 *  the face a pane shows and Session history's "Open conversation" all ask
 *  here. A tab's stored choice is kept while the switch is off, and honoured
 *  again once it is on. */
export function useConversationOffer(repo: string | null | undefined): {
  agent: (kind: AgentKind | null | undefined) => boolean;
  /** A tab row: every kind but a shell and a page, launched as the row says
   *  (Claude when unset, as the pane launches it). */
  row: (row: WorktreeTab) => boolean;
} {
  const enabled = useExperimental("Conversation");
  const { data: repos } = useRepos();
  const found = repo ? repos?.find((r) => r.name === repo) : undefined;
  const here = enabled && found !== undefined && found.location !== "Daedalus";
  return useMemo(() => {
    const agent = (kind: AgentKind | null | undefined) => here && offersConversation(kind);
    return {
      agent,
      row: (row: WorktreeTab) =>
        row.kind !== "terminal" && row.kind !== "web" && agent(row.agentKind ?? "Claude"),
    };
  }, [here]);
}

/** A tab's menu with the switch's row first, when it has one, ahead of the
 *  host's own rows. `undefined` when there is nothing to offer. */
export function withViewRow(
  termKey: string | null,
  view: AgentTabView,
  rows: ContextMenuItem[] | undefined,
): ContextMenuItem[] | undefined {
  if (!termKey) return rows;
  const own = rows ?? [];
  return [
    viewMenuItem(termKey, view),
    ...(own.length > 0 ? [{ kind: "rule" as const, key: "view-rule" }] : []),
    ...own,
  ];
}

/** The switch's shortcut, as menus and tooltips spell it. */
export const VIEW_SHORTCUT = "⌘J";

/** ⌘J flips `termKey`'s face while it is set — the focused pane's, so a split
 *  area with two agents flips the one being worked in. Like every app chord it
 *  works with the terminal focused (a ⌘-chord means nothing to a shell), and it
 *  also works from inside the conversation, its composer included, so the way
 *  back to the terminal is the same key. */
export function useAgentTabViewShortcut(termKey: string | null): void {
  const fallback = useDefaultAgentTabView();
  useEffect(() => {
    if (!termKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.code !== "KeyJ") return;
      const inConversation = (e.target as HTMLElement | null)?.closest?.("[data-conversation]");
      if (targetOwnsKey(e) && !inConversation) return;
      e.preventDefault();
      toggleAgentTabView(termKey, fallback);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [termKey, fallback]);
}

/** A pane's side of the switch: whether its conversation is the face that is
 *  up. It also owns ⌘J while the pane's split group is the focused one. A tab
 *  with no conversation to offer (see {@link useConversationOffer}) always
 *  shows its terminal, whatever was stored for it or the default says.
 *
 *  The way between the faces is the user's: the strip's switch, the tab's menu
 *  row and ⌘J. Nothing in the view sends the user to the terminal, and nothing
 *  switches on its own — not a dialog, not a failure. */
export function useConversationFace(
  termKey: string,
  kind: AgentKind | null | undefined,
  repo: string,
): AgentFace {
  const offered = useConversationOffer(repo).agent(kind);
  const [view] = useAgentTabView(termKey);
  const pane = useSplitPane();
  useAgentTabViewShortcut(offered && (pane?.focused ?? true) ? termKey : null);
  return { offered, shown: offered && view === "conversation" };
}

/** A tab's faces, as {@link useConversationFace} answers them. */
export interface AgentFace {
  /** The tab can show its conversation at all ({@link useConversationOffer}). */
  offered: boolean;
  /** Its conversation is the face on screen. */
  shown: boolean;
}

/** The tab menu's row for the switch. `view` is the face the tab shows now, the
 *  default included ({@link useAgentTabViews}), so the row stores the other one
 *  as the tab's own choice. */
export function viewMenuItem(termKey: string, view: AgentTabView): ContextMenuItem {
  const showing = view === "conversation";
  return {
    kind: "action",
    key: "view",
    label: showing ? "Show terminal" : "Show conversation",
    icon: showing ? <TerminalIcon size={12} /> : <MessageSquareIcon size={12} />,
    title: VIEW_SHORTCUT,
    run: () => setAgentTabView(termKey, showing ? "terminal" : "conversation"),
  };
}

/** The strip's control for the switch: the two faces, named, one picked. It is
 *  on the tab's strip whichever face is up, so the terminal is always one click
 *  away and the conversation one click back; both stay as they were. Words
 *  without icons: the strip's width goes to its tabs, and the width here fits
 *  "Conversation" in the strip's mono face, twice (the options share it). */
export function ViewSwitch({ termKey }: { termKey: string }) {
  const [view, setView] = useAgentTabView(termKey);
  return (
    <Segmented
      ariaLabel="Show this agent as"
      className="w-[184px] flex-none"
      value={view}
      onChange={setView}
      options={[
        {
          value: "conversation",
          label: "Conversation",
          title: `Show the conversation (${VIEW_SHORTCUT})`,
        },
        { value: "terminal", label: "Terminal", title: `Show the terminal (${VIEW_SHORTCUT})` },
      ]}
    />
  );
}
