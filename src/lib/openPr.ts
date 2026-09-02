/**
 * Opening a PR link from a pill anywhere in the app: if the PR is in the Reviews
 * dashboard (which spans every registered project), navigate to the Reviews tab
 * and select it; otherwise fall back to opening it on GitHub. Keeps PR review
 * in-app when we already have the data, without a network round-trip to check.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback } from "react";

import type { ReviewInbox } from "../bindings";
import { useAppUi } from "../state/AppContext";
import { queryKeys } from "./queries";

export function useOpenPr() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { requestReviewFocus } = useAppUi();

  return useCallback(
    (url: string) => {
      const inbox = qc.getQueryData<ReviewInbox>(queryKeys.reviews());
      const match =
        inbox &&
        [...inbox.mine, ...inbox.requested, ...inbox.teams.flatMap((t) => t.prs)].find(
          (p) => p.url === url,
        );
      if (match) {
        requestReviewFocus(url);
        // Scoped to the PR's own project: the view narrows to one project, so a
        // link that didn't say which would open an inbox the PR isn't in. The PR
        // rides in the route too, so the sidebar lights up its row on arrival
        // rather than a frame later, once the view has resolved the focus.
        void navigate({
          to: "/reviews",
          search: { project: match.project ?? undefined, pr: url },
        });
      } else {
        void openUrl(url);
      }
    },
    [qc, navigate, requestReviewFocus],
  );
}
