import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Markdown, MarkdownDocument, MarkdownTitle } from "./Markdown";

// Stand in for the real diagram renderer: mermaid is a ~1MB dynamic import that
// these tests have no reason to load. What's under test is the routing — which
// renderer a ```mermaid fence reaches — not mermaid's own output.
vi.mock("./MermaidDiagram", () => ({
  MermaidDiagram: ({ code }: { code: string }) => <div data-testid="mermaid">{code}</div>,
}));

describe("Markdown raw-HTML handling", () => {
  it("renders <details>/<summary> as a native collapsible, not literal text", () => {
    const { container } = render(
      <Markdown>{`<details><summary>AK-175 ticket</summary><p>Body</p></details>`}</Markdown>,
    );
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(container.querySelector("summary")?.textContent).toBe("AK-175 ticket");
    // The tags must not leak as escaped text.
    expect(container.textContent).not.toContain("<summary>");
  });

  it("drops HTML comments (e.g. the linear-linkback marker)", () => {
    const { container } = render(<Markdown>{`<!-- linear-linkback -->Hello`}</Markdown>);
    expect(container.textContent).not.toContain("linear-linkback");
    expect(container.textContent).toContain("Hello");
  });

  it("keeps inline data: image sources (Linear inlines images)", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    const { container } = render(<Markdown>{`![alt](${src})`}</Markdown>);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(src);
  });

  it("sanitizes dangerous HTML", () => {
    const { container } = render(
      <Markdown>{`<img src=x onerror="alert(1)"><script>alert(1)</script>ok`}</Markdown>,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
  });
});

describe("MarkdownTitle", () => {
  it("renders ticket-name emphasis and inline code", () => {
    const { container } = render(
      <MarkdownTitle>{"Drop `web_chat_button_title` from **Chat.Configuration**"}</MarkdownTitle>,
    );

    expect(container.querySelector("code")?.textContent).toBe("web_chat_button_title");
    expect(container.querySelector("strong")?.textContent).toBe("Chat.Configuration");
  });

  it("cannot introduce block or interactive elements inside clickable cards", () => {
    const { container } = render(
      <MarkdownTitle>{"[link](https://example.com)\n- first\n- second"}</MarkdownTitle>,
    );

    expect(container.querySelector("a, ul, li")).toBeNull();
    expect(container.textContent).toContain("link");
    expect(container.textContent).toContain("first");
  });
});

describe("MarkdownDocument", () => {
  const DIAGRAM = "```mermaid\ngraph TD; A-->B;\n```";

  it("renders a mermaid fence as a diagram", () => {
    const { getByTestId } = render(<MarkdownDocument>{DIAGRAM}</MarkdownDocument>);
    expect(getByTestId("mermaid").textContent).toContain("graph TD; A-->B;");
  });

  /** The boundary this split exists for. A comment body is written by anyone
   *  with access to the repo or the Linear workspace, and a diagram engine is a
   *  much larger surface than a `<pre>`. A file in your own worktree is
   *  something you opened on purpose; a PR comment is not. */
  it("does not let a comment body reach the diagram renderer", () => {
    const { container, queryByTestId } = render(<Markdown>{DIAGRAM}</Markdown>);
    expect(queryByTestId("mermaid")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("graph TD");
  });

  it("highlights a fenced code block by its info string", () => {
    const { container } = render(<MarkdownDocument>{"```ts\nconst x = 1;\n```"}</MarkdownDocument>);
    expect(container.querySelector("pre .token.keyword")?.textContent).toBe("const");
  });

  /** A README is hard-wrapped prose. `remarkBreaks` — which the comment renderer
   *  needs, because a newline in a comment box was meant as one — would put a
   *  `<br>` inside every paragraph of it. */
  it("does not break hard-wrapped paragraphs, where a comment body would", () => {
    const wrapped = "One line of prose\ncontinued on the next.";
    expect(
      render(<MarkdownDocument>{wrapped}</MarkdownDocument>).container.querySelector("br"),
    ).toBeNull();
    expect(render(<Markdown>{wrapped}</Markdown>).container.querySelector("br")).not.toBeNull();
  });
});
