/**
 * The merge-queue panel's three empty answers. They are different facts — GitHub
 * was never asked, this repo has no queue, the queue is empty — and each is about
 * one `owner/name`, which the panel has to say. Unnamed, "This repository doesn't
 * have a merge queue" sat beside an org-wide inbox listing another repo's PRs.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { MergeQueueView } from "../../bindings";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("./model", () => ({ useReviewsModel: () => ({ repo: "santree" }) }));

const state = vi.hoisted(() => ({ data: undefined as MergeQueueView | undefined }));
vi.mock("../../lib/queries", () => ({
  useMergeQueue: () => ({ data: state.data, isLoading: false, isError: false }),
}));

import { MergeQueuePane } from "./MergeQueuePane";

function show(data: MergeQueueView) {
  state.data = data;
  render(<MergeQueuePane />);
}

describe("MergeQueuePane", () => {
  it("names the repository that has no merge queue", () => {
    show({ repo: "acme/web", githubConnected: true, queue: null });
    expect(screen.getByText(/^acme\/web doesn't have a merge queue/)).toBeInTheDocument();
  });

  it("names the repository whose queue is empty", () => {
    show({
      repo: "acme/web",
      githubConnected: true,
      queue: { repo: "acme/web", branch: "main", entries: [] },
    });
    expect(screen.getByText(/waiting to merge into acme\/web/)).toBeInTheDocument();
  });

  it("reports a disconnected GitHub rather than an absent queue", () => {
    show({ repo: "acme/web", githubConnected: false, queue: null });
    expect(screen.queryByText("No merge queue")).not.toBeInTheDocument();
    expect(screen.getByText("GitHub isn't connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/settings", search: { section: "github" } });
  });
});
