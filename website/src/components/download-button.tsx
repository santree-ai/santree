import { useEffect, useId, useRef, useState } from "react";
import { WipPill } from "~/components/wip-pill";

/** The Download CTA. santree is pre-release, so instead of a dead disabled
 * button this stays enabled and opens a small disclosure explaining how to
 * get the first build. Escape closes it and focus returns to the button. */
export function DownloadButton({ size = "lg" }: { size?: "lg" | "sm" }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (
        !popoverRef.current?.contains(e.target as Node) &&
        !buttonRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className={`btn btn-primary ${size === "lg" ? "h-11 px-5" : "h-9 px-4 text-[13px]"}`}
      >
        {size === "lg" ? "Download for macOS & Linux" : "Download"}
        <WipPill className="border-black/15 bg-black/5 text-black/50" />
      </button>
      {open ? (
        <div
          ref={popoverRef}
          id={id}
          role="dialog"
          aria-label="Download status"
          className="card absolute left-1/2 top-full z-20 mt-3 w-72 -translate-x-1/2 bg-panel p-4 text-left shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)]"
        >
          <p className="text-sm text-fg">santree is pre-release — there is no public build yet.</p>
          <p className="mt-2 text-[13px] leading-relaxed text-muted">
            Watch the repository to hear about the first release the moment it lands.
          </p>
          <a
            href="https://github.com/santree-ai/santree"
            className="btn btn-ghost mt-3 h-8 px-3 text-[13px]"
          >
            Watch on GitHub →
          </a>
        </div>
      ) : null}
    </div>
  );
}
