import type { ReactNode } from "react";
import { Logo } from "~/components/logo";
import { DEMO_VIEWS, type DemoView, NEEDS_YOU, VIEW_SUMMARY } from "./data";
import {
  ChevronDownGlyph,
  ChevronLeftGlyph,
  ChevronRightGlyph,
  CollapseGlyph,
  GearGlyph,
  HelpGlyph,
  RefreshGlyph,
} from "./widgets";

/** The window's shared chrome, mirroring the real app's ViewChrome: macOS
 * traffic lights + collapse toggle + back/forward over the sidebar column,
 * an Agents-first nav-tab strip with the accent underline, and the per-view
 * status summary + refresh button on the right. The repo switcher lives at
 * the top of the sidebar (where the real app puts it while the sidebar is
 * open). Decorative only — the fake tabs highlight in sync with the
 * external selector, which is the real control. */

export const SIDEBAR_W = 248;
export const TOPBAR_H = 46;

function ChromeIconButton({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-7 items-center justify-center rounded-md text-muted-2">
      {children}
    </span>
  );
}

export function WindowTopBar({ view }: { view: DemoView }) {
  const summary = VIEW_SUMMARY[view];
  return (
    <div
      className="flex shrink-0 items-stretch border-b border-line bg-surface"
      style={{ height: TOPBAR_H }}
      aria-hidden
    >
      {/* Sidebar cell: traffic lights + collapse toggle, back/forward at the
          cell's right edge; the sidebar hairline runs unbroken through the
          top bar, as the real app insists. */}
      <div
        className="flex shrink-0 items-center gap-2 border-r border-line pl-5 pr-2.5"
        style={{ width: SIDEBAR_W }}
      >
        <span className="flex gap-[7px]">
          <span className="size-[11px] rounded-full bg-[#ff5f57]" />
          <span className="size-[11px] rounded-full bg-[#febc2e]" />
          <span className="size-[11px] rounded-full bg-[#28c840]" />
        </span>
        <ChromeIconButton>
          <CollapseGlyph size={14} />
        </ChromeIconButton>
        <span className="ml-auto flex items-center gap-0.5 text-muted-2">
          <ChromeIconButton>
            <ChevronLeftGlyph size={14} className="opacity-40" />
          </ChromeIconButton>
          <ChromeIconButton>
            <ChevronRightGlyph size={14} className="opacity-40" />
          </ChromeIconButton>
        </span>
      </div>
      {/* Nav tabs: Agents spans every repo, then the divider, then the
          repo-scoped tabs — same order and underline as the real NavTabs. */}
      <div className="flex flex-1 items-stretch pr-3">
        <span className="flex items-center gap-1.5 px-3 text-[12px] text-muted-2">
          Agents
          {NEEDS_YOU > 0 && (
            <span className="font-mono text-[10px] font-semibold text-status-red">{NEEDS_YOU}</span>
          )}
        </span>
        <span className="flex items-center">
          <span className="h-[15px] w-px bg-line" />
        </span>
        {DEMO_VIEWS.map((v) => {
          const active = v.id === view;
          return (
            <span
              key={v.id}
              className={`flex items-center gap-1.5 px-3 text-[12px] ${
                active ? "font-medium text-fg" : "text-muted-2"
              }`}
              style={active ? { boxShadow: "inset 0 -2px 0 var(--color-accent)" } : undefined}
            >
              {v.label}
              <span className="font-mono text-[10px] tabular-nums text-muted-4">{v.count}</span>
            </span>
          );
        })}
        <span className="flex-1" />
        <span className="flex items-center gap-2.5">
          {summary && (
            <span className="font-mono text-[11px] text-muted-4">
              {summary.lead}
              <span
                style={{
                  color:
                    summary.color === "accent"
                      ? "var(--color-accent)"
                      : "var(--color-status-green)",
                }}
              >
                {summary.value}
              </span>
            </span>
          )}
          <span className="flex size-7 items-center justify-center rounded-md border border-line-2 bg-white/3 text-muted-2">
            <RefreshGlyph size={13} />
          </span>
        </span>
      </div>
    </div>
  );
}

/** The repo switcher pill at the top of the sidebar column. */
function RepoHeader() {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-hairline px-3">
      <span className="flex w-full items-center gap-[7px] rounded-md border border-hairline bg-white/3 px-[9px] py-[5px]">
        <Logo size={13} />
        <span className="min-w-0 flex-1 truncate text-left font-mono text-[11px] font-medium text-fg">
          santree
        </span>
        <ChevronDownGlyph size={11} className="shrink-0 text-muted-2" />
      </span>
    </div>
  );
}

/** The help + settings + version row at the bottom of every sidebar. */
function SidebarFooter() {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-t border-line px-2.5">
      <span className="flex size-6 items-center justify-center rounded-md border border-hairline text-muted-2">
        <HelpGlyph size={12} />
      </span>
      <span className="flex size-6 items-center justify-center rounded-md border border-hairline text-muted-2">
        <GearGlyph size={12} />
      </span>
      <span className="flex-1" />
      <span className="font-mono text-[9px] text-muted-4">v0.7.2</span>
    </div>
  );
}

/** Sidebar + main split used by every view: repo header on top of the
 * column, footer at its bottom, main content on a darker app surface. */
export function ViewShell({ sidebar, main }: { sidebar: ReactNode; main: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="flex shrink-0 flex-col overflow-hidden border-r border-line bg-panel"
        style={{ width: SIDEBAR_W }}
      >
        <RepoHeader />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{sidebar}</div>
        <SidebarFooter />
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-app/60">{main}</div>
    </div>
  );
}
