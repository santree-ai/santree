/**
 * The icon for a repository. For an `owner/name` repo we pull the owner's
 * avatar from GitHub (`https://github.com/<owner>.png`, no auth needed); if the
 * repo has no owner or the avatar fails to load, we fall back to the GitHub
 * logomark. Remote images are allowed by the app's (null) CSP.
 */
import { useState } from "react";

import { GitHubLogo } from "../icons";

/** Owner of an `owner/name` repo, or null if the name has no owner segment. */
const ownerOf = (repo: string): string | null => (repo.includes("/") ? repo.split("/")[0] : null);

// One fixed request resolution for every instance (displayed at 16–18px, so 64
// is crisp on retina). Keeping the URL independent of the display size means all
// instances — and the preloader below — share a single browser cache entry per
// owner, so an avatar that's been fetched once never reloads elsewhere.
const avatarUrl = (owner: string): string => `https://github.com/${owner}.png?size=64`;

/** Warm the browser image cache for these repos' owner avatars, so they're
 *  already resolved by the time a `RepoAvatar` (e.g. inside a dropdown that
 *  hasn't opened yet) actually mounts. Dedupes across calls. */
const preloaded = new Set<string>();
export function preloadRepoAvatars(repos: { name: string }[]): void {
  for (const { name } of repos) {
    const owner = ownerOf(name);
    if (!owner || preloaded.has(owner)) continue;
    preloaded.add(owner);
    const img = new Image();
    img.src = avatarUrl(owner);
  }
}

export function RepoAvatar({ repo, size = 17 }: { repo: string; size?: number }) {
  const owner = ownerOf(repo);
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
          src={avatarUrl(owner)}
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
