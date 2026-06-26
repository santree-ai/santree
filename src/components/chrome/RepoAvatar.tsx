/**
 * The icon for a repository. For an `owner/name` repo we pull the owner's
 * avatar from GitHub (`https://github.com/<owner>.png`, no auth needed); if the
 * repo has no owner or the avatar fails to load, we fall back to the GitHub
 * logomark. Remote images are allowed by the app's (null) CSP.
 */
import { useState } from "react";

import { GitHubLogo } from "../icons";

export function RepoAvatar({ repo, size = 17 }: { repo: string; size?: number }) {
  const owner = repo.includes("/") ? repo.split("/")[0] : null;
  // Track which owner's avatar failed, so changing repos retries without an
  // effect (and an owner that already failed keeps its fallback).
  const [failedOwner, setFailedOwner] = useState<string | null>(null);

  return (
    <span
      className="flex flex-none items-center justify-center overflow-hidden rounded border border-line-strong bg-input-alt text-fg-2"
      style={{ width: size, height: size }}
    >
      {owner && owner !== failedOwner ? (
        <img
          src={`https://github.com/${owner}.png?size=${size * 2}`}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-cover"
          onError={() => setFailedOwner(owner)}
        />
      ) : (
        <GitHubLogo size={Math.round(size * 0.62)} />
      )}
    </span>
  );
}
