/**
 * The Terminal tab: a sidebar list of open sessions (the tab strip) plus a
 * launcher. The terminals themselves render in the persistent `TerminalLayer`
 * (mounted at the app shell) so they survive navigation — this route only drives
 * the global session list and overlays nothing in its content area.
 */
import { useEffect, useRef, useState } from "react";

import { ViewChrome } from "../../components/chrome/ViewChrome";
import { CliIcon } from "../../components/icons";
import { SidebarFooter } from "../../components/SidebarFooter";
import { useRepos } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { alpha } from "../../theme/colors";
import type { TerminalSource } from "./orchestrator";
import { useTerminals } from "./TerminalsContext";

/** Display order + labels for the grouped session list. */
const GROUPS: [TerminalSource, string][] = [
  ["shell", "Shells"],
  ["triage", "Triage"],
  ["issue", "Issues"],
];

export function TerminalSurface() {
  const { activeRepo } = useApp();
  const { data: repos = [] } = useRepos();
  const repoPath = repos.find((r) => r.name === activeRepo)?.path ?? undefined;
  const { tabs, activeKey, setActiveKey, open, close } = useTerminals();
  const [cmd, setCmd] = useState("");
  const started = useRef(false);

  // Open one shell the first time the tab is visited with no sessions yet.
  useEffect(() => {
    if (started.current || tabs.length > 0) return;
    started.current = true;
    open({ title: "shell", cwd: repoPath });
  }, [open, repoPath, tabs.length]);

  const runCommand = () => {
    const c = cmd.trim();
    if (!c) return;
    // Seed the command into a login shell — byte-identical to typing it, and the
    // shell's PATH resolves CLIs like `vim`, `htop`, `claude`.
    open({ title: c.split(/\s+/)[0], cwd: repoPath, seed: c });
    setCmd("");
  };

  return (
    <ViewChrome
      sidebar={
        <>
          <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
            <span className="text-[12px] font-semibold text-fg-2">Terminals</span>
            <span className="font-mono text-[10.5px] text-muted-4">{tabs.length}</span>
            <button
              type="button"
              onClick={() => open({ title: "shell", cwd: repoPath })}
              title="New terminal"
              className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-line-3 text-muted-2 hover:border-line-strong hover:text-fg-2"
            >
              +
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {GROUPS.map(([source, label]) => {
              const items = tabs.filter((t) => t.source === source);
              if (items.length === 0) return null;
              return (
                <div key={source} className="mb-2">
                  <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
                    {label}
                    <span className="text-muted-5">{items.length}</span>
                  </div>
                  {items.map((t) => {
                    const active = t.key === activeKey;
                    return (
                      <div
                        key={t.key}
                        className="group mb-[3px] flex items-center rounded-md transition-colors hover:bg-hover"
                        style={active ? { background: alpha(10) } : undefined}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveKey(t.key)}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 pl-2.5 text-left"
                        >
                          <CliIcon
                            size={13}
                            className={active ? "text-[color:var(--accent)]" : "text-muted-3"}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-3">
                            {t.title}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => close(t.key)}
                          aria-label="Close terminal"
                          className="flex-none cursor-pointer px-2 py-2 text-[13px] text-muted-5 opacity-0 hover:text-fg-2 group-hover:opacity-100"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          <div className="flex-none border-t border-hairline p-2">
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runCommand()}
              placeholder="Run a command… (e.g. htop)"
              className="w-full rounded-md border border-line-3 bg-input px-2.5 py-1.5 font-mono text-[11.5px] text-fg-2 placeholder:text-muted-4"
            />
          </div>

          <SidebarFooter />
        </>
      }
    >
      {/* The persistent TerminalLayer overlays this area on /terminal. */}
      <div className="min-w-0 flex-1 bg-panel" />
    </ViewChrome>
  );
}
