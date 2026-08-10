import { Reveal } from "~/components/reveal";

/** Standard section header: a quiet mono kicker, a tight headline, an
 * optional one-line sub. Centered by default. */
export function SectionHeading({
  kicker,
  title,
  sub,
  align = "center",
}: {
  kicker: string;
  title: string;
  sub?: string;
  align?: "center" | "left";
}) {
  const alignCls = align === "center" ? "mx-auto text-center" : "text-left";
  return (
    <Reveal className={`max-w-2xl ${alignCls}`}>
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-2">{kicker}</p>
      <h2 className="mt-4 text-balance text-4xl font-semibold tracking-[-0.02em] sm:text-[2.75rem] sm:leading-[1.1]">
        {title}
      </h2>
      {sub ? (
        <p className="mt-5 text-pretty text-[15px] leading-relaxed text-muted">{sub}</p>
      ) : null}
    </Reveal>
  );
}
