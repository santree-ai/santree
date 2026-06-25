/** Repository switcher shown in the sidebar header cell. */
import { useState } from "react";

import { useRepos } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { GitHubLogo } from "../icons";

function GhBadge({ size = 17 }: { size?: number }) {
  return (
    <span
      className="flex items-center justify-center rounded border border-line-strong bg-input-alt text-fg-2"
      style={{ width: size, height: size }}
    >
      <GitHubLogo size={Math.round(size * 0.62)} />
    </span>
  );
}

export function RepoSelector() {
  const { activeRepo, setActiveRepo, accent } = useApp();
  const { data: repos = [] } = useRepos();
  const [open, setOpen] = useState(false);
  const current = repos.find((r) => r.name === activeRepo);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex cursor-pointer items-center gap-[7px] rounded-md border bg-input-alt px-[9px] py-[5px] transition-colors hover:border-line-strong"
        style={{ borderColor: open ? accent : "#2a2a31" }}
      >
        <GhBadge />
        <span className="max-w-[150px] truncate font-mono text-[12px] font-medium text-fg">
          {activeRepo}
        </span>
        {!!current?.agents && (
          <span className="font-mono text-[9.5px]" style={{ color: accent }}>
            ● {current.agents}
          </span>
        )}
        <span className="text-[9px] text-muted-3">▾</span>
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-[55] cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute top-9 left-0 z-[60] w-[288px] rounded-[10px] border border-line-3 bg-titlebar p-1.5 shadow-[0_18px_46px_-16px_rgba(0,0,0,.85)]">
            <div className="px-[9px] pt-1.5 pb-[5px] font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
              Repositories
            </div>
            {repos.map((r) => {
              const active = r.name === activeRepo;
              return (
                <button
                  type="button"
                  key={r.name}
                  onClick={() => {
                    setActiveRepo(r.name);
                    setOpen(false);
                  }}
                  className="flex w-full cursor-pointer items-center gap-[9px] rounded-md px-[9px] py-2 text-left hover:bg-[#1b1c20]"
                  style={
                    active
                      ? { background: `color-mix(in srgb, ${accent} 12%, transparent)` }
                      : undefined
                  }
                >
                  <GhBadge size={18} />
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[12px] text-fg">{r.name}</div>
                    <div className="mt-px text-[10px] text-muted-3">{r.tracker}</div>
                  </div>
                  {!!r.agents && (
                    <span className="font-mono text-[9.5px]" style={{ color: accent }}>
                      ● {r.agents}
                    </span>
                  )}
                  {active && (
                    <span className="text-[12px]" style={{ color: accent }}>
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
            <div className="mt-1 flex cursor-pointer items-center gap-[7px] border-t border-line px-[9px] pt-[9px] pb-[5px] text-[11.5px] text-muted-2 hover:text-fg-2">
              <span style={{ color: accent }}>+</span> Add repository…
            </div>
          </div>
        </>
      )}
    </div>
  );
}
