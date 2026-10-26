/** "Continue on <account>" — moving an agent tab's conversation to another of
 *  the provider's logins (Settings → Agents → Accounts), for every strip whose
 *  agents are `worktree_tabs` rows: a worktree's, a review checkout's and a
 *  triage ticket's own.
 *
 *  A running process is never moved. The click stores the new account on the
 *  tab's session (`terminal_session_set_account`), ends the pane, and reopens
 *  the same tab on the same conversation — by the path a lost pane's Resume
 *  takes (`TerminalLayer`): the row is held through the gap so it keeps its
 *  binding, and the surface's own Resume (`useLostTabResume`, through the
 *  pane's embed) checks the session is free and relaunches it, now resolving to
 *  the other account. One human click, one relaunch; nothing here runs on its
 *  own (COMPLIANCE.md, "Agent accounts"). */
import { useRef } from "react";

import type { AgentKind, WorktreeTab } from "../../bindings";
import type { ContextMenuItem } from "../../components/primitives";
import {
  useAgentAccounts,
  useRepos,
  useSetTerminalSessionAccount,
  useTabSessionAccounts,
} from "../../lib/queries";
import { useTerminals } from "../terminal/TerminalsContext";
import { tabRefId } from "./useTabSessions";

/** The providers santree keeps accounts for. */
const withAccounts = (kind: AgentKind | null): kind is "Claude" | "Codex" =>
  kind === "Claude" || kind === "Codex";

export function useTabAccounts(
  repo: string,
  /** The rows' surface — see {@link tabRefId}. */
  owner: string,
  rows: WorktreeTab[],
): {
  /** The tab's "Continue on …" rows, or undefined when it has none to offer. */
  menuFor: (tab: WorktreeTab) => ContextMenuItem[] | undefined;
  /** "Account: Work" for a tab running on one of santree's accounts; nothing
   *  for the Default. */
  detailFor: (tab: WorktreeTab) => string | undefined;
} {
  // A Daedalus project's agents run on the box, under the box's own login; and
  // with no project (a triage ticket not yet attached) nothing runs at all.
  const { data: repos } = useRepos();
  const remote = !repo || repos?.find((r) => r.name === repo)?.location === "Daedalus";
  const claude = useAgentAccounts("Claude", !remote && rows.some((t) => t.agentKind === "Claude"));
  const codex = useAgentAccounts("Codex", !remote && rows.some((t) => t.agentKind === "Codex"));
  const current = useTabSessionAccounts(
    repo,
    rows.flatMap((t) =>
      withAccounts(t.agentKind) ? [{ termKey: tabRefId(owner, t.id), agent: t.agentKind }] : [],
    ),
  );
  const { tabs: sessions, embeds, close, holdRow } = useTerminals();
  const { mutateAsync: setAccount } = useSetTerminalSessionAccount();
  // Read after an await: the sessions and embeds at click time may be gone.
  const latest = useRef({ sessions, embeds });
  latest.current = { sessions, embeds };

  const accountsOf = (kind: "Claude" | "Codex") => (kind === "Claude" ? claude : codex).data ?? [];

  const continueOn = async (tab: WorktreeTab, kind: AgentKind, account: string | null) => {
    const refId = tabRefId(owner, tab.id);
    const live = latest.current.sessions.find((s) => s.refId === refId && s.agent);
    // The session's provider is the one the pane runs, which a resumed session
    // may have kept over the row's.
    const agent = live?.agent?.kind ?? kind;
    // The write also marks the tab's cached resolution stale (it carries the
    // old account's env), so the relaunch below — or a hidden tab's next open —
    // resolves again rather than replaying it.
    try {
      await setAccount({ repo, termKey: refId, agent, account });
    } catch {
      return; // Toasted by the mutation policy; the tab is untouched.
    }
    const now = latest.current.sessions.find((s) => s.refId === refId && s.agent);
    // Nothing running: the tab's next open launches on the new account.
    if (!now) return;
    // Taken before the pane goes: closing it unmounts the host that claimed it.
    const surfaceResume = latest.current.embeds.find((e) => e.key === now.key)?.onResume;
    holdRow(refId);
    close(now.key);
    // A tab not on screen has no embed; its pane resolves afresh — on the new
    // account — when it is next shown, and that new pane ends the hold.
    surfaceResume?.();
  };

  /** The account the tab runs on (`null` = Default). Its pane's own launch
   *  resolution wins while it holds one: it is what is running, and newer than
   *  the row, which a fresh launch on a non-Default account only reaches on the
   *  next list read. Otherwise — after a reload, or a hidden tab whose read was
   *  collected — the row's, which the backend fills from the session. */
  const accountOf = (tab: WorktreeTab): string | null => {
    const cached = current.get(tabRefId(owner, tab.id))?.account;
    return cached !== undefined ? cached : tab.account;
  };

  const menuFor = (tab: WorktreeTab): ContextMenuItem[] | undefined => {
    const kind = tab.agentKind;
    if (remote || !withAccounts(kind)) return undefined;
    const accounts = accountsOf(kind);
    const known = current.get(tabRefId(owner, tab.id));
    // A launch refused because its account is gone is the one case worth a menu
    // with nothing but the Default left to offer.
    if (accounts.length === 0 && !known?.failed) return undefined;
    // After a refused launch the tab is on no account at all: every one is a
    // way out.
    const on = known?.failed ? undefined : accountOf(tab);
    const targets = [
      { id: null, label: "Default", signedIn: true },
      ...accounts.map((a) => ({ id: a.id, label: a.label, signedIn: a.signedIn })),
    ].filter((t) => on === undefined || t.id !== on);
    return [
      { kind: "heading", key: "continue", label: "Continue on account" },
      ...targets.map(
        (t): ContextMenuItem => ({
          kind: "action",
          key: `continue:${t.id ?? ""}`,
          label: `Continue on ${t.label}`,
          disabled: !t.signedIn,
          title: t.signedIn
            ? `End this ${kind === "Claude" ? "Claude Code" : "Codex"} process and resume the same conversation on ${t.label}`
            : `Sign ${t.label} in under Settings → Agents first`,
          run: () => void continueOn(tab, kind, t.id),
        }),
      ),
    ];
  };

  const detailFor = (tab: WorktreeTab): string | undefined => {
    if (remote || !withAccounts(tab.agentKind)) return undefined;
    const on = accountOf(tab);
    if (!on) return undefined;
    const label = accountsOf(tab.agentKind).find((a) => a.id === on)?.label ?? on;
    return `Account: ${label}`;
  };

  return { menuFor, detailFor };
}
