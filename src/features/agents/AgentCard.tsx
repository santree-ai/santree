/**
 * One agent as a card. Cards tile several-per-row inside their group, so a
 * cross-repo panel stays readable on a wide window instead of running a handful
 * of very long lines down the middle of the screen.
 *
 * Reading order is fixed top to bottom: what it is → what it's asking → where it
 * lives. The ask gets the visual weight, because that's the only line that ever
 * requires a decision.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { PrState } from "../../bindings";
import { AgentIcon } from "../../components/icons";
import { MarkdownTitle } from "../../components/Markdown";
import { PrChips } from "../../components/PrChip";
import { RelativeTime } from "../../components/RelativeTime";
import { WorktreeStats } from "../../components/WorktreeStats";
import { displayFill, fillColor } from "../../lib/contextFill";
import { sessionStateMeta } from "../../theme/colors";
import { type AgentEntry, entryColor, repoLabel } from "./registry";

type Pr = { number: number; url: string; state: PrState };

/**
 * Arrow keys move between cards. Left/right step through the flow; up/down jump
 * to the visually adjacent row, found geometrically — in a wrapping grid the
 * card "above" is not the previous one in the DOM, and stepping by one would
 * feel broken to anyone using the keyboard.
 */
function roveCards(e: ReactKeyboardEvent<HTMLElement>): boolean {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
  if (!keys.includes(e.key)) return false;
  const list = e.currentTarget.closest("[data-agent-list]");
  const cards = [...(list?.querySelectorAll<HTMLElement>("[data-agent-card]") ?? [])];
  const at = cards.indexOf(e.currentTarget);
  if (at === -1) return false;
  e.preventDefault();

  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const next = at + (e.key === "ArrowRight" ? 1 : -1);
    cards[Math.max(0, Math.min(cards.length - 1, next))]?.focus();
    return true;
  }

  const here = e.currentTarget.getBoundingClientRect();
  const down = e.key === "ArrowDown";
  // Candidates on a different visual row, in the requested direction.
  const candidates = cards
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => (down ? r.top > here.top + 1 : r.top < here.top - 1));
  if (candidates.length === 0) return true;
  // Nearest such row, then the card in it closest to the current column.
  const rowTop = down
    ? Math.min(...candidates.map((c) => c.r.top))
    : Math.max(...candidates.map((c) => c.r.top));
  const row = candidates.filter(({ r }) => Math.abs(r.top - rowTop) < 1);
  row.sort((a, b) => Math.abs(a.r.left - here.left) - Math.abs(b.r.left - here.left));
  row[0]?.el.focus();
  return true;
}

/**
 * The state indicator. `working` breathes, `needs you` pings — everything else
 * is a still dot, so motion on screen always means "something is happening" or
 * "something wants you", never decoration.
 */
function StateDot({ entry }: { entry: AgentEntry }) {
  const color = entryColor(entry);
  return (
    <span
      aria-hidden
      className={`relative flex-none rounded-full ${entry.bucket === "working" ? "animate-breathe" : ""} ${
        entry.bucket === "attention" ? "animate-attention-ping" : ""
      }`}
      style={{ width: 7, height: 7, background: color, color }}
    />
  );
}

export function AgentCard({
  entry,
  selected,
  usedPct,
  prs,
  onSelect,
  onOpen,
}: {
  entry: AgentEntry;
  selected: boolean;
  /** Claude's raw context-fill for this session, when it has reported one. */
  usedPct: number | null;
  prs: Pr[];
  onSelect: () => void;
  onOpen: () => void;
}) {
  const meta = sessionStateMeta[entry.state];
  const color = entryColor(entry);
  const pct = usedPct == null ? null : displayFill(usedPct);
  const asking = entry.bucket === "attention";
  const providerLabel = entry.agentKind === "Claude" ? "Claude" : entry.agentKind;

  return (
    <button
      type="button"
      data-agent-card
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (roveCards(e)) return;
        if (e.key !== "Enter") return;
        // Enter opens rather than re-selecting; preventDefault stops the button's
        // synthesized click from also firing onSelect.
        e.preventDefault();
        onOpen();
      }}
      aria-current={selected}
      data-active={selected}
      className="selection-row group flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left focus-visible:relative focus-visible:z-10"
    >
      <div className="flex h-7 flex-none items-center">
        <StateDot entry={entry} />
      </div>

      <div className="flex w-[76px] flex-none items-center gap-1.5 pt-[5px] text-muted-3">
        <AgentIcon kind={entry.agentKind} size={12} className="flex-none" />
        <span className="truncate font-mono text-[10px]">{providerLabel}</span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <MarkdownTitle className="min-w-0 truncate font-mono text-[12px] font-medium text-fg-2">
            {entry.title}
          </MarkdownTitle>
          <span className="flex-none font-mono text-[9.5px] tracking-wide" style={{ color }}>
            {meta?.short ?? "—"}
          </span>
          <span aria-hidden className="text-[9px] text-muted-5">
            ·
          </span>
          <span className="flex-none font-mono text-[9.5px] text-muted-3">{entry.purpose}</span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] leading-[1.35]">
          {(entry.message || entry.subtitle) && (
            <MarkdownTitle
              className={`min-w-0 flex-1 truncate ${asking ? "text-fg-3" : "text-muted-3"}`}
              title={entry.message ?? entry.subtitle ?? undefined}
            >
              {entry.message ?? entry.subtitle ?? ""}
            </MarkdownTitle>
          )}
          {!entry.message && !entry.subtitle && (
            <span
              className="min-w-0 flex-1 font-mono text-[9.5px] text-muted-4"
              title={
                entry.openable
                  ? undefined
                  : "Santree cannot identify which workspace owns this session"
              }
            >
              {entry.openable ? "No recent activity" : "Workspace unavailable"}
            </span>
          )}
          <span className="flex min-w-0 flex-none items-center gap-2 font-mono text-[9.5px] text-muted-4">
            {entry.repo && <span className="max-w-[230px] truncate">{repoLabel(entry.repo)}</span>}
            {prs.length > 0 && <PrChips prs={prs} interactive={false} />}
            {entry.worktree && <WorktreeStats worktree={entry.worktree} />}
          </span>
        </div>
      </div>

      <div className="flex w-[70px] flex-none flex-col items-end gap-1.5 pt-[3px]">
        <RelativeTime
          ms={entry.updatedAtMs}
          className="font-mono text-[10px] text-muted-4 tabular-nums"
        />
        {pct !== null && (
          <span className="flex items-center gap-1.5" title={`Context ${pct}% full`}>
            <span className="h-1 w-9 overflow-hidden rounded-full bg-input">
              <span
                className="block h-full rounded-full"
                style={{ width: `${pct}%`, background: fillColor(pct) }}
              />
            </span>
            <span
              className="w-7 text-right font-mono text-[9.5px] tabular-nums"
              style={{ color: fillColor(pct) }}
            >
              {pct}%
            </span>
          </span>
        )}
      </div>
    </button>
  );
}
