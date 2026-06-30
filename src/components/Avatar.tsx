/**
 * A small round avatar: shows the image when one is available (Linear avatars
 * are public), falling back to deterministic colored initials otherwise.
 * Reusable for comment authors, issue authors, and assignees.
 */
import { useState } from "react";

import { AVATAR_PALETTE } from "../theme/colors";

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

export function Avatar({
  name,
  src,
  size = 22,
}: {
  name: string;
  src?: string | null;
  size?: number;
}) {
  // Track the failed src so a re-used instance with a new src retries.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImg = !!src && src !== failedSrc;

  return (
    <span
      className="flex flex-none items-center justify-center overflow-hidden rounded-full font-medium text-white"
      style={{
        width: size,
        height: size,
        background: showImg ? "transparent" : colorFor(name),
        fontSize: Math.round(size * 0.42),
      }}
    >
      {showImg ? (
        <img
          src={src as string}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setFailedSrc(src as string)}
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}
