import type { ReactNode } from "react";
import { Logo } from "~/components/logo";
import { DEMO_VIEWS, type DemoView } from "./data";

/** The window's shared chrome, mirroring the real app's ViewChrome: traffic
 * lights inset over the sidebar column, repo pill, nav tabs with mono
 * counts. Decorative only — the fake tabs highlight in sync with the
 * external selector, which is the real control. */

export const SIDEBAR_W = 248;
export const TOPBAR_H = 44;

export function WindowTopBar({ view }: { view: DemoView }) {
  return (
    <div
      className="flex shrink-0 items-stretch border-b border-hairline"
      style={{ height: TOPBAR_H }}
      aria-hidden
    >
      {/* Sidebar cell: traffic lights + repo pill; the sidebar hairline runs
          unbroken through the top bar, as the real app insists. */}
      <div
        className="flex shrink-0 items-center gap-3 border-r border-hairline pl-5"
        style={{ width: SIDEBAR_W }}
      >
        <span className="flex gap-[7px]">
          <span className="size-[11px] rounded-full bg-white/12" />
          <span className="size-[11px] rounded-full bg-white/12" />
          <span className="size-[11px] rounded-full bg-white/12" />
        </span>
        <span className="flex items-center gap-1.5 rounded-md border border-hairline bg-white/3 px-2 py-1">
          <Logo size={12} />
          <span className="font-mono text-[10px] text-muted">santree-ai/santree</span>
        </span>
      </div>
      {/* Nav tabs */}
      <div className="flex flex-1 items-center gap-1 px-3">
        {DEMO_VIEWS.map((v) => (
          <span
            key={v.id}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] ${
              v.id === view ? "bg-white/6 text-fg" : "text-muted-2"
            }`}
          >
            {v.label}
            <span className="font-mono text-[9px] tabular-nums text-muted-4">{v.count}</span>
          </span>
        ))}
        <span className="ml-auto mr-2 size-3.5 rounded-full border border-hairline bg-white/4" />
      </div>
    </div>
  );
}

/** Sidebar + main split used by every view. */
export function ViewShell({ sidebar, main }: { sidebar: ReactNode; main: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1">
      <div
        className="flex shrink-0 flex-col overflow-hidden border-r border-hairline"
        style={{ width: SIDEBAR_W }}
      >
        {sidebar}
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{main}</div>
    </div>
  );
}
