/** Global command palette for navigation and the entities people jump between. */
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useReviews, useSessionStates, useTasks, useWorktrees } from "../lib/queries";
import { useApp, useAppUi } from "../state/AppContext";
import {
  AgentsIcon,
  ListIcon,
  PrIcon,
  SearchIcon,
  TelescopeIcon,
  TerminalIcon,
  TreeIcon,
} from "./icons";
import { useModalA11y } from "./primitives";

interface PaletteItem {
  key: string;
  group: string;
  label: string;
  detail?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const { activeRepo, triageEnabled } = useApp();
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    requestIssueFocus,
    requestTreeFocus,
    requestReviewFocus,
  } = useAppUi();
  const { data: tasks = [] } = useTasks(activeRepo);
  const { data: worktrees = [] } = useWorktrees(activeRepo);
  const { data: inbox } = useReviews(activeRepo);
  const { data: sessions = [] } = useSessionStates();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useModalA11y({
    open: commandPaletteOpen,
    onClose: () => setCommandPaletteOpen(false),
    dialogRef,
    initialFocusRef: inputRef,
  });

  useEffect(() => {
    if (!commandPaletteOpen) return;
    setQuery("");
    setActive(0);
  }, [commandPaletteOpen]);

  const items = useMemo<PaletteItem[]>(() => {
    const closeAnd = (fn: () => void) => () => {
      setCommandPaletteOpen(false);
      fn();
    };
    const navigation: PaletteItem[] = [
      {
        key: "nav-agents",
        group: "Navigate",
        label: "Agents",
        icon: <AgentsIcon />,
        run: closeAnd(() => navigate({ to: "/" })),
      },
      ...(triageEnabled
        ? [
            {
              key: "nav-triage",
              group: "Navigate",
              label: "Triage",
              icon: <TelescopeIcon />,
              run: closeAnd(() => navigate({ to: "/triage" })),
            },
          ]
        : []),
      {
        key: "nav-issues",
        group: "Navigate",
        label: "Issues",
        icon: <ListIcon />,
        run: closeAnd(() => navigate({ to: "/issues" })),
      },
      {
        key: "nav-trees",
        group: "Navigate",
        label: "Trees",
        icon: <TreeIcon />,
        run: closeAnd(() => navigate({ to: "/trees" })),
      },
      {
        key: "nav-reviews",
        group: "Navigate",
        label: "Reviews",
        icon: <PrIcon />,
        run: closeAnd(() => navigate({ to: "/reviews" })),
      },
      {
        key: "nav-settings",
        group: "Navigate",
        label: "Settings",
        detail: "Preferences and workflow defaults",
        icon: <span className="font-mono">⌘</span>,
        run: closeAnd(() => navigate({ to: "/settings" })),
      },
    ];
    const ticketItems = tasks.map<PaletteItem>((task) => ({
      key: `ticket-${task.id}`,
      group: "Tickets",
      label: `${task.id}  ${task.title}`,
      detail: task.project,
      icon: <ListIcon />,
      keywords: `${task.status} ${task.project}`,
      run: closeAnd(() => {
        requestIssueFocus(task.id);
        navigate({ to: "/issues" });
      }),
    }));
    const treeItems = worktrees.map<PaletteItem>((tree) => ({
      key: `tree-${tree.id}`,
      group: "Worktrees",
      label: `${tree.id}  ${tree.title}`,
      detail: tree.branch,
      icon: <TreeIcon />,
      keywords: tree.project ?? "",
      run: closeAnd(() => {
        requestTreeFocus(tree.id);
        navigate({ to: "/trees" });
      }),
    }));
    const prs = inbox
      ? [...inbox.mine, ...inbox.requested, ...inbox.teams.flatMap((team) => team.prs)]
      : [];
    const seenPrs = new Set<string>();
    const reviewItems = prs.flatMap<PaletteItem>((pr) => {
      if (seenPrs.has(pr.url)) return [];
      seenPrs.add(pr.url);
      return [
        {
          key: `review-${pr.url}`,
          group: "Pull requests",
          label: `#${pr.number}  ${pr.title}`,
          detail: pr.repo,
          icon: <PrIcon />,
          keywords: `${pr.author} ${pr.headRef}`,
          run: closeAnd(() => {
            requestReviewFocus(pr.url);
            navigate({ to: "/reviews" });
          }),
        },
      ];
    });
    const sessionItems = sessions.map<PaletteItem>((session) => ({
      key: `session-${session.sessionId}`,
      group: "Sessions",
      label: session.termKey ?? session.sessionId,
      detail: `${session.agentKind} · ${session.state}`,
      icon: <TerminalIcon />,
      keywords: `${session.repo ?? ""} ${session.cwd}`,
      run: closeAnd(() => navigate({ to: "/" })),
    }));
    return [...navigation, ...ticketItems, ...treeItems, ...reviewItems, ...sessionItems];
  }, [
    inbox,
    navigate,
    requestIssueFocus,
    requestReviewFocus,
    requestTreeFocus,
    sessions,
    tasks,
    triageEnabled,
    worktrees,
    setCommandPaletteOpen,
  ]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items.slice(0, 18);
    return items
      .filter((item) =>
        `${item.label} ${item.detail ?? ""} ${item.keywords ?? ""}`.toLowerCase().includes(needle),
      )
      .slice(0, 30);
  }, [items, query]);

  if (!commandPaletteOpen) return null;

  return (
    <div className="fixed inset-0 z-[95] flex justify-center px-4 pt-[10vh]">
      <button
        type="button"
        aria-label="Close command palette"
        onClick={() => setCommandPaletteOpen(false)}
        className="fixed inset-0 cursor-default bg-black/45 backdrop-blur-sm"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal
        aria-label="Command palette"
        className="relative flex max-h-[72vh] w-[680px] max-w-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line-strong bg-popover shadow-[0_32px_90px_-24px_rgba(0,0,0,.9)]"
      >
        <div className="group flex items-center gap-3 border-b border-line px-4 py-3">
          <SearchIcon className="text-muted-3 transition-colors group-focus-within:text-accent" />
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
                setActive((index) => Math.min(index + 1, filtered.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                filtered[active]?.run();
              }
            }}
            placeholder="Search tickets, PRs, worktrees, sessions, or actions…"
            className="overlay-search-input min-w-0 flex-1 bg-transparent text-[13px] text-fg-2 outline-none placeholder:text-muted-4"
          />
          <span className="rounded-[var(--radius-sm)] border border-line-2 px-1.5 py-0.5 font-mono text-[9px] text-muted-4">
            ESC
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="py-12 text-center font-mono text-[11px] text-muted-3">
              No matching command.
            </div>
          ) : (
            filtered.map((item, index) => {
              const newGroup = index === 0 || filtered[index - 1]?.group !== item.group;
              return (
                <div key={item.key}>
                  {newGroup && (
                    <div className="px-2 pt-2 pb-1 font-mono text-[9px] tracking-[.08em] text-muted-4 uppercase">
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    onMouseEnter={() => setActive(index)}
                    onClick={item.run}
                    className={`flex w-full cursor-pointer items-center gap-3 rounded-[var(--radius-md)] px-2.5 py-2 text-left ${active === index ? "bg-selected" : "hover:bg-hover"}`}
                  >
                    <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[var(--radius-sm)] border border-line-2 bg-input text-muted-2">
                      {item.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-fg-2">{item.label}</span>
                      {item.detail && (
                        <span className="mt-0.5 block truncate font-mono text-[9.5px] text-muted-4">
                          {item.detail}
                        </span>
                      )}
                    </span>
                    {active === index && (
                      <span className="font-mono text-[9px] text-muted-4">↵</span>
                    )}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="flex items-center gap-4 border-t border-line px-4 py-2 font-mono text-[9px] text-muted-4">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="ml-auto">⌘/ shortcuts</span>
        </div>
      </div>
    </div>
  );
}
