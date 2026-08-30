/**
 * A ```mermaid fence, rendered as a diagram.
 *
 * mermaid is ~1MB of parser and layout code, so it is behind a dynamic
 * `import()`: a repo with no diagrams in it never loads a byte of it, and the
 * chunk arrives while the rest of the document is already on screen. That is
 * also why this renders a placeholder first rather than blocking the preview.
 *
 * Scoped to the **file preview** on purpose. The same fence in a PR comment or a
 * Linear description stays a code block: that text is written by anyone with
 * access to the repo, and handing attacker-influenceable input to a diagram
 * engine is a bigger surface than showing it as source. A file in your own
 * worktree is something you already opened.
 */
import { useEffect, useRef, useState } from "react";

import { useResolvedTheme } from "../theme/useResolvedTheme";

/** Ids have to be unique per render *and* valid CSS selectors — mermaid queries
 *  the DOM by them while laying out. A module counter beats `Math.random()` for
 *  being deterministic in tests. */
let seq = 0;

export function MermaidDiagram({ code }: { code: string }) {
  const theme = useResolvedTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Renders are async and the theme can flip mid-flight; only the newest one may
  // write its result.
  const runId = useRef(0);

  useEffect(() => {
    const run = ++runId.current;
    setFailed(null);
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          // mermaid's own sanitizer. `strict` keeps raw HTML out of labels,
          // which is the setting that makes a diagram safe to render at all.
          securityLevel: "strict",
          theme: theme === "light" ? "neutral" : "dark",
          fontFamily: "var(--font-sans, system-ui)",
        });
        const { svg } = await mermaid.render(`mermaid-${++seq}`, code);
        if (runId.current === run) setSvg(svg);
      } catch (e) {
        // A syntax error in the diagram is the author's, not a crash: show the
        // source they wrote plus what mermaid objected to, so the fence is still
        // readable and the mistake is findable.
        if (runId.current === run) setFailed(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [code, theme]);

  if (failed !== null) {
    return (
      <div className="mb-2.5 overflow-hidden rounded-lg border border-line-2 bg-input">
        <div className="border-b border-line-2 px-3 py-1.5 text-[11px] text-status-amber">
          This diagram didn't parse: {failed}
        </div>
        <pre className="overflow-x-auto p-3 font-mono text-[11.5px] leading-[1.55] text-fg-3">
          {code}
        </pre>
      </div>
    );
  }

  if (svg === null) {
    return (
      <div className="mb-2.5 rounded-lg border border-line-2 bg-input px-3 py-6 text-center text-[11.5px] text-muted-4">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="mb-2.5 overflow-x-auto rounded-lg border border-line-2 bg-input p-3 text-center [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid's own output, produced with securityLevel "strict" (DOMPurify).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
