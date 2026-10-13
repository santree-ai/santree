/**
 * Registering a repository, lifted out of the old repo switcher.
 *
 * Adding a project is four steps that have to stay together: pick a folder,
 * validate it as a git repo in Rust, adopt any santree-CLI config it already
 * carries, and — only when several trackers are connected — ask which one it
 * uses. The question is deferred rather than asked up front because the CLI
 * config usually answers it, and with a single connection the backend already
 * links the repo to it.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useState } from "react";

import { useAddRepo, useConnections, useSetRepoConnection } from "../../lib/queries";
import type { Connection } from "../../lib/tracker";
import { useLegacyMigration } from "../../state/LegacyMigration";

export interface AddProjectFlow {
  /** Open the folder picker and register what the user chooses. */
  addProject: () => Promise<void>;
  /** A just-added repo still waiting to be told which tracker it uses, else `null`. */
  pendingRepo: string | null;
  /** Connected trackers, for the pending repo's prompt. */
  connections: Connection[];
  chooseConnection: (connection: string) => Promise<void>;
  dismissPending: () => void;
  isPending: boolean;
  error: string | null;
}

export function useAddProject(): AddProjectFlow {
  const connections = useConnections();
  const addRepo = useAddRepo();
  const setConnection = useSetRepoConnection();
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
      // A lone connection was taken when the repo was added; with several, which
      // one is the user's to say.
      if (!handledByCli && !repo.connection && connections.length > 1) setPendingRepo(repo.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [addRepo, offerCliMigration, connections.length]);

  const chooseConnection = useCallback(
    async (connection: string) => {
      if (pendingRepo) await setConnection.mutateAsync({ repo: pendingRepo, connection });
      setPendingRepo(null);
    },
    [pendingRepo, setConnection],
  );

  return {
    addProject,
    pendingRepo,
    connections,
    chooseConnection,
    dismissPending: useCallback(() => setPendingRepo(null), []),
    isPending: addRepo.isPending,
    error,
  };
}
