/**
 * A committed file rendered as the **pull request's** version of it: GitHub's own
 * patch, with the review threads and AI drafts anchored inline, and the gutter `+`
 * that writes new ones.
 *
 * Why GitHub's patch rather than the branch-vs-base diff santree can compute
 * locally: a comment's line numbers are GitHub's, and overlaying them on a
 * separately-computed diff is exactly how a comment ends up pinned to the wrong
 * line. Anchoring against the patch the comments were written against makes that
 * impossible by construction. The cost is that the patch describes the *pushed*
 * head — which is what {@link PrSyncNotice} exists to say out loud.
 */
import { useMemo } from "react";

import type { PrFile, ReviewPr } from "../../bindings";
import {
  TREES_DIFF_MODE_KEY,
  usePrDetail,
  usePrFileSource,
  useResolvedSetting,
  useReviewDrafts,
} from "../../lib/queries";
import { splitRepoSlug } from "../../lib/repo";
import type { CommentTarget } from "../reviews/commentTarget";
import { PrFileBody } from "../reviews/PrFileBody";
import { useTrees } from "./model";

export function PrFileDiffPane({ pr, file, path }: { pr: ReviewPr; file: PrFile; path: string }) {
  const { repo } = useTrees();
  const [owner, name] = splitRepoSlug(pr.repo);
  const { data: detail } = usePrDetail(owner, name, pr.number);
  const { data: drafts = [] } = useReviewDrafts(pr.repo, pr.number);
  const { data: diffModeSetting } = useResolvedSetting(repo, TREES_DIFF_MODE_KEY);
  const mode = diffModeSetting === "unified" ? "unified" : "split";

  const headSha = detail?.headSha ?? "";
  const baseSha = detail?.baseSha ?? "";
  const pendingReviewId = detail?.pendingReviewId ?? null;

  // Built from primitives, not from `pr`: `usePrSummary` polls, so a target keyed
  // on that object's identity would re-lay-out the whole diff on every refetch.
  const target: CommentTarget = useMemo(
    () => ({
      prRepo: pr.repo,
      number: pr.number,
      prId: pr.id,
      headSha,
      pendingReviewId,
    }),
    [pr.repo, pr.number, pr.id, headSha, pendingReviewId],
  );

  const { data: source } = usePrFileSource(
    owner,
    name,
    baseSha,
    headSha,
    file.previousPath ?? file.path,
    file.path,
    !!file.patch,
  );

  const fileDrafts = drafts.filter((d) => d.path === path);
  const fileThreads = (detail?.threads ?? []).filter((t) => t.path === path);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PrFileBody
        file={file}
        threads={fileThreads}
        drafts={fileDrafts}
        target={target}
        oldText={source?.oldText}
        newText={source?.newText}
        mode={mode}
        // Your own PR: a comment written here is either something to say on
        // GitHub or something to fix — never a review batched at yourself.
        draftMode="queue"
      />
    </div>
  );
}
