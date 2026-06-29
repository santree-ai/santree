/**
 * Opening a PR link from a pill anywhere in the app: if the PR is in the Reviews
 * dashboard for the active repo's org, navigate to the Reviews tab and select it;
 * otherwise fall back to opening it on GitHub. Keeps PR review in-app when we
 * already have the data, without a network round-trip to check.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback } from "react";

import type { ReviewInbox } from "../bindings";
import { useApp, useAppUi } from "../state/AppContext";
import { queryKeys } from "./queries";

export function useOpenPr() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { activeRepo } = useApp();
  const { requestReviewFocus } = useAppUi();

  return useCallback(
    (url: string) => {
      const inbox = qc.getQueryData<ReviewInbox>(queryKeys.reviews(activeRepo));
      const inApp =
        !!inbox &&
        [...inbox.mine, ...inbox.requested, ...inbox.teams.flatMap((t) => t.prs)].some(
          (p) => p.url === url,
        );
      if (inApp) {
        requestReviewFocus(url);
        void navigate({ to: "/reviews" });
      } else {
        void openUrl(url);
      }
    },
    [qc, navigate, activeRepo, requestReviewFocus],
  );
}
