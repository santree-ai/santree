/** The journal's scroll area: it follows the conversation while the reader is
 *  at the bottom, stays put once they scroll up, and offers the way back.
 *
 *  Following is done by watching the content's size rather than the data, so a
 *  reply whose markdown lays out a frame later, or a card the reader opens at
 *  the bottom, keeps the latest line in view too. The observer fires after
 *  layout and before paint, so nothing is ever drawn scrolled the wrong way. */
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";

import { ChevronDownIcon } from "../../components/icons";

/** How close to the end still counts as "at the bottom". */
const SLACK_PX = 48;

export function Scroller({
  children,
  className,
}: {
  /** Handed `keepPlace`, to call just before content is added above what the
   *  reader is looking at (earlier turns), so the page doesn't jump. */
  children: (keepPlace: () => void) => ReactNode;
  /** The column inside the scroll area. */
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const place = useRef<{ height: number; top: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const settle = () => {
      const kept = place.current;
      if (kept) {
        place.current = null;
        el.scrollTop = kept.top + (el.scrollHeight - kept.height);
      } else if (following.current) {
        el.scrollTop = el.scrollHeight;
      }
    };
    settle();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(settle);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK_PX;
    following.current = bottom;
    setAtBottom(bottom);
  };

  const keepPlace = useCallback(() => {
    const el = scroller.current;
    if (el) place.current = { height: el.scrollHeight, top: el.scrollTop };
  }, []);

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    following.current = true;
    setAtBottom(true);
    // Instant, not smooth: a smooth scroll reports itself short of the bottom
    // on every frame, and a reply landing meanwhile would stop being followed.
    el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="absolute inset-0 overflow-y-auto">
        <div ref={content} className={className}>
          {children(keepPlace)}
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-line-2 bg-popover px-3 py-1 text-sm font-medium text-fg-2 shadow-[0_6px_20px_-8px_rgba(0,0,0,.6)] hover:border-line-strong"
        >
          <ChevronDownIcon size={11} />
          Jump to latest
        </button>
      )}
    </div>
  );
}
