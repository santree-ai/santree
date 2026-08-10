import { MockView } from "~/components/ui/mock-views";

/** The screenshot slot: a 16:10 frame with quiet fake macOS chrome. Until a
 * real screenshot exists it renders a designed low-fi mock of that view
 * (mock-views.tsx); dropping the real thing in later is a single `src`
 * prop. */
export function ScreenshotFrame({ view, src, alt }: { view: string; src?: string; alt?: string }) {
  return (
    <figure className="card overflow-hidden rounded-2xl shadow-[0_40px_100px_-30px_rgba(0,0,0,0.9),0_0_140px_-60px_rgba(45,212,167,0.35)]">
      {/* Title bar: desaturated traffic lights + mono window title. */}
      <div className="relative flex h-10 items-center border-b border-hairline bg-white/[0.015] px-4">
        <span className="flex gap-[7px]" aria-hidden>
          <span className="size-[11px] rounded-full bg-white/10" />
          <span className="size-[11px] rounded-full bg-white/10" />
          <span className="size-[11px] rounded-full bg-white/10" />
        </span>
        <figcaption className="absolute inset-x-0 text-center font-mono text-[11px] text-muted-4">
          santree — {view}
        </figcaption>
      </div>
      <div className="relative aspect-[16/10] bg-panel">
        {src ? (
          <img
            src={src}
            alt={alt ?? `The ${view} view in santree`}
            className="size-full object-cover"
          />
        ) : (
          <>
            <MockView view={view} />
            <span className="absolute bottom-3 right-4 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-4">
              preview
            </span>
          </>
        )}
      </div>
    </figure>
  );
}
