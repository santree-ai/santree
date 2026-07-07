/** Per-depth indentation for a file-tree row: one vertical guide line per
 *  ancestor level so nesting reads clearly (a flat pixel pad didn't — folders
 *  and their contents looked like siblings). Shared by the Changes tree and the
 *  All-files browser so both indent identically. */
export const INDENT_PX = 16;

export function IndentGuides({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <span className="flex flex-none self-stretch" aria-hidden>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="border-line-2 border-l" style={{ width: INDENT_PX }} />
      ))}
    </span>
  );
}
