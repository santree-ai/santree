/**
 * Registering a repository, lifted out of the old repo switcher.
 *
 * Adding a project is four steps that have to stay together: pick a folder,
 * validate it as a git repo in Rust, adopt any santree-CLI config it already
 * carries, and — only when several Linear workspaces are connected — ask which
 * one it belongs to. The workspace question is deferred rather than asked up
 * front because the CLI config usually answers it, and with a single connected
 * workspace the backend already defaults correctly.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";

import type { LinearOrg } from "../../bindings";
import { useAddRepo, useLinearOrgs, useSetRepoLinearOrg } from "../../lib/queries";
import { useLegacyMigration } from "../../state/LegacyMigration";

export interface AddProjectFlow {
  /** Open the folder picker and register what the user chooses. */
  addProject: () => Promise<void>;
  /** A just-added repo still waiting for its Linear workspace, else `null`. */
  pendingRepo: string | null;
  /** Connected Linear workspaces, for the pending repo's prompt. */
  orgs: LinearOrg[];
  chooseOrg: (slug: string) => Promise<void>;
  dismissPending: () => void;
  isPending: boolean;
  error: string | null;
}

export function useAddProject(): AddProjectFlow {
  const { data: orgs = [] } = useLinearOrgs();
  const addRepo = useAddRepo();
  const setRepoOrg = useSetRepoLinearOrg();
  const { offer: offerCliMigration } = useLegacyMigration();
  const [pendingRepo, setPendingRepo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const addProject = useCallback(async () => {
    setError(null);
    const picked = await open({ directory: true, title: "Add a git repository" });
    if (typeof picked !== "string") return;
    try {
      const repo = await addRepo.mutateAsync(picked);
      const handledByCli = await offerCliMigration(repo.name);
      if (!handledByCli && orgs.length > 1) setPendingRepo(repo.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [addRepo, offerCliMigration, orgs.length]);

  const chooseOrg = useCallback(
    async (slug: string) => {
      if (pendingRepo) await setRepoOrg.mutateAsync({ repo: pendingRepo, slug });
      setPendingRepo(null);
    },
    [pendingRepo, setRepoOrg],
  );

  return {
    addProject,
    pendingRepo,
    orgs,
    chooseOrg,
    dismissPending: useCallback(() => setPendingRepo(null), []),
    isPending: addRepo.isPending,
    error,
  };
}
