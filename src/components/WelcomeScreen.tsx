/**
 * First-run screen, shown while no repository is registered. Every routed view
 * would just be an empty shell at that point, so the root route swaps them all
 * for this single "open a repository" action; adding the first repo flips the
 * shell back to the normal chrome. Reuses the RepoSelector's add flow (native
 * folder picker → git validation in Rust → santree-CLI adoption probe).
 */
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";

import { useAddRepo } from "../lib/queries";
import { useLegacyMigration } from "../state/LegacyMigration";
import { Button, Spinner } from "./primitives";

export function WelcomeScreen() {
  const { offer } = useLegacyMigration();
  const addRepo = useAddRepo();
  const [error, setError] = useState<string | null>(null);

  async function pickRepo() {
    setError(null);
    const picked = await open({ directory: true, title: "Open a git repository" });
    if (typeof picked !== "string") return;
    try {
      const repo = await addRepo.mutateAsync(picked);
      // Nothing to "switch to": the registry gaining its first project is what
      // swaps this screen for the shell, and the shell opens on the welcome
      // surface with the new project's section already in the rail.
      await offer(repo.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      {/* Stand-in for the top bar (the overlay traffic lights render over it). */}
      <div data-tauri-drag-region className="h-[46px] flex-none" />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-[46px]">
        <div className="font-mono text-[26px] font-semibold tracking-tight text-fg-bright">
          santree
        </div>
        <p className="mt-2 max-w-[360px] text-center text-[12.5px] leading-relaxed text-muted-2">
          Manage AI coding agents across your repository&rsquo;s tickets. Open a repository to get
          started.
        </p>
        <Button
          variant="primary"
          onClick={pickRepo}
          disabled={addRepo.isPending}
          className="mt-6 gap-2"
        >
          {/* The Spinner defaults to `--accent`, which IS this button's fill —
              pass the on-fill colour or it renders invisible. */}
          {addRepo.isPending && <Spinner size={12} color="var(--on-accent)" />}
          {addRepo.isPending ? "Validating…" : "Open a repository…"}
        </Button>
        <p className="mt-3 text-[11px] text-muted-4">Choose any folder inside a git checkout.</p>
        {error && (
          <p className="mt-3 max-w-[380px] text-center text-[11px] leading-snug text-status-red">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
