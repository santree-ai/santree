/** Repository switcher shown in the sidebar header cell. */
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";

import { useAddRepo, useLinearOrgs, useRepos, useSetRepoLinearOrg } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { alpha } from "../../theme/colors";
import { ChevronDownIcon } from "../icons";
import { Dropdown, Spinner } from "../primitives";
import { RepoAvatar } from "./RepoAvatar";

export function RepoSelector() {
  const { activeRepo, setActiveRepo, accent } = useApp();
  const { data: repos = [] } = useRepos();
  const { data: orgs = [] } = useLinearOrgs();
  const addRepo = useAddRepo();
  const setRepoOrg = useSetRepoLinearOrg();
  const [menuOpen, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A freshly-added repo awaiting a Linear workspace choice (only when >1 org).
  const [pendingRepo, setPendingRepo] = useState<string | null>(null);
  const current = repos.find((r) => r.name === activeRepo);

  // Controlled so the trigger can tint its border while open, and so closing
  // (via outside click, Escape, or picking a repo) always resets the
  // in-progress pick/error state together.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setPendingRepo(null);
      setError(null);
    }
  }

  // Pick a folder, validate it as a git repo in Rust, then select it.
  async function pickRepo(close: () => void) {
    setError(null);
    const picked = await open({ directory: true, title: "Add a git repository" });
    if (typeof picked !== "string") return;
    try {
      const repo = await addRepo.mutateAsync(picked);
      setActiveRepo(repo.name);
      // With multiple Linear workspaces connected, ask which one this repo uses;
      // with one (the common case) the backend already defaults to it.
      if (orgs.length > 1) setPendingRepo(repo.name);
      else close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function chooseOrg(slug: string, close: () => void) {
    if (pendingRepo) await setRepoOrg.mutateAsync({ repo: pendingRepo, slug });
    close();
  }

  return (
    // flex-1 + min-w-0: this sits in a flex row (ViewChrome's sidebar header).
    // flex-1 makes the trigger span the full bar width (not just its content);
    // min-w-0 lets it shrink so a long repo name elides instead of overflowing.
    <div className="min-w-0 flex-1">
      <Dropdown
        open={menuOpen}
        onOpenChange={handleOpenChange}
        menuClassName="w-[288px] overflow-hidden p-1.5"
        trigger={(toggle) => (
          <button
            type="button"
            onClick={toggle}
            className="flex w-full min-w-0 cursor-pointer items-center gap-[7px] rounded-md border bg-input-alt px-[9px] py-[5px] transition-colors hover:border-line-strong"
            style={{ borderColor: menuOpen ? accent : "var(--color-line-3)" }}
          >
            <RepoAvatar repo={activeRepo} />
            <span className="min-w-0 truncate font-mono text-[12px] font-medium text-fg">
              {activeRepo}
            </span>
            {!!current?.agents && (
              <span className="flex-none font-mono text-[9.5px]" style={{ color: accent }}>
                ● {current.agents}
              </span>
            )}
            <ChevronDownIcon size={12} className="flex-none text-muted-3" />
          </button>
        )}
      >
        {(close) =>
          pendingRepo ? (
            <>
              <div className="px-[9px] pt-1.5 pb-[5px] font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
                Linear workspace
              </div>
              <div className="px-[9px] pb-2 text-[11.5px] leading-snug text-muted-2">
                Which workspace does <span className="font-mono text-fg-2">{pendingRepo}</span> use?
              </div>
              {orgs.map((o) => (
                <button
                  type="button"
                  key={o.slug}
                  onClick={() => chooseOrg(o.slug, close)}
                  disabled={setRepoOrg.isPending}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-[9px] py-2 text-left hover:bg-hover-2 disabled:opacity-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-fg">{o.name}</div>
                    <div className="mt-px truncate font-mono text-[10px] text-muted-3">
                      {o.slug}
                    </div>
                  </div>
                  {setRepoOrg.isPending && <Spinner size={11} />}
                </button>
              ))}
              <button
                type="button"
                onClick={close}
                className="mt-1 w-full cursor-pointer border-t border-line px-[9px] pt-[9px] pb-[5px] text-left text-[11.5px] text-muted-3 hover:text-muted"
              >
                Decide later
              </button>
            </>
          ) : (
            <>
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
                      close();
                    }}
                    className="flex w-full cursor-pointer items-center gap-[9px] rounded-md px-[9px] py-2 text-left hover:bg-hover-2"
                    style={active ? { background: alpha(12, accent) } : undefined}
                  >
                    <RepoAvatar repo={r.name} size={18} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[12px] text-fg">{r.name}</div>
                      <div className="mt-px truncate text-[10px] text-muted-3">{r.tracker}</div>
                    </div>
                    {!!r.agents && (
                      <span className="flex-none font-mono text-[9.5px]" style={{ color: accent }}>
                        ● {r.agents}
                      </span>
                    )}
                    {active && (
                      <span className="flex-none text-[12px]" style={{ color: accent }}>
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => pickRepo(close)}
                disabled={addRepo.isPending}
                className="mt-1 flex w-full cursor-pointer items-center gap-[7px] border-t border-line px-[9px] pt-[9px] pb-[5px] text-left text-[11.5px] text-muted-2 hover:text-fg-2 disabled:cursor-default"
              >
                {addRepo.isPending ? (
                  <Spinner size={11} />
                ) : (
                  <span style={{ color: accent }}>+</span>
                )}
                {addRepo.isPending ? "Validating…" : "Add repository…"}
              </button>
              {error && (
                <div className="px-[9px] pt-1.5 pb-1 text-[10.5px] leading-snug text-status-red">
                  {error}
                </div>
              )}
            </>
          )
        }
      </Dropdown>
    </div>
  );
}
