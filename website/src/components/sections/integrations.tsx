import { ClaudeLogo, CodexLogo, GitHubLogo, LinearLogo } from "~/components/icons";
import { FadeUpGroup, FadeUpItem } from "~/components/motion/fade-up";
import { SectionHeading } from "~/components/ui/section-heading";
import { SpotlightCard } from "~/components/ui/spotlight-card";

const INTEGRATIONS = [
  {
    name: "Linear",
    line: "Tickets in. Triage, planning structure and cycles, straight from your workspace.",
    color: "#5e6ad2",
    Icon: LinearLogo,
  },
  {
    name: "GitHub",
    line: "PRs out. Checks, reviews, the merge queue, without a browser tab.",
    color: "#f2f2f4",
    Icon: GitHubLogo,
  },
  {
    name: "Codex",
    line: "A first-class agent, using your existing Codex login. Pick it per workflow.",
    color: "#f2f2f4",
    Icon: CodexLogo,
  },
  {
    name: "Claude Code",
    line: "A first-class agent, using your existing Claude subscription. Mix them freely.",
    color: "#d97757",
    Icon: ClaudeLogo,
  },
];

export function Integrations() {
  return (
    <section className="py-32">
      <div className="mx-auto max-w-5xl px-6">
        <SectionHeading kicker="Integrations" title="The tools you already use" />
        <FadeUpGroup className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {INTEGRATIONS.map((it) => (
            <FadeUpItem key={it.name}>
              <SpotlightCard className="card group flex h-full flex-col items-center px-6 py-9 text-center">
                <span
                  className="text-muted-2 transition-colors duration-300 group-hover:text-[var(--it-color)]"
                  style={{ "--it-color": it.color } as React.CSSProperties}
                >
                  <it.Icon size={26} />
                </span>
                <span className="mt-4 text-[15px] font-medium">{it.name}</span>
                <p className="mt-2 max-w-[16rem] text-[13px] leading-relaxed text-muted">
                  {it.line}
                </p>
              </SpotlightCard>
            </FadeUpItem>
          ))}
        </FadeUpGroup>
      </div>
    </section>
  );
}
