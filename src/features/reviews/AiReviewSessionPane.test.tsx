/**
 * The launch gate. Everything else in this feature rests on the AI review session
 * starting with its deny list, its tools, and its prompt — so the case worth
 * pinning is the one where resolving those *fails*: no terminal spawns.
 *
 * The failure mode this guards is quiet. An errored query still reports
 * `isFetched`, and every launch flag falls back to `undefined`, so a gate written
 * the obvious way spawns `claude 'Review pull request #7'` with no guardrails at
 * all — a session told to review a PR, with the user's `gh` auth in reach.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewPr } from "../../bindings";

const spies = vi.hoisted(() => ({ terminal: vi.fn() }));
const q = vi.hoisted(() => ({
  launch: { data: undefined, isSuccess: false, isError: false, isFetched: false } as {
    data: unknown;
    isSuccess: boolean;
    isError: boolean;
    isFetched: boolean;
    error?: Error;
  },
}));

vi.mock("./ReviewTerminal", () => ({
  ReviewTerminal: (props: { seed?: string }) => {
    spies.terminal(props.seed);
    return <div data-testid="terminal" />;
  },
}));
vi.mock("./model", () => ({ useReviewsModel: () => ({ repo: "acme/app" }) }));
vi.mock("./useReviewSessionLatch", () => ({
  useReviewSessionLatch: () => ({
    liveSession: false,
    ended: false,
    needsSeed: true,
    resumeRequested: false,
    requestResume: vi.fn(),
  }),
}));
vi.mock("./AiReviewPane", () => ({
  ReviewFooter: () => <div />,
  reviewTargetFor: () => ({ prRepo: "acme/app", number: 7, headSha: "abc123" }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ removeQueries: vi.fn() }) }));
vi.mock("../../lib/queries", () => ({
  CLAUDE_START_WITH_CHROME_KEY: "chrome",
  REVIEW_EFFORT_KEY: "effort",
  REVIEW_MODEL_KEY: "model",
  queryKeys: { agentSessionPrefix: () => ["s"] },
  useAgentSession: () => ({
    data: { type: "fresh", sessionId: "sess-1" },
    isFetching: false,
  }),
  useAiReviewLaunch: () => q.launch,
  useBoolSetting: () => ({ value: false, isFetched: true }),
  useResolvedSetting: () => ({ data: "opus", isFetched: true }),
  useReviewDrafts: () => ({ data: [] }),
  useReviewWorkspace: () => ({ data: "/tmp/checkout", isFetched: true, isFetching: false }),
}));

import { AiReviewSessionPane } from "./AiReviewSessionPane";

const pr = { id: "p1", number: 7, repo: "acme/app", headSha: "abc123" } as ReviewPr;

beforeEach(() => {
  spies.terminal.mockClear();
});

describe("AiReviewSessionPane", () => {
  it("spawns nothing when the launch fails, and says why", () => {
    q.launch = {
      data: undefined,
      isSuccess: false,
      isError: true,
      isFetched: true,
      error: new Error("GitHub is unreachable"),
    };
    render(<AiReviewSessionPane pr={pr} visible onShowDrafts={vi.fn()} />);
    expect(spies.terminal).not.toHaveBeenCalled();
    expect(screen.getByText("Couldn't start the AI review")).toBeInTheDocument();
    expect(screen.getByText("GitHub is unreachable")).toBeInTheDocument();
  });

  it("launches with the deny list and the review tools once they resolve", () => {
    q.launch = {
      data: {
        promptPath: "/data/prompts/acme-app-7.ai-review.md",
        settingsPath: "/data/claude-hooks-ai-review.json",
        mcpConfigPath: "/data/mcp/acme-app-7.mcp.json",
      },
      isSuccess: true,
      isError: false,
      isFetched: true,
    };
    render(<AiReviewSessionPane pr={pr} visible onShowDrafts={vi.fn()} />);
    const seed = spies.terminal.mock.calls[0][0] as string;
    expect(seed).toContain("--settings '/data/claude-hooks-ai-review.json'");
    expect(seed).toContain("--mcp-config '/data/mcp/acme-app-7.mcp.json'");
    // The user's own MCP servers stay: a review that can't read the ticket is a
    // worse review, and read-only is the prompt's job, not a hard limit.
    expect(seed).not.toContain("--strict-mcp-config");
    expect(seed).toContain("/data/prompts/acme-app-7.ai-review.md");
  });
});
