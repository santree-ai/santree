/**
 * The app's in-progress affordance — the same pulsing dot the Setup tab wears —
 * standing in for a running check's status glyph. A glyph reads as an outcome,
 * and a running check is the one row on the list that hasn't got one yet.
 *
 * `bg-current` so it takes the tint of whatever renders it: a running section's
 * color already comes from `checkStatusMeta`, so the dot can't drift from the
 * glyph it replaces. Its own file rather than one pane's, because both checks
 * hosts render it (Reviews' Checks tab and Trees' PR pane) and neither should
 * have to import the other's queries to get a dot.
 */
export function RunningDot({ label }: { label?: string }) {
  const cls = "inline-block h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-current";
  // Labelled where it stands alone in a row's glyph column; decorative where the
  // text beside it already says "running" (a section header, a summary tally).
  return label ? (
    <span role="img" aria-label={label} className={cls} />
  ) : (
    <span aria-hidden className={cls} />
  );
}
