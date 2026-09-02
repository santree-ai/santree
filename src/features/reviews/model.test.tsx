/**
 * Which pane the Reviews view is showing is **route** state, not view state.
 *
 * Both ways in come from outside this provider — the sidebar's PR rows and its
 * merge-queue row — and neither can set a `useState` living inside it. A queue
 * held here opened nothing on a reload and left the rail's row pointing at a
 * pane the url had never heard of, which is the same bug `?pr=` was moved to the
 * route to fix.
 *
 * The two are one pane in two states, so each writer clears the other. These
 * tests drive the provider through a probe rather than a view: what is under
 * test is the search the model reads and the search it writes.
 */
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewInbox, ReviewPr } from "../../bindings";

/** The route's search params, as the provider reads them. */
const route = vi.hoisted(() => ({
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => route.search,
  useNavigate: () => route.navigate,
}));

const reviews = vi.hoisted(() => ({ inbox: undefined as unknown }));
vi.mock("../../lib/queries", () => ({
  useReviews: () => ({ data: reviews.inbox, isLoading: false }),
  usePrTickets: () => ({ data: [] }),
}));
vi.mock("../../state/AppContext", () => ({
  useApp: () => ({ activeRepo: "acme/app" }),
  useAppUi: () => ({ reviewFocus: null, consumeReviewFocus: vi.fn() }),
}));

import { ReviewsProvider, useReviewsModel } from "./model";

const pr = {
  id: "PR_1",
  url: "https://github.com/acme/app/pull/7",
  project: "acme/app",
  title: "Fix the thing",
  headRef: "feature/fix-the-thing",
} as ReviewPr;

const inbox = {
  mine: [],
  requested: [pr],
  teams: [],
  projects: [{ repo: "acme/app", slug: "acme/app" }],
  githubConnected: true,
} as unknown as ReviewInbox;

/** The model, captured from inside the provider. */
let model: ReturnType<typeof useReviewsModel>;
function Probe() {
  model = useReviewsModel();
  return null;
}

function mount() {
  render(
    <ReviewsProvider>
      <Probe />
    </ReviewsProvider>,
  );
}

/** The search a `navigate` call would produce, applied to the params it was
 *  called from — the model writes a reducer, not a literal. */
function searchAfter(prev: Record<string, unknown>) {
  const call = route.navigate.mock.calls.at(-1)?.[0] as {
    search: (p: Record<string, unknown>) => Record<string, unknown>;
  };
  return call.search(prev);
}

beforeEach(() => {
  route.search = { project: "acme/app" };
  route.navigate.mockClear();
  reviews.inbox = inbox;
});

describe("ReviewsProvider's pane selection", () => {
  it("shows the merge queue when the route says so, so a reload lands back on it", () => {
    route.search = { project: "acme/app", queue: true };
    mount();
    expect(model.showMergeQueue).toBe(true);
  });

  it("shows no merge queue without it, which is every url that never asked", () => {
    mount();
    expect(model.showMergeQueue).toBe(false);
  });

  it("clears the selected PR when the queue is opened", () => {
    mount();
    model.openMergeQueue();
    expect(searchAfter({ project: "acme/app", pr: pr.url })).toEqual({
      project: "acme/app",
      pr: undefined,
      queue: true,
    });
  });

  it("clears the queue when a PR is selected", () => {
    mount();
    model.setActive(pr.id);
    expect(searchAfter({ project: "acme/app", queue: true })).toEqual({
      project: "acme/app",
      pr: pr.url,
      queue: undefined,
    });
  });

  /** The selection still comes off the route, and the scope still narrows the
   *  inbox — the queue rides beside them, not over them. */
  it("keeps resolving the route's PR while the queue param is absent", () => {
    route.search = { project: "acme/app", pr: pr.url };
    mount();
    expect(model.active?.id).toBe(pr.id);
    expect(model.showMergeQueue).toBe(false);
  });
});
