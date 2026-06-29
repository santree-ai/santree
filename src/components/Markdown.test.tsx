import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

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
