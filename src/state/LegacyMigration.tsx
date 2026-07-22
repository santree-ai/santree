/**
 * Cross-view offer to adopt santree-CLI configuration when a repo is opened.
 *
 * `offer(repo)` probes a just-added repo for legacy `.santree` config: a
 * workspace that's already connected is linked quietly; an importable CLI
 * credential raises a confirm dialog. The dialog renders here — above the
 * welcome/normal-shell switch in the root route — so it survives the shell
 * re-rendering when the first repo appears. `offer` resolves `true` when the
 * CLI config decided the repo's workspace; callers then skip their own
 * workspace prompt.
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import type { LegacyCliMigration } from "../bindings";
import { ConfirmDialog } from "../components/primitives";
import { probeLegacyCli, useLegacyCliMigrate, useSetRepoLinearOrg } from "../lib/queries";
import { toast } from "./toast";

interface LegacyMigrationApi {
  /** Probe `repo` for santree-CLI config and adopt/offer it. Never throws. */
  offer: (repo: string) => Promise<boolean>;
}

const LegacyMigrationContext = createContext<LegacyMigrationApi | null>(null);

/** No-op fallback so hot-rebuilds (and tests) without the provider stay inert. */
const INERT: LegacyMigrationApi = { offer: async () => false };

export function useLegacyMigration(): LegacyMigrationApi {
  return useContext(LegacyMigrationContext) ?? INERT;
}

export function LegacyMigrationProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ repo: string; info: LegacyCliMigration } | null>(null);
  const migrate = useLegacyCliMigrate();
  const setRepoOrg = useSetRepoLinearOrg();

  const offer = useCallback(
    async (repo: string): Promise<boolean> => {
      let info: LegacyCliMigration | null;
      try {
        info = await probeLegacyCli(repo);
      } catch {
        return false; // best-effort: a probe failure must never block adding a repo
      }
      if (!info) return false;
      if (info.alreadyConnected) {
        // The workspace is connected already — adopt the CLI's repo link, but
        // say so: metadata.json ships with the repo, so a silently-applied
        // choice would let a cloned repo pick its workspace unnoticed. A
        // failure still red-toasts via the global mutation handler.
        await setRepoOrg
          .mutateAsync({ repo, slug: info.orgSlug })
          .then(() => {
            toast.success(`Linked to “${info.orgName}”, from the repo's santree CLI config.`, {
              title: "Linear workspace",
            });
          })
          .catch(() => {});
        return true;
      }
      setPending({ repo, info });
      return true;
    },
    [setRepoOrg],
  );

  const api = useMemo(() => ({ offer }), [offer]);

  return (
    <LegacyMigrationContext.Provider value={api}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title="Import santree CLI settings?"
        message={
          pending && (
            <>
              <span className="font-mono text-fg">{pending.repo}</span> was set up with the santree
              CLI. Import its Linear workspace{" "}
              <span className="font-medium text-fg">{pending.info.orgName}</span>? The sign-in moves
              into the OS keychain; the repo's setup script and worktrees keep working as-is.
            </>
          )
        }
        confirmLabel="Import"
        busyLabel="Importing…"
        onConfirm={async () => {
          if (pending) await migrate.mutateAsync(pending.repo);
        }}
        onClose={() => setPending(null)}
      />
    </LegacyMigrationContext.Provider>
  );
}
