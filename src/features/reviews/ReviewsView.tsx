/** The Reviews tab: open pull requests from agent worktrees. */
import { ViewChrome } from "../../components/chrome/ViewChrome";
import { branchFor } from "../../lib/format";
import { useWorktrees } from "../../lib/queries";
import { agentSlug } from "../../theme/colors";

export function ReviewsView() {
  return (
    <ViewChrome>
      <ReviewsList />
    </ViewChrome>
  );
}

/** The PR list itself — split out so it can be tested without the window chrome. */
export function ReviewsList() {
  const { data: worktrees = [] } = useWorktrees();
  const reviews = worktrees.filter((w) => w.pr);

  return (
    <div className="flex-1 overflow-y-auto bg-app py-6">
      <div className="mx-auto max-w-[760px] px-6">
        <div className="mb-[18px] flex items-center gap-2.5">
          <span className="text-[15px] font-semibold text-fg-2">Open pull requests</span>
          <span className="font-mono text-[11px] text-muted-4">from agent worktrees</span>
        </div>

        {reviews.map((w) => {
          const passing = w.pr?.checks === "Passing";
          return (
            <div
              key={w.id}
              className="mb-3.5 overflow-hidden rounded-xl border border-line-2 bg-raised"
            >
              <div className="flex gap-3.5 px-[17px] py-[15px]">
                <div className="min-w-0 flex-1">
                  <div className="mb-[7px] flex items-center gap-2.5">
                    <span className="font-mono text-[11px]" style={{ color: "var(--accent)" }}>
                      PR #{w.pr?.number}
                    </span>
                    <span className="font-mono text-[10.5px] text-muted-2">{w.id}</span>
                    <span
                      className={`flex items-center gap-1.5 font-mono text-[10px] ${
                        passing ? "text-status-green" : "text-status-amber"
                      }`}
                    >
                      <span>{passing ? "✓" : "◴"}</span>
                      {passing ? "checks passing" : "checks running"}
                    </span>
                  </div>
                  <div className="mb-[9px] text-[14px] leading-[1.35] font-medium text-fg-bright">
                    {w.title}
                  </div>
                  <div className="flex items-center gap-3 font-mono text-[11px] text-muted-3">
                    <span className="text-[color:var(--color-branch)]">⎇ {branchFor(w.id)}</span>
                    <span>
                      <span className="text-status-green">+{w.addLines}</span>{" "}
                      <span className="text-status-red">−{w.delLines}</span>
                    </span>
                    <span>by {agentSlug(w.agent)}</span>
                  </div>
                </div>
                <div className="flex flex-none flex-col justify-center gap-[7px]">
                  <button
                    type="button"
                    className="cursor-pointer rounded-md border border-line-3 bg-raised-2 px-3.5 py-[7px] text-[12px] text-fg-2 hover:border-line-strong"
                  >
                    View diff
                  </button>
                  <button
                    type="button"
                    className="cursor-pointer rounded-md border-none px-3.5 py-[7px] text-[12px] font-medium text-[color:var(--on-accent)] hover:brightness-110"
                    style={{ background: "var(--accent)" }}
                  >
                    Approve & merge
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
