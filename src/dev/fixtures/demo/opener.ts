/**
 * `@tauri-apps/plugin-opener`, with the demo world's links made inert.
 *
 * The app opens some URLs straight through the plugin rather than a command
 * (the PR dialog, menus, check links), so the typed `commands` override can't
 * catch them, and a click would open a browser on a Parcelwise org that does
 * not exist. Vite aliases the package here in demo mode only (`vite.config.ts`).
 */
import { openUrl as realOpenUrl } from "../../../../node_modules/@tauri-apps/plugin-opener/dist-js/index.js";

export * from "../../../../node_modules/@tauri-apps/plugin-opener/dist-js/index.js";

const DEMO_ORG_HOSTS = new Set(["github.com", "linear.app"]);

/** Parsed, never prefix-matched: `github.com.evil.com/parcelwise/` is not ours. */
function isDemoUrl(url: string | URL): boolean {
  try {
    const u = new URL(url);
    return DEMO_ORG_HOSTS.has(u.hostname) && u.pathname.startsWith("/parcelwise/");
  } catch {
    return false;
  }
}

export async function openUrl(
  url: string | URL,
  openWith?: "inAppBrowser" | string,
): Promise<void> {
  if (isDemoUrl(url)) {
    console.info("[santree] demo: not opening", String(url));
    return;
  }
  return realOpenUrl(url, openWith);
}
