/** The Download CTA — a direct link to the latest stable DMG.
 *
 * The URL is deliberately version-free. GitHub's `releases/latest/download/<name>`
 * redirect resolves to the newest NON-pre-release, which is exactly the stable
 * channel, but it matches on an exact asset name — so the release workflow
 * uploads a copy under this fixed name alongside the versioned one. That keeps
 * the site fully static: no GitHub API call at runtime, nothing to rebuild when
 * a release ships, and no version here that can go stale.
 */
import { AppleLogo } from "~/components/icons";

const DOWNLOAD_URL =
  "https://github.com/santree-ai/santree/releases/latest/download/santree-macos.dmg";

export function DownloadButton({ size = "lg" }: { size?: "lg" | "sm" }) {
  return (
    <a
      href={DOWNLOAD_URL}
      className={`btn btn-primary ${size === "lg" ? "h-11 px-5" : "h-9 px-4 text-[13px]"}`}
    >
      {/* Nudged up: the Apple glyph's visual center sits below its box's. */}
      <AppleLogo size={size === "lg" ? 15 : 13} className="-mt-px" />
      {size === "lg" ? "Download for macOS" : "Download"}
    </a>
  );
}
