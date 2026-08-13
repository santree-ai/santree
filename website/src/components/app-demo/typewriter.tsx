import type { TermEvent } from "./data";
import { useTick } from "./ticker";

/** Scripted terminal replay. The reveal is a pure function of the shared
 * ticker's quantum count — freeze the ticker and the text freezes mid-word;
 * resume and it continues. Preseeded lines (the t=0 frame) render fully in
 * the server HTML; only `live` events type in. */

const DEFAULT_PRE = 4; // beat before a line starts, in char-ticks

interface Scheduled {
  event: Extract<TermEvent, { text: string }>;
  start: number;
  end: number;
}

export function scheduleEvents(events: readonly TermEvent[]): Scheduled[] {
  const out: Scheduled[] = [];
  let t = 0;
  for (const event of events) {
    if (event.kind === "pause") {
      t += event.ticks;
      continue;
    }
    t += event.pre ?? DEFAULT_PRE;
    const start = t;
    t += event.text.length;
    out.push({ event, start, end: t });
  }
  return out;
}

export function TermLine({
  event,
  text,
}: {
  event: Extract<TermEvent, { text: string }>;
  text?: string;
}) {
  const shown = text ?? event.text;
  switch (event.kind) {
    case "prompt":
      return (
        <div className="flex gap-1.5 text-fg/90">
          <span className="text-muted-4">&gt;</span>
          <span>{shown}</span>
        </div>
      );
    case "tool":
      return (
        <div className="flex gap-1.5">
          <span className="text-term-cyan">⏺</span>
          <span className="text-muted">{shown}</span>
        </div>
      );
    case "todo":
      return (
        <div className="flex gap-1.5">
          <span className="text-status-green">✓</span>
          <span className="text-muted">{shown}</span>
        </div>
      );
    case "diffstat":
      return <div className="text-muted-2">{shown}</div>;
    default:
      return <div className="text-fg/75">{shown}</div>;
  }
}

export function Typewriter({
  live,
  tickMs = 35,
  active = true,
}: {
  live: readonly TermEvent[];
  tickMs?: number;
  active?: boolean;
}) {
  const tick = useTick(tickMs, active);
  const schedule = scheduleEvents(live);

  return (
    <>
      {schedule.map((s) =>
        tick <= s.start ? null : (
          <TermLine
            key={s.start}
            event={s.event}
            text={tick >= s.end ? s.event.text : s.event.text.slice(0, tick - s.start)}
          />
        ),
      )}
      <span className="demo-caret" aria-hidden />
    </>
  );
}
