/**
 * The icon for a repository. A Daedalus project draws its app icon, as the box
 * serves it (`src/lib/daedalusIcon.ts`) — as an `<img>`, never inlined markup.
 * Otherwise, or when the box has none, an `owner/name` repo draws the owner's
 * avatar from GitHub (`https://github.com/<owner>.png`, no auth needed); if the
 * repo has no owner or the avatar fails to load, we fall back to the GitHub
 * logomark. Remote images are allowed by the app's (null) CSP.
 */
import { useState } from "react";

import { iconSrc, workspaceOf } from "../../lib/daedalusIcon";
import { useDaedalusIcon, useRepos } from "../../lib/queries";
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

export function RepoAvatar({
  repo,
  size = 17,
  bordered = true,
}: {
  repo: string;
  size?: number;
  /** Off where the mark sits in a list of text rows (the project tree): a ruled
   *  tile beside plain labels reads as a control, not an identity. */
  bordered?: boolean;
}) {
  const owner = ownerOf(repo);
  const { data: repos } = useRepos();
  const workspace = workspaceOf(repos?.find((r) => r.name === repo));
  const icon = useDaedalusIcon(workspace);
  const appIcon = iconSrc(icon.data);
  // The same per-source failure memory as the owner's avatar: an icon that
  // won't decode falls back, and a new one is tried.
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  // Until the first answer, nothing: drawing the GitHub mark and then swapping
  // in the app icon is the flash this avoids. The answer is usually the
  // backend's cache (memory, then disk); only a workspace never seen waits on
  // the box. Later re-reads keep the drawn icon until they answer.
  const waiting = workspace !== null && icon.status === "pending";
  // Track which owner's avatar failed, so changing repos retries without an
  // effect (and an owner that already failed keeps its fallback).
  const [failedOwner, setFailedOwner] = useState<string | null>(null);

  return (
    <span
      className={`flex flex-none items-center justify-center overflow-hidden rounded bg-input-alt text-fg-2 ${
        bordered ? "border border-line-strong" : ""
      }`}
      style={{ width: size, height: size }}
    >
      {waiting ? null : appIcon && appIcon !== failedIcon ? (
        <img
          src={appIcon}
          alt=""
          width={size}
          height={size}
          draggable={false}
          className="h-full w-full object-contain"
          onError={() => setFailedIcon(appIcon)}
        />
      ) : owner && owner !== failedOwner ? (
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
