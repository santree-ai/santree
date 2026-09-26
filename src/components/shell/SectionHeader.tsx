/**
 * The rail's section-header register — TRIAGE, PROJECTS, DAEDALUS — and the
 * "+" that sits at its trailing edge. One definition, so the sections read as
 * peers: the same height, the same small caps, the label in the column every
 * row under it hangs from (`px-4`).
 */
import { PlusIcon } from "../icons";
import { Spinner } from "../primitives";

export const SECTION_HEADER =
  "mt-2 flex h-8 flex-none items-center gap-1.5 px-4 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-5";

/** The section's add action. `pending` holds its place with a spinner while an
 *  add it started is still under way. */
export function SectionAddButton({
  label,
  onClick,
  pending = false,
}: {
  /** Its accessible name and tooltip. */
  label: string;
  onClick: () => void;
  pending?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-label={label}
      title={label}
      className="ml-auto flex h-5 w-5 cursor-pointer items-center justify-center rounded text-muted-4 transition-colors hover:bg-hover hover:text-fg-2 disabled:cursor-default"
    >
      {pending ? <Spinner size={11} /> : <PlusIcon size={12} />}
    </button>
  );
}
