/** Deterministic avatars for the fixture world: an initials disc as an inline
 *  SVG data URI, so nothing is fetched and every capture looks the same. The
 *  app's own `Avatar` falls back to initials on a null src, but several PR
 *  shapes require a string, so everyone gets a real image here. */

const PALETTE = ["#5E6AD2", "#0EA5A4", "#D97706", "#DB2777", "#7C3AED", "#2563EB", "#059669"];

function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function avatarFor(name: string): string {
  const fill = PALETTE[hash(name) % PALETTE.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="32" fill="${fill}"/>` +
    `<text x="32" y="32" dy=".36em" text-anchor="middle" font-family="-apple-system,Inter,Helvetica,sans-serif" ` +
    `font-size="26" font-weight="600" fill="#fff">${initials(name)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
