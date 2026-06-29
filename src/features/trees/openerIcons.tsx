/** App icons for the "Open in…" menu — the real macOS app marks, downscaled to
 *  48px PNGs (see ./opener-icons). Square logos (Cursor, Zed) get a rounded mask
 *  so every icon reads uniformly alongside the already-rounded ones. */

import cursorIcon from "./opener-icons/cursor.png";
import finderIcon from "./opener-icons/finder.png";
import ghosttyIcon from "./opener-icons/ghostty.png";
import terminalIcon from "./opener-icons/terminal.png";
import vscodeIcon from "./opener-icons/vscode.png";
import xcodeIcon from "./opener-icons/xcode.png";
import zedIcon from "./opener-icons/zed.png";

const VB = "0 0 16 16";

const ICONS: Record<string, string> = {
  finder: finderIcon,
  vscode: vscodeIcon,
  cursor: cursorIcon,
  zed: zedIcon,
  xcode: xcodeIcon,
  ghostty: ghosttyIcon,
  terminal: terminalIcon,
};

export function OpenerIcon({ openerKey, size = 16 }: { openerKey: string; size?: number }) {
  const src = ICONS[openerKey];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        aria-hidden
        // Square source logos carry no corner radius of their own; round them so
        // they match the macOS-shaped icons in the same menu.
        style={{ borderRadius: size * 0.22 }}
        draggable={false}
      />
    );
  }
  if (openerKey === "copyPath") {
    return (
      <svg
        width={size}
        height={size}
        viewBox={VB}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.4" />
        <path d="M3 9.5V4A1.5 1.5 0 0 1 4.5 2.5H10" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox={VB} aria-hidden>
      <rect width="16" height="16" rx="3.6" fill="#3a3a3f" />
    </svg>
  );
}
