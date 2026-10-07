import { FadeUp } from "~/components/motion/fade-up";

/** What santree touches, as a ruled list: a term, then the fact. Each line
 * is checked against the app (COMPLIANCE.md is the source for the agent
 * credential rules, `claude_usage.rs` the one documented read). */

const FACTS = [
  {
    term: "your code",
    body: "Worktrees, terminals and diffs live on your disk. There is no santree account and no santree server.",
  },
  {
    term: "agent logins",
    body: "santree never stores or proxies an agent's login. The one read is Claude Code's own token, sent only to api.anthropic.com to fill the usage meter.",
  },
  {
    term: "tokens",
    body: "Linear and Jira tokens sit in the OS keychain. GitHub access is borrowed from the gh CLI you're already signed into.",
  },
  {
    term: "publishing",
    body: "An AI review's draft comments stay on your machine until you publish them. Nothing an agent writes reaches GitHub without your click.",
  },
  {
    term: "network",
    body: "The integrations you connect, your agent CLI, and an update check against GitHub releases.",
  },
];

export function Trust() {
  return (
    <section id="trust" className="scroll-mt-20 border-y border-hairline bg-panel/60 py-28">
      <div className="mx-auto grid max-w-6xl grid-cols-[minmax(0,1fr)] gap-12 px-6 lg:grid-cols-[5fr_7fr] lg:gap-20">
        <FadeUp>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">
            Local-first
          </p>
          <h2 className="mt-4 text-balance text-[clamp(2rem,1.4rem+2.4vw,2.75rem)] font-semibold leading-[1.08] tracking-[-0.02em]">
            Your repo never leaves your machine.
          </h2>
        </FadeUp>
        <FadeUp delay={0.06}>
          <dl>
            {FACTS.map((f) => (
              <div
                key={f.term}
                className="grid gap-1 border-t border-hairline py-5 first:border-t-0 first:pt-0 sm:grid-cols-[9rem_1fr] sm:gap-6"
              >
                <dt className="pt-[3px] font-mono text-[11px] uppercase tracking-[0.14em] text-muted-2">
                  {f.term}
                </dt>
                <dd className="text-pretty text-[15px] leading-relaxed text-[#c9cad2]">{f.body}</dd>
              </div>
            ))}
          </dl>
        </FadeUp>
      </div>
    </section>
  );
}
