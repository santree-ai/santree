/** The priority chip shown on triage rows and the issue header — the single
 *  source for both (they previously hand-rolled the same tinted pill). Renders
 *  nothing for "no priority", mirroring Linear, which shows no badge for it. */
import type { Priority } from "../bindings";
import { priorityColor } from "../theme/colors";
import { Pill } from "./primitives";

export function PriorityPill({ priority, muted = false }: { priority: Priority; muted?: boolean }) {
  if (priority === "None") return null;
  const color = muted ? "var(--color-muted-4)" : priorityColor[priority];
  return (
    <Pill color={color} className="px-1.5 py-px text-2xs font-semibold">
      {priority}
    </Pill>
  );
}
