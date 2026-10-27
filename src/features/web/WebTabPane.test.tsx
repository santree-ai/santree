/** A Web tab's pane over its page's state: the page itself is native, so what
 *  the pane draws is the toolbar and whatever stands in for the page. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BrowserState, WorktreeTab } from "../../bindings";

vi.mock("../../bindings", () => ({
  commands: { browserState: vi.fn(), browserFocus: vi.fn(), browserNav: vi.fn() },
  events: {},
}));
vi.mock("../../lib/queries", () => ({ useBrowserSupported: () => ({ data: true }) }));
vi.mock("./useBrowserPage", () => ({
  useBrowserPage: () => ({ still: null, stillShown: () => {} }),
}));

import { pageLabel, setPageState } from "./pageState";
import { WebTabPane } from "./WebTabPane";

const tab: WorktreeTab = {
  id: "t1",
  worktreeId: "w1",
  kind: "web",
  agentKind: null,
  title: "New tab",
  pr: null,
  account: null,
  url: null,
};

describe("WebTabPane", () => {
  /** The bug: with a Google search open, typing `localhost:3000` (nothing
   *  running there) said the search had failed — WebKit names the page before a
   *  failed load as the page's URL again — and Try again reloaded the search. */
  it("names the address that failed, not the page before it", () => {
    const state: BrowserState = {
      id: tab.id,
      url: "https://www.google.com/search?q=rust",
      title: "rust - Google Search",
      loading: false,
      progress: 1,
      canGoBack: true,
      canGoForward: false,
      failure: {
        url: "http://localhost:3000/",
        reason: "NotRunning",
        message: "Could not connect to the server.",
      },
      crashed: false,
    };
    setPageState(state);
    render(<WebTabPane tab={tab} focused={false} />);

    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("http://localhost:3000/");
    expect(screen.getByText("Nothing is running at localhost:3000")).toBeVisible();
    expect(pageLabel(tab.id, tab.title, tab.url)).toBe("localhost:3000");
  });
});
