/**
 * The command palette (⌘K): one box that reaches everything the sidebar does,
 * across every project — tickets, the triage queue, pull requests, worktrees,
 * agents, the projects themselves, a settings section, an app action — without
 * knowing which rail it lives in.
 *
 * Kept deliberately plain: a search line, groups with a quiet label, one-line
 * rows (a mono key, the title, the context at the trailing edge) and a single
 * highlighted row at a time. The ranking is `paletteSearch`; the rows are built
 * here from the same reads the sidebar makes, so the palette can never know
 * about something the rail doesn't, or the other way round.
 *
 * The dialog mounts only while open — its reads and its item list cost nothing
 * the rest of the time.
 */
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { BASE_TICKET } from "../features/agents/registry";
import { useAgentEntries } from "../features/agents/useAgents";
import { useOpenAgent } from "../features/agents/useOpenAgent";
import {
  useRefreshExternal,
  useRepos,
  useReviews,
  useTasksByRepo,
  useTriageOrgRepo,
  useTriageTickets,
  useWorktreesByRepo,
} from "../lib/queries";
import { shortRepoName } from "../lib/repoName";
import { useAppUi } from "../state/AppContext";
import { RepoAvatar } from "./chrome/RepoAvatar";
import {
  AgentIcon,
  GearIcon,
  KbdIcon,
  LinearLogo,
  ListIcon,
  PanelIcon,
  PrIcon,
  RefreshIcon,
  SearchIcon,
  TerminalIcon,
  TreeIcon,
} from "./icons";
import { rankItems, type Searchable } from "./paletteSearch";
import { useModalA11y } from "./primitives";
import { Kbd } from "./ShortcutsOverlay";

const GROUPS = [
  "Navigate",
  "Tickets",
  "Triage",
  "Pull requests",
  "Worktrees",
  "Agents",
  "Projects",
  "Settings",
  "Actions",
] as const;
type Group = (typeof GROUPS)[number];

interface PaletteItem extends Searchable {
  key: string;
  group: Group;
  icon: ReactNode;
  run: () => void;
}

/** The settings sections, in the order the Settings nav lists them. */
const SETTINGS_SECTIONS: { key: string; label: string; keywords?: string }[] = [
  { key: "general", label: "General", keywords: "appearance theme accent" },
  { key: "linear", label: "Linear", keywords: "org token connect" },
  { key: "github", label: "GitHub", keywords: "gh auth" },
  { key: "agent-claude", label: "Claude Code", keywords: "agent model" },
  { key: "agent-codex", label: "Codex", keywords: "agent model openai" },
  { key: "triage", label: "Triage", keywords: "rotation schedule" },
  { key: "work", label: "Work", keywords: "prompt agent model" },
  { key: "review", label: "Reviews", keywords: "ai review prompt" },
  { key: "prompts", label: "Prompts", keywords: "template" },
  { key: "usage", label: "Usage", keywords: "tokens cost limits" },
  { key: "english-tutor", label: "English tutor", keywords: "writing coach" },
  { key: "environment", label: "Environment", keywords: "env vars" },
  { key: "terminal", label: "Terminal", keywords: "shell font" },
];

export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen } = useAppUi();
  if (!commandPaletteOpen) return null;
  return <PaletteDialog onClose={() => setCommandPaletteOpen(false)} />;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const {
    requestIssueFocus,
    requestTreeFocus,
    requestReviewFocus,
    requestTriageFocus,
    toggleSidebar,
    toggleShortcuts,
  } = useAppUi();
  const { refresh } = useRefreshExternal();
  const openAgent = useOpenAgent();

  const { data: repos = [] } = useRepos();
  const repoNames = useMemo(() => repos.map((repo) => repo.name), [repos]);
  const tasksByRepo = useTasksByRepo(repoNames);
  const worktreesByRepo = useWorktreesByRepo(repoNames);
  const agents = useAgentEntries(repoNames, repoNames);
  const { data: inbox } = useReviews();
  const { data: triage = [] } = useTriageTickets(useTriageOrgRepo());

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useModalA11y({ open: true, onClose, dialogRef, initialFocusRef: inputRef });

  const items = useMemo<PaletteItem[]>(() => {
    const closeAnd = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const manyRepos = repoNames.length > 1;

    const navigation: PaletteItem[] = [
      {
        key: "nav-issues",
        group: "Navigate",
        label: "Tickets",
        keywords: "issues list graph",
        icon: <ListIcon size={14} />,
        run: closeAnd(() => navigate({ to: "/issues" })),
      },
      {
        key: "nav-trees",
        group: "Navigate",
        label: "Workspace",
        meta: "the worktree you last opened",
        keywords: "trees",
        icon: <TreeIcon size={14} />,
        run: closeAnd(() => navigate({ to: "/trees" })),
      },
      {
        key: "nav-reviews",
        group: "Navigate",
        label: "Reviews",
        meta: "pull requests waiting on you",
        keywords: "inbox",
        icon: <PrIcon size={14} />,
        run: closeAnd(() => navigate({ to: "/reviews" })),
      },
      {
        key: "nav-settings",
        group: "Navigate",
        label: "Settings",
        keywords: "preferences",
        icon: <GearIcon size={14} />,
        run: closeAnd(() => navigate({ to: "/settings" })),
      },
    ];

    const seenTickets = new Set<string>();
    const tickets: PaletteItem[] = [];
    for (const [repo, tasks] of tasksByRepo) {
      for (const task of tasks) {
        if (seenTickets.has(task.id)) continue;
        seenTickets.add(task.id);
        tickets.push({
          key: `ticket-${task.id}`,
          group: "Tickets",
          code: task.id,
          label: task.title,
          meta: task.project,
          keywords: `${task.status} ${repo} ${task.assignee ?? ""}`,
          icon: <LinearLogo size={13} />,
          run: closeAnd(() => {
            requestIssueFocus(task.id);
            navigate({ to: "/issues" });
          }),
        });
      }
    }

    const triageItems = triage.map<PaletteItem>((ticket) => ({
      key: `triage-${ticket.id}`,
      group: "Triage",
      code: ticket.id,
      label: ticket.title,
      meta: ticket.team ?? undefined,
      keywords: ticket.mine ? "mine" : "",
      icon: <LinearLogo size={13} />,
      run: closeAnd(() => {
        requestTriageFocus(ticket.id);
        navigate({ to: "/triage", search: { ticket: ticket.id } });
      }),
    }));

    const prs = inbox
      ? [...inbox.mine, ...inbox.requested, ...inbox.teams.flatMap((team) => team.prs)]
      : [];
    const seenPrs = new Set<string>();
    const reviewItems: PaletteItem[] = [];
    for (const pr of prs) {
      if (seenPrs.has(pr.url)) continue;
      seenPrs.add(pr.url);
      reviewItems.push({
        key: `pr-${pr.url}`,
        group: "Pull requests",
        code: `#${pr.number}`,
        label: pr.title,
        meta: shortRepoName(pr.repo),
        keywords: `${pr.author} ${pr.headRef} ${pr.repo}`,
        icon: <PrIcon size={14} />,
        run: closeAnd(() => {
          requestReviewFocus(pr.url);
          // Land on the PR's own project, so the rail it appears in is the one
          // that owns it; the PR rides in the url so the sidebar lights its row
          // on arrival. A PR no registered project owns has none to name.
          navigate({ to: "/reviews", search: { project: pr.project ?? undefined, pr: pr.url } });
        }),
      });
    }

    const treeItems: PaletteItem[] = [];
    for (const [repo, trees] of worktreesByRepo) {
      for (const tree of trees) {
        if (tree.id === BASE_TICKET) continue;
        treeItems.push({
          key: `tree-${repo}-${tree.id}`,
          group: "Worktrees",
          code: tree.id,
          label: tree.title,
          // The branch is searchable but not shown: the key already names the
          // worktree, and a branch name is the widest string in the app.
          meta: manyRepos ? shortRepoName(repo) : (tree.project ?? undefined),
          keywords: `${tree.project ?? ""} ${tree.branch} ${repo}`,
          icon: <TreeIcon size={14} />,
          run: closeAnd(() => {
            navigate({ to: "/trees", search: { project: repo, tree: tree.id } });
            requestTreeFocus(repo, tree.id);
          }),
        });
      }
    }

    // Every agent the sidebar can open, with the same words it uses for them.
    const agentItems = (agents ?? [])
      .filter((entry) => entry.openable)
      .map<PaletteItem>((entry) => ({
        key: `agent-${entry.termKey ?? entry.sessionId ?? entry.cwd}`,
        group: "Agents",
        code: entry.ticket ?? undefined,
        label: entry.title,
        meta: entry.subtitle ?? entry.project,
        keywords: `${entry.agentKind ?? ""} ${entry.state ?? ""} ${entry.purpose} ${entry.repo ?? ""}`,
        icon: entry.agentKind ? (
          <AgentIcon kind={entry.agentKind} size={13} />
        ) : (
          <TerminalIcon size={14} />
        ),
        run: closeAnd(() =>
          openAgent({ repo: entry.repo, origin: entry.origin, agentKind: entry.agentKind }),
        ),
      }));

    const projectItems = repos.map<PaletteItem>((repo) => ({
      key: `project-${repo.name}`,
      group: "Projects",
      label: shortRepoName(repo.name),
      meta: repo.name,
      keywords: repo.path ?? "",
      icon: <RepoAvatar repo={repo.name} size={14} bordered={false} />,
      run: closeAnd(() => navigate({ to: "/trees", search: { project: repo.name } })),
    }));

    const settingsItems = SETTINGS_SECTIONS.map<PaletteItem>((section) => ({
      key: `settings-${section.key}`,
      group: "Settings",
      label: section.label,
      keywords: `settings ${section.keywords ?? ""}`,
      icon: <GearIcon size={14} />,
      run: closeAnd(() => navigate({ to: "/settings", search: { section: section.key } })),
    }));

    const actions: PaletteItem[] = [
      {
        key: "act-refresh",
        group: "Actions",
        label: "Refresh Linear and GitHub",
        meta: "⌘⇧R",
        keywords: "reload sync fetch",
        icon: <RefreshIcon size={13} />,
        run: closeAnd(refresh),
      },
      {
        key: "act-sidebar",
        group: "Actions",
        label: "Toggle the sidebar",
        meta: "⌘B",
        icon: <PanelIcon size={14} />,
        run: closeAnd(toggleSidebar),
      },
      {
        key: "act-shortcuts",
        group: "Actions",
        label: "Keyboard shortcuts",
        meta: "⌘/",
        keywords: "help keys",
        icon: <KbdIcon size={14} />,
        run: closeAnd(toggleShortcuts),
      },
    ];

    return [
      ...navigation,
      ...tickets,
      ...triageItems,
      ...reviewItems,
      ...treeItems,
      ...agentItems,
      ...projectItems,
      ...settingsItems,
      ...actions,
    ];
  }, [
    agents,
    inbox,
    navigate,
    onClose,
    openAgent,
    refresh,
    repoNames.length,
    repos,
    requestIssueFocus,
    requestReviewFocus,
    requestTreeFocus,
    requestTriageFocus,
    tasksByRepo,
    toggleShortcuts,
    toggleSidebar,
    triage,
    worktreesByRepo,
  ]);

  const rows = useMemo(
    () => rankItems(items, query, { groupOrder: GROUPS, perGroup: 8, perGroupIdle: 4, total: 60 }),
    [items, query],
  );

  // Keep the highlighted row on screen as the arrows move it.
  useEffect(() => {
    listRef.current
      ?.querySelectorAll<HTMLElement>("button[data-active]")
      [active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const trimmed = query.trim();

  return (
    <div className="fixed inset-0 z-[95] flex justify-center px-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close command palette"
        onClick={onClose}
        className="fixed inset-0 cursor-default bg-black/40 backdrop-blur-sm"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-label="Command palette"
        className="relative flex max-h-[64vh] w-[620px] max-w-full flex-col overflow-hidden rounded-xl border border-line-3 bg-popover shadow-[0_30px_80px_-20px_rgba(0,0,0,.85)]"
      >
        <div className="flex h-12 flex-none items-center gap-3 border-b border-line px-4">
          <SearchIcon size={15} className="flex-none text-muted-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, rows.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                rows[active]?.run();
              }
            }}
            placeholder="Search tickets, pull requests, worktrees, agents, projects, settings…"
            aria-label="Search"
            className="overlay-search-input min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-muted-4"
          />
          <Kbd token="esc" />
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {rows.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <div className="text-[13px] text-fg-3">No results for “{trimmed}”</div>
              <div className="mt-1 text-[11.5px] text-muted-4">
                Try a ticket id, a PR number, a branch, an agent, a project or a setting.
              </div>
            </div>
          ) : (
            rows.map((item, index) => {
              const first = index === 0 || rows[index - 1]?.group !== item.group;
              const isActive = active === index;
              return (
                <div key={item.key}>
                  {first && (
                    <div className="px-2.5 pt-3 pb-1 font-mono text-[10px] tracking-[.06em] text-muted-4 uppercase">
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={item.run}
                    data-active={isActive}
                    className="flex h-8 w-full cursor-pointer items-center gap-3 rounded-md px-2.5 text-left data-[active=true]:bg-(--interaction-hover)"
                  >
                    <span className="flex w-4 flex-none items-center justify-center text-muted-3">
                      {item.icon}
                    </span>
                    {item.code && (
                      <span className="flex-none font-mono text-[11px] text-muted-3 tabular-nums">
                        {item.code}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">
                      {item.label}
                    </span>
                    {item.meta && (
                      <span className="max-w-[38%] flex-none truncate font-mono text-[10.5px] text-muted-4">
                        {item.meta}
                      </span>
                    )}
                    <span
                      aria-hidden
                      className={`w-3 flex-none font-mono text-[10px] text-muted-4 ${
                        isActive ? "" : "invisible"
                      }`}
                    >
                      ↵
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex flex-none items-center gap-4 border-t border-line px-4 py-2 text-[10.5px] text-muted-4">
          <Hint keys={["↑", "↓"]} label="navigate" />
          <Hint keys={["↵"]} label="open" />
          <Hint keys={["esc"]} label="close" />
          <span className="ml-auto">
            <Hint keys={["⌘", "/"]} label="all shortcuts" />
          </span>
        </div>
      </div>
    </div>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex items-center gap-0.5">
        {keys.map((token) => (
          <Kbd key={token} token={token} />
        ))}
      </span>
      {label}
    </span>
  );
}
