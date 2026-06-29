/**
 * Material Icon Theme glue: maps a file/folder name to its icon SVG, the same
 * way VS Code's "Material Icon Theme" does. `generateManifest()` gives us the
 * name → icon-definition mapping; the icon SVGs ship in the package and are
 * pulled in as Vite asset URLs (only the ones actually rendered get fetched).
 */
import { generateManifest } from "material-icon-theme";

// Built once for the whole app — the manifest is a few hundred KB of plain JSON.
const manifest = generateManifest();

// Every icon SVG as an emitted asset URL, keyed by absolute path. Eager so the
// lookup is synchronous; the SVG bytes themselves load lazily when an <img> uses
// the URL, so the 1250-icon set doesn't bloat the initial bundle.
const SVGS = import.meta.glob("/node_modules/material-icon-theme/icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** Resolve an icon-definition key (e.g. "nodejs") to its emitted SVG URL. */
function urlForIcon(iconKey: string | undefined): string | undefined {
  if (!iconKey) return undefined;
  const def = manifest.iconDefinitions?.[iconKey];
  // iconPath looks like "./../icons/nodejs.svg" → take the basename.
  const file = def?.iconPath?.split("/").pop();
  return file ? SVGS[`/node_modules/material-icon-theme/icons/${file}`] : undefined;
}

/** The icon URL for a file, by exact name then by (longest) extension. */
export function fileIconUrl(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  const byName = manifest.fileNames?.[lower];
  if (byName) return urlForIcon(byName);

  // Try progressively shorter compound extensions: "app.config.yaml" → try
  // "config.yaml" then "yaml", so "*.test.ts" etc. resolve to their special icon.
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const byExt = manifest.fileExtensions?.[ext] ?? manifest.languageIds?.[ext];
    if (byExt) return urlForIcon(byExt);
  }
  return urlForIcon(manifest.file);
}

/** The icon URL for a folder, by name, in its open or closed state. */
export function folderIconUrl(folderName: string, expanded: boolean): string | undefined {
  const lower = folderName.toLowerCase();
  const named = expanded ? manifest.folderNamesExpanded : manifest.folderNames;
  const byName = named?.[lower];
  if (byName) return urlForIcon(byName);
  return urlForIcon(expanded ? manifest.folderExpanded : manifest.folder);
}
