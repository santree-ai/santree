import { ClaudeLogo, GitHubLogo, LinearLogo } from "~/components/icons";
import { Reveal } from "~/components/reveal";
import { SectionHeading } from "~/components/ui/section-heading";
import { SpotlightCard } from "~/components/ui/spotlight-card";

const INTEGRATIONS = [
  {
    name: "Linear",
    line: "Tickets in. Triage straight from your team's queue.",
    color: "#5e6ad2",
    Icon: LinearLogo,
  },
  {
    name: "GitHub",
    line: "PRs out. Checks, reviews, and merges without a browser tab.",
    color: "#f2f2f4",
    Icon: GitHubLogo,
  },
  {
    name: "Claude",
    line: "The hands on the keyboard. Bring your own subscription.",
    color: "#d97757",
    Icon: ClaudeLogo,
  },
];

export function Integrations() {
  return (
    <section className="py-32">
      <div className="mx-auto max-w-5xl px-6">
        <SectionHeading kicker="Integrations" title="Plays the tools you already play." />
        <div className="mt-14 grid gap-3 sm:grid-cols-3">
          {INTEGRATIONS.map((it, i) => (
            <Reveal key={it.name} delay={i * 0.06}>
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
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
