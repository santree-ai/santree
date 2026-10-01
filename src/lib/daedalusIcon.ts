/**
 * A Daedalus project's app icon, as the box serves it (docs/remote.md,
 * `workspaces.icon`). The bytes are the box's: they are drawn only as an
 * image — an `<img>` with a `data:` URL, where an SVG's scripts never run —
 * and never inlined into the document. The backend has checked them already;
 * the type and size are checked again here, at the one place that turns them
 * into something the webview loads.
 */
import type { DaedalusIcon, Repo } from "../bindings";

/** Every type `workspaces.icon` answers, and so every type drawn. */
export const ICON_TYPES: readonly string[] = [
  "image/png",
  "image/svg+xml",
  "image/x-icon",
  "image/webp",
];

/** The largest icon drawn, decoded. */
export const ICON_MAX_BYTES = 64 * 1024;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The box's workspace a registered repo is — the last component of its path
 *  on the server — or `null` for a repo on this machine. */
export function workspaceOf(repo: Pick<Repo, "location" | "path"> | undefined): string | null {
  if (repo?.location !== "Daedalus" || !repo.path) return null;
  const name = repo.path.replace(/\/+$/, "").split("/").pop();
  return name ? name : null;
}

/** A `data:` URL for `icon`, or `null` when it isn't one of the four types,
 *  isn't standard padded base64, or decodes to nothing or past the cap. */
export function iconSrc(icon: DaedalusIcon | null | undefined): string | null {
  if (!icon || !ICON_TYPES.includes(icon.contentType)) return null;
  const { data } = icon;
  if (data.length === 0 || !BASE64.test(data)) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const bytes = (data.length / 4) * 3 - padding;
  if (bytes > ICON_MAX_BYTES) return null;
  return `data:${icon.contentType};base64,${data}`;
}
