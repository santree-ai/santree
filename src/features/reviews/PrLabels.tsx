/**
 * The PR's labels ("tags"), editable inline: each is a removable colored chip, and
 * a "＋" dropdown toggles any of the repo's labels on or off. Labels live on the
 * (deduped) PR detail; edits write straight through to GitHub optimistically, so
 * the row updates instantly.
 *
 * Every label color is a raw GitHub hex, which can land anywhere on the lightness
 * scale (`ededed` on white, `0e1116` on black) — so it always goes through
 * `readableLabelColor` before it's painted.
 */
import { useState } from "react";

import type { PrLabel, ReviewPr } from "../../bindings";
import { CheckIcon, CloseIcon, PlusIcon } from "../../components/icons";
import { Dropdown, MENU_ITEM } from "../../components/primitives";
import { usePrDetail, useRepoLabels, useSetPrLabels } from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import { alpha, readableLabelColor } from "../../theme/colors";
import { useResolvedTheme } from "../../theme/useResolvedTheme";

export function PrLabels({ pr }: { pr: ReviewPr }) {
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(owner, name, pr.number);
  const { mutate: setLabels } = useSetPrLabels(owner, name, pr.number);
  // Fetch the repo's palette only once the picker opens (labels rarely change).
  const [picking, setPicking] = useState(false);
  const { data: repoLabels = [] } = useRepoLabels(owner, name, picking);

  // The labels row lives on the PR detail; show nothing until it loads.
  if (!detail) return null;
  const labels = detail.labels;
  const assigned = new Set(labels.map((l) => l.name));

  const toggle = (label: PrLabel) =>
    setLabels(
      assigned.has(label.name) ? labels.filter((l) => l.name !== label.name) : [...labels, label],
    );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="text-muted-4">Labels</span>
      {labels.map((l) => (
        <LabelChip
          key={l.name}
          label={l}
          onRemove={() => setLabels(labels.filter((x) => x !== l))}
        />
      ))}
      {labels.length === 0 && <span className="text-muted-3">None</span>}
      <Dropdown
        open={picking}
        onOpenChange={setPicking}
        menuClassName="w-64 overflow-hidden"
        trigger={(t) => (
          <button
            type="button"
            onClick={t}
            title="Add or remove labels"
            className="flex cursor-pointer items-center gap-1 rounded border border-dashed border-line-3 px-1.5 py-px text-[10.5px] text-muted-2 hover:border-line-strong hover:text-fg-2"
          >
            <PlusIcon size={10} /> Label
          </button>
        )}
      >
        {() => <LabelPicker labels={repoLabels} assigned={assigned} onToggle={toggle} />}
      </Dropdown>
    </div>
  );
}

/** One assigned label — a colored chip with an inline remove (×) button. The
 *  chip's whole palette derives from a lightness-clamped version of the label's
 *  raw hex so pale labels (e.g. `risk:high`) stay legible in both themes. */
function LabelChip({ label, onRemove }: { label: PrLabel; onRemove: () => void }) {
  const theme = useResolvedTheme();
  const color = readableLabelColor(label.color, theme);
  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium"
      style={{ color, background: alpha(14, color), border: `1px solid ${alpha(42, color)}` }}
      title={label.description ?? undefined}
    >
      {label.name}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove label ${label.name}`}
        className="flex cursor-pointer items-center opacity-70 hover:opacity-100"
      >
        <CloseIcon size={9} />
      </button>
    </span>
  );
}

/** The add/remove-labels dropdown body: a filter box over the repo's palette, each
 *  row a toggle (checked when currently assigned). */
function LabelPicker({
  labels,
  assigned,
  onToggle,
}: {
  labels: PrLabel[];
  assigned: Set<string>;
  onToggle: (label: PrLabel) => void;
}) {
  const theme = useResolvedTheme();
  const [q, setQ] = useState("");
  const filtered = labels.filter((l) => l.name.toLowerCase().includes(q.toLowerCase().trim()));
  return (
    <div>
      <div className="border-b border-line-3 p-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter labels…"
          className="w-full rounded border border-line-3 bg-input px-2 py-1 text-[11.5px] text-fg-2 outline-none focus:border-line-strong"
        />
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-[11.5px] text-muted-3">No labels.</div>
        ) : (
          filtered.map((l) => (
            <button key={l.name} type="button" onClick={() => onToggle(l)} className={MENU_ITEM}>
              <span
                className="h-2.5 w-2.5 flex-none rounded-full"
                style={{ background: readableLabelColor(l.color, theme) }}
              />
              <span className="min-w-0 flex-1 truncate" title={l.description ?? undefined}>
                {l.name}
              </span>
              {assigned.has(l.name) && <CheckIcon size={12} className="flex-none text-accent" />}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
