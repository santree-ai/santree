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
import { PrChips } from "../../components/PrChip";
import { RelativeTime } from "../../components/RelativeTime";
import { WorktreeStats } from "../../components/WorktreeStats";
import { displayFill, fillColor } from "../../lib/contextFill";
import { alpha, sessionStateMeta } from "../../theme/colors";
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
      className="flex h-full cursor-pointer flex-col gap-2 rounded-[10px] border p-3 text-left transition-colors"
      style={{
        borderColor: selected ? alpha(50, color) : "var(--color-line-2)",
        background: selected ? alpha(9, color) : "var(--color-deep)",
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StateDot entry={entry} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-2">
          {entry.title}
        </span>
        <span className="flex-none font-mono text-[9.5px] tracking-wide" style={{ color }}>
          {meta?.short ?? "—"}
        </span>
        <RelativeTime
          ms={entry.updatedAtMs}
          className="flex-none font-mono text-[10px] text-muted-4 tabular-nums"
        />
      </div>

      {entry.subtitle && (
        <div className="line-clamp-2 text-[12px] leading-[1.35] text-muted-2">{entry.subtitle}</div>
      )}

      {/* The pending question is the only line that ever demands a decision, so
          it gets a tinted panel when the agent is actually blocked, and plain
          muted text otherwise. */}
      {entry.message &&
        (asking ? (
          <div
            className="line-clamp-3 rounded-md border px-2 py-1.5 text-[11.5px] leading-[1.4] text-fg-3"
            style={{ borderColor: alpha(30, color), background: alpha(8, color) }}
          >
            {entry.message}
          </div>
        ) : (
          <div className="line-clamp-2 text-[11.5px] leading-[1.4] text-muted-3">
            {entry.message}
          </div>
        ))}

      <div className="mt-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-0.5 font-mono text-[10px] text-muted-4">
        {entry.repo && (
          <span className="max-w-full flex-none truncate rounded bg-input px-1 py-px text-muted-3">
            {repoLabel(entry.repo)}
          </span>
        )}
        {/* Static: the whole card is one button, so a clickable chip would be an
            invalid nested <button> and a second competing action. The peek panel
            carries the real link. */}
        {prs.length > 0 && <PrChips prs={prs} interactive={false} />}
        {entry.worktree && <WorktreeStats worktree={entry.worktree} />}
        {pct !== null && (
          <span className="flex flex-none items-center gap-1" title={`Context ${pct}% full`}>
            <span className="h-1 w-8 overflow-hidden rounded-full bg-input">
              <span
                className="block h-full rounded-full"
                style={{ width: `${pct}%`, background: fillColor(pct) }}
              />
            </span>
            <span className="tabular-nums" style={{ color: fillColor(pct) }}>
              {pct}%
            </span>
          </span>
        )}
        {!entry.openable && (
          <span
            className="flex-none"
            title="santree can't tell which workspace this session belongs to, so it can't open it"
          >
            unattributed
          </span>
        )}
      </div>
    </button>
  );
}
