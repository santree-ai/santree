import { useEffect, useRef, useState } from "react";

/** The mono line under the CTAs. The server renders the first phrase
 * verbatim (SEO, no-JS, reduced motion all see it); after a beat, a caret
 * deletes and retypes through the rotation. An invisible sizer spanning the
 * longest phrase locks the layout so nothing shifts while typing. */

const PHRASES = [
  "macOS · open source · bring your own Claude",
  "triage → branch → steer → review → ship",
  "5 worktrees · 5 agents · 1 repo",
] as const;

const FIRST = PHRASES[0];
const LONGEST = [...PHRASES].sort((a, b) => b.length - a.length)[0] ?? FIRST;

const START_DELAY = 3500;
const HOLD = 3800;
const TYPE_MS = 42;
const DELETE_MS = 16;

export function StatusLine({ className = "" }: { className?: string }) {
  const [text, setText] = useState<string>(FIRST);
  const [typing, setTyping] = useState(false);
  const phrase = useRef(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer = 0;
    let current = FIRST as string;
    const schedule = (fn: () => void, ms: number) => {
      timer = window.setTimeout(fn, ms);
    };

    const deleteStep = () => {
      if (current.length === 0) {
        phrase.current = (phrase.current + 1) % PHRASES.length;
        typeStep();
        return;
      }
      current = current.slice(0, -1);
      setText(current);
      schedule(deleteStep, DELETE_MS);
    };

    const typeStep = () => {
      const target = PHRASES[phrase.current] ?? FIRST;
      if (current.length === target.length) {
        setTyping(false);
        schedule(deleteStep, HOLD);
        return;
      }
      current = target.slice(0, current.length + 1);
      setText(current);
      setTyping(true);
      schedule(typeStep, TYPE_MS);
    };

    schedule(deleteStep, START_DELAY);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <p
      className={`relative inline-block text-left font-mono text-[11px] tracking-wide text-[#8f9099] ${className}`}
    >
      {/* Sizer: reserves the widest phrase's box — including the caret's
          advance, or the visible caret wraps to its own line when the
          longest phrase is fully typed. */}
      <span className="invisible" aria-hidden>
        {LONGEST}
        <span className="type-caret" />
      </span>
      <span className="absolute inset-0" aria-live="off">
        {text}
        <span className={`type-caret ${typing ? "type-caret-solid" : ""}`} aria-hidden />
      </span>
    </p>
  );
}
