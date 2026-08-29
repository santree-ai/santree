import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  selectedFile: "README.md" as string | null,
  selectedFileScope: "working" as "working" | "branch",
  status: [] as { path: string }[],
  text: "# Title\n\nBody text.",
}));

vi.mock("../../lib/queries", () => ({
  useWorktreeStatus: () => ({ data: spies.status }),
  useWorktreeFileSource: () => ({ data: { newText: spies.text }, isLoading: false }),
}));

vi.mock("./model", () => ({
  useTrees: () => ({
    repo: "acme/api",
    activeId: "AK-1",
    selectedFile: spies.selectedFile,
    selectedFileScope: spies.selectedFileScope,
  }),
}));

// The diff host pulls in the PR/GitHub stack; this file is about which pane the
// toggle picks, not what a diff looks like.
vi.mock("./DiffPane", () => ({ DiffPane: () => <div data-testid="diff" /> }));
vi.mock("../../components/MermaidDiagram", () => ({ MermaidDiagram: () => <div /> }));

import { FileViewer, isMarkdownPath } from "./FileViewer";

describe("isMarkdownPath", () => {
  it("recognizes markdown by extension, case-insensitively", () => {
    expect(isMarkdownPath("README.md")).toBe(true);
    expect(isMarkdownPath("docs/Terminals.MARKDOWN")).toBe(true);
  });

  it("does not claim files that merely contain 'md'", () => {
    expect(isMarkdownPath("src/cmd.ts")).toBe(false);
    expect(isMarkdownPath("md")).toBe(false);
    expect(isMarkdownPath("Makefile")).toBe(false);
  });

  /** `.mdx` is JSX in markdown clothing: rendering only the markdown half would
   *  silently drop the components that carry the content, which is worse than
   *  showing the source. */
  it("leaves .mdx to the source view", () => {
    expect(isMarkdownPath("page.mdx")).toBe(false);
  });
});

describe("FileViewer", () => {
  function setup(over: Partial<typeof spies> = {}) {
    Object.assign(spies, {
      selectedFile: "README.md",
      selectedFileScope: "working",
      status: [],
      text: "# Title\n\nBody text.",
      ...over,
    });
    return render(<FileViewer />);
  }

  it("previews an unchanged markdown file, and offers the source", () => {
    const { container } = setup();
    expect(container.querySelector("h1")?.textContent).toBe("Title");

    fireEvent.click(screen.getByRole("radio", { name: "Code" }));
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).toContain("# Title");
  });

  /** A changed file was clicked to see what changed, so the diff leads — but the
   *  preview is still one click away, which is the point of the toggle. */
  it("leads with the diff for a changed markdown file", () => {
    const { container } = setup({ status: [{ path: "README.md" }] });
    expect(screen.getByTestId("diff")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Diff" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
    expect(container.querySelector("h1")?.textContent).toBe("Title");
  });

  it("shows no toggle for a file that isn't markdown", () => {
    setup({ selectedFile: "src/main.rs", text: "fn main() {}" });
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("refuses to dump a binary file, whichever pane is showing", () => {
    // A NUL is how the backend's lossy UTF-8 decode announces a binary file.
    setup({ text: "binary\u0000payload" });
    expect(screen.getByText("Binary file")).toBeTruthy();
  });
});
