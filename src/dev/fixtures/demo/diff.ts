/**
 * Line diffs for the demo world, computed rather than hand-written so a
 * file's patch, its line numbers and its +/− counts can never disagree.
 * Files here are a few hundred lines at most, so a plain LCS table is fine.
 */

type Op = { kind: " " | "+" | "-"; text: string };

function ops(oldText: string, newText: string): Op[] {
  const a = oldText === "" ? [] : oldText.replace(/\n$/, "").split("\n");
  const b = newText === "" ? [] : newText.replace(/\n$/, "").split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push({ kind: "+", text: b[j] });
      j++;
    } else {
      out.push({ kind: "-", text: a[i] });
      i++;
    }
  }
  return out;
}

export interface FileDiff {
  /** Hunks only (`@@ … @@` onwards) — GitHub's `patch` field. */
  patch: string;
  additions: number;
  deletions: number;
}

const CONTEXT = 3;

export function diffOf(oldText: string, newText: string): FileDiff {
  const all = ops(oldText, newText);
  const additions = all.filter((o) => o.kind === "+").length;
  const deletions = all.filter((o) => o.kind === "-").length;

  // Which ops a hunk keeps: every change plus CONTEXT lines either side.
  const keep = new Array(all.length).fill(false);
  all.forEach((o, k) => {
    if (o.kind === " ") return;
    for (let d = Math.max(0, k - CONTEXT); d <= Math.min(all.length - 1, k + CONTEXT); d++) {
      keep[d] = true;
    }
  });

  const hunks: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  let k = 0;
  while (k < all.length) {
    if (!keep[k]) {
      if (all[k].kind !== "+") oldLine++;
      if (all[k].kind !== "-") newLine++;
      k++;
      continue;
    }
    const startOld = oldLine;
    const startNew = newLine;
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (k < all.length && keep[k]) {
      const o = all[k];
      body.push(`${o.kind}${o.text}`);
      if (o.kind !== "+") {
        oldLine++;
        oldCount++;
      }
      if (o.kind !== "-") {
        newLine++;
        newCount++;
      }
      k++;
    }
    const oldStart = oldCount === 0 ? startOld - 1 : startOld;
    const newStart = newCount === 0 ? startNew - 1 : startNew;
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
  }
  return { patch: hunks.length ? `${hunks.join("\n")}\n` : "", additions, deletions };
}

/** The same diff as `git diff` prints it, header included. */
export function gitDiff(path: string, oldText: string, newText: string): string {
  const { patch } = diffOf(oldText, newText);
  if (!patch) return "";
  const created = oldText === "";
  const header = [
    `diff --git a/${path} b/${path}`,
    ...(created
      ? ["new file mode 100644", "index 0000000..5d1c0a2"]
      : ["index 8e3b1f4..5d1c0a2 100644"]),
    created ? "--- /dev/null" : `--- a/${path}`,
    `+++ b/${path}`,
  ];
  return `${header.join("\n")}\n${patch}`;
}
