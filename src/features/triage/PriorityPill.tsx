/** The priority chip shown on triage rows and the issue header — the single
 *  source for both (they previously hand-rolled the same tinted pill). Renders
 *  nothing for "no priority", mirroring Linear, which shows no badge for it. */
import type { Priority } from "../../bindings";
import { Pill } from "../../components/primitives";
import { priorityColor } from "../../theme/colors";

export function PriorityPill({ priority, muted = false }: { priority: Priority; muted?: boolean }) {
  if (priority === "None") return null;
  const color = muted ? "var(--color-muted-4)" : priorityColor[priority];
  return (
    <Pill
      color={color}
      className="px-1.5 py-px font-mono text-[9px] font-semibold tracking-[.04em] uppercase"
    >
      {priority}
    </Pill>
  );
}
