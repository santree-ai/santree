/**
 * The source text of a file's lines, recovered from the unified diff patch
 * GitHub returns for a PR file (`PrFile.patch`).
 *
 * The review composer needs it for the two places GitHub reads the same lines:
 * prefilling a ```suggestion block with what it would replace, and rendering a
 * posted suggestion as the diff it describes. The full file source is a separate,
 * lazily-fetched request (`usePrFileSource`) that may not have landed — and a
 * comment can only ever sit on a line that IS in the patch, so the patch is both
 * always present and sufficient.
 *
 * Same numbering convention as the rest of the review code: each side is numbered
 * independently and `onRight` picks which one (new/right vs old/left).
 */

/** `@@ -12,7 +14,9 @@ …` — the two line numbers a hunk starts at. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** One side's line number → its text, for every line the patch carries. */
export function patchLines(patch: string, onRight: boolean): Map<number, string> {
  const out = new Map<number, string>();
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const hunk = HUNK.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    // Anything before the first `@@` is header, not content.
    if (oldNo === 0 && newNo === 0) continue;
    // `\ No newline at end of file` annotates the line above it; it isn't a line.
    if (raw.startsWith("\\")) continue;
    // git writes an empty context line as a bare "" rather than " ", so a missing
    // first character means context, not a malformed row.
    const marker = raw[0] ?? " ";
    const text = raw.slice(1);
    if (marker === "+") {
      if (onRight) out.set(newNo, text);
      newNo++;
    } else if (marker === "-") {
      if (!onRight) out.set(oldNo, text);
      oldNo++;
    } else {
      if (onRight) out.set(newNo, text);
      else out.set(oldNo, text);
      oldNo++;
      newNo++;
    }
  }
  return out;
}

/**
 * The first and last line number of each hunk, on one side. A hunk with no line
 * on that side (a pure addition, seen from the old side) contributes nothing.
 */
export function hunkRanges(patch: string, onRight: boolean): Array<[number, number]> {
  const numbers = [...patchLines(patch, onRight).keys()];
  const ranges: Array<[number, number]> = [];
  for (const n of numbers) {
    const last = ranges[ranges.length - 1];
    // The map is built in patch order, so lines within a hunk arrive contiguous
    // and a jump means the next hunk started.
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return ranges;
}

/**
 * A dragged line range, cut down to the hunk it started in. GitHub rejects a
 * review comment whose range crosses a hunk boundary, so a drag that runs off the
 * end of one is clamped to it rather than posted and 422'd. `null` when the start
 * isn't in any hunk on that side, which cancels the selection.
 *
 * `from` is where the drag *started*, not necessarily the lower number — a drag
 * upwards is the same selection, so the pair is ordered before clamping.
 */
export function clampToHunk(
  patch: string,
  onRight: boolean,
  from: number,
  to: number,
): [number, number] | null {
  const hunk = hunkRanges(patch, onRight).find(([lo, hi]) => from >= lo && from <= hi);
  if (!hunk) return null;
  return [Math.max(Math.min(from, to), hunk[0]), Math.min(Math.max(from, to), hunk[1])];
}

/**
 * Lines `from`..`to` (inclusive) of one side, in order — or `null` when the patch
 * doesn't carry every one of them. All-or-nothing on purpose: a suggestion is a
 * literal replacement for the range it's anchored to, so one line quietly missing
 * from the prefill is a suggestion that deletes it.
 */
export function patchLineRange(
  patch: string,
  onRight: boolean,
  from: number,
  to: number,
): string[] | null {
  if (from > to) return null;
  const lines = patchLines(patch, onRight);
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    const text = lines.get(n);
    if (text === undefined) return null;
    out.push(text);
  }
  return out;
}
