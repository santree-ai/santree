/**
 * The 24px strip along the bottom of the window.
 *
 * Collapsing the app into one page removed the per-view header that used to carry
 * the ambient facts — agent usage, who is blocked on you, the keep-awake hold,
 * the updater, the manual refresh — and none of them belong to a single view, so
 * none of them can live inside one. They sit at the bottom because they are
 * status rather than navigation: worth a glance, never worth competing with the
 * content above.
 *
 * The bar is chrome, so it is deliberately quiet — one text size, muted by
 * default, color spent only on the two things that mean act now (an agent waiting
 * on you, a meter past its warn threshold). Each segment reads its own data and
 * renders nothing when it has none, so what is on the bar is what is true.
 */
import { AgentsSegment } from "./AgentsSegment";
import { KeepAwakeSegment } from "./KeepAwakeSegment";
import { RefreshSegment } from "./RefreshSegment";
import { ResourceSegment } from "./ResourceSegment";
import { SessionSegment } from "./SessionSegment";
import { UpdateSegment } from "./UpdateSegment";
import { UsageSegment } from "./UsageSegment";

/** The window-wide status bar. Mounted once by the shell, below everything. */
export function StatusBar() {
  return (
    <footer className="flex h-6 min-h-[24px] w-full flex-none items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-muted-4">
      <UsageSegment />
      <SessionSegment />
      <div className="flex-1" />
      {/* Keep-awake leads the trailing cluster because it is the only segment
          here the user *sets*: the others report (resources, agents, an
          available update) and Refresh acts on the view. A control you flip
          shouldn't move as the reporters beside it come and go. */}
      <KeepAwakeSegment />
      <ResourceSegment />
      <AgentsSegment />
      <UpdateSegment />
      <RefreshSegment />
    </footer>
  );
}
