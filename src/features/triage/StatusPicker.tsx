/**
 * The workflow-state picker that replaces the old "Promote" button. Changing the
 * state to a non-triage state (Backlog/Todo/…) moves the issue out of the triage
 * queue — i.e. "promotes" it. Shows a static badge until the detail (and thus the
 * team's states) loads.
 *
 * The set-state mutation is optimistic (see `useTriageSetState`), so the picker
 * flips to the chosen state instantly and rolls back only on error — no local
 * "Saving…" state is needed.
 */
import type { TriageDetail } from "../../bindings";
import { ChevronDownIcon } from "../../components/icons";
import { Dropdown } from "../../components/primitives";

export function StatusPicker({
  detail,
  onSetState,
}: {
  detail?: TriageDetail;
  onSetState: (stateId: string) => void;
}) {
  if (!detail) {
    return (
      <span className="rounded border border-line-2 bg-input px-[7px] py-[1.5px] font-mono text-[9px] text-muted-2">
        Triage
      </span>
    );
  }

  const current = detail.states.find((s) => s.id === detail.stateId);
  const label = current?.name ?? detail.state;
  const color = current?.color ?? "var(--color-muted-3)";
  const disabled = detail.states.length === 0;

  return (
    <Dropdown
      menuClassName="min-w-[170px] px-1"
      trigger={(toggle) => (
        <button
          type="button"
          onClick={() => !disabled && toggle()}
          disabled={disabled}
          className="flex cursor-pointer items-center gap-1.5 rounded border border-line-2 bg-input px-[7px] py-[2.5px] text-[10.5px] text-fg-2 hover:border-line-strong disabled:cursor-default disabled:opacity-60"
        >
          <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: color }} />
          {label}
          <ChevronDownIcon size={10} className="text-muted-3" />
        </button>
      )}
    >
      {(close) =>
        detail.states.map((s) => {
          const isCurrent = s.id === detail.stateId;
          return (
            <button
              type="button"
              key={s.id}
              onClick={() => {
                close();
                if (!isCurrent) onSetState(s.id);
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg-3 hover:bg-hover-2"
            >
              <span className="h-2 w-2 flex-none rounded-full" style={{ background: s.color }} />
              <span className="flex-1">{s.name}</span>
              {isCurrent && <span className="text-[10px] text-[color:var(--accent)]">✓</span>}
            </button>
          );
        })
      }
    </Dropdown>
  );
}
