/**
 * What find has to get right: it searches what the pane *drew*, across the token
 * boundaries highlighting introduces, and it belongs to the pane on screen.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { FindBar, findRanges, useFindInView } from "./FindInView";

/** A pane wired the way `FileViewer` wires one. */
function Harness({ enabled = true, children }: { enabled?: boolean; children: React.ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const find = useFindInView(root, enabled);
  return (
    <div ref={root}>
      <FindBar find={find} />
      {children}
    </div>
  );
}

const openFind = () => fireEvent.keyDown(window, { key: "f", metaKey: true });
const field = () => screen.getByLabelText("Find in file");
const type = (query: string) => fireEvent.change(field(), { target: { value: query } });
/** The counter, which is the only thing that says what was found. */
const position = () => screen.getByLabelText("Find in file").parentElement?.textContent ?? "";

describe("useFindInView", () => {
  it("opens on ⌘F and counts every rendered match", () => {
    render(
      <Harness>
        <pre>alpha beta alpha gamma alpha</pre>
      </Harness>,
    );
    expect(screen.queryByLabelText("Find in file")).toBeNull();

    openFind();
    type("alpha");
    expect(position()).toContain("1/3");
  });

  /** Highlighted code is one text node per token, so a per-node search would
   *  fail on anything with a space in it — which is most of what gets typed. */
  it("matches across the token boundaries highlighting introduces", () => {
    render(
      <Harness>
        <pre>
          <span>const</span>
          <span> foo </span>
          <span>=</span>
          <span> 1</span>
        </pre>
      </Harness>,
    );
    openFind();
    type("foo = 1");
    expect(position()).toContain("1/1");
  });

  it("is case-insensitive", () => {
    render(
      <Harness>
        <pre>Worktree worktree WORKTREE</pre>
      </Harness>,
    );
    openFind();
    type("WorkTree");
    expect(position()).toContain("1/3");
  });

  it("steps with Enter and wraps at the end", () => {
    render(
      <Harness>
        <pre>one two one two one</pre>
      </Harness>,
    );
    openFind();
    type("one");
    expect(position()).toContain("1/3");

    fireEvent.keyDown(field(), { key: "Enter" });
    expect(position()).toContain("2/3");
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(position()).toContain("1/3");

    // Shift steps back, and wraps the other way.
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    expect(position()).toContain("3/3");
  });

  /** A query with no hits has nothing to show but the number, so the number has
   *  to be there — silence would read as "still searching". */
  it("says 0/0 when nothing matches", () => {
    render(
      <Harness>
        <pre>alpha beta</pre>
      </Harness>,
    );
    openFind();
    type("gamma");
    expect(position()).toContain("0/0");
  });

  it("closes on Escape", () => {
    render(
      <Harness>
        <pre>alpha</pre>
      </Harness>,
    );
    openFind();
    expect(screen.queryByLabelText("Find in file")).not.toBeNull();
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByLabelText("Find in file")).toBeNull();
  });

  /** The file view stays mounted behind whichever tab is showing. ⌘F belongs to
   *  what you are looking at, so a hidden pane must not answer it. */
  it("ignores ⌘F while its pane is not the one showing", () => {
    render(
      <Harness enabled={false}>
        <pre>alpha</pre>
      </Harness>,
    );
    openFind();
    expect(screen.queryByLabelText("Find in file")).toBeNull();
  });

  it("closes itself when the pane it belongs to goes away", () => {
    const { rerender } = render(
      <Harness>
        <pre>alpha</pre>
      </Harness>,
    );
    openFind();
    expect(screen.queryByLabelText("Find in file")).not.toBeNull();

    rerender(
      <Harness enabled={false}>
        <pre>alpha</pre>
      </Harness>,
    );
    expect(screen.queryByLabelText("Find in file")).toBeNull();
  });

  /** The bar is rendered inside the searched element; finding its own input's
   *  text would count matches that aren't in the file. */
  it("does not search itself", () => {
    render(
      <Harness>
        <pre>nothing here</pre>
      </Harness>,
    );
    openFind();
    type("Find");
    expect(position()).toContain("0/0");
  });
});

describe("findRanges", () => {
  function root(html: string): HTMLElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    document.body.append(el);
    return el;
  }

  it("returns one live range per occurrence, in document order", () => {
    const el = root("<p>red green red</p>");
    const { ranges, capped } = findRanges(el, "red");
    expect(ranges).toHaveLength(2);
    expect(capped).toBe(false);
    expect(ranges[0].toString()).toBe("red");
    expect(ranges[0].startOffset).toBe(0);
    expect(ranges[1].startOffset).toBe(10);
  });

  it("finds nothing for an empty query", () => {
    expect(findRanges(root("<p>anything</p>"), "").ranges).toHaveLength(0);
  });
});
