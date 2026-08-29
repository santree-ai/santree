/**
 * A read-only, syntax-highlighted view of a file's contents — used when a file
 * picked from the "All files" tab isn't a diff. Tokenizing lives in
 * `lib/highlight.ts`, shared with the code fences inside a rendered markdown
 * preview so the same file highlights identically either way.
 */
import { useMemo } from "react";

import { highlightToHtml, langForFile } from "../../lib/highlight";

export function CodeView({ path, content }: { path: string; content: string }) {
  const html = useMemo(() => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return highlightToHtml(content, langForFile(name));
  }, [path, content]);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <pre
        className="code-hl selectable px-3 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre text-fg-3"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: serialized from our own escaped Prism tokens.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
