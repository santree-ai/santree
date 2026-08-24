import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { createLogger } from "vite";
import { defineConfig } from "vitest/config";

// @ts-expect-error -- process is a Node global, not typed in the browser env.
const host = process.env.TAURI_DEV_HOST;

const viteLogger = createLogger();
const logInfo = viteLogger.info.bind(viteLogger);
viteLogger.info = (message, options) => {
  // React Refresh intentionally falls back to a page reload for modules that
  // export both providers/components and hooks or constants. The reload itself
  // is useful, but listing every non-component export after a generated-binding
  // update obscures real build diagnostics in the terminal.
  if (message.includes("Could not Fast Refresh (") && message.includes("export is incompatible")) {
    return;
  }
  logInfo(message, options);
};

// https://vite.dev/config/
export default defineConfig({
  customLogger: viteLogger,
  plugins: [
    // The router plugin must run before the React plugin so generated route
    // modules are transformed by React's Fast Refresh.
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
      // Keep colocated `*.test.tsx` files out of the generated route tree.
      routeFileIgnorePattern: ".*\\.test\\.tsx?$",
    }),
    react(),
    tailwindcss(),
  ],

  build: {
    // "hidden" = emit the maps but write no `//# sourceMappingURL=` comment into
    // the JS. Tauri compiles all of `dist/` into the binary, and a `.map` carries
    // `sourcesContent` — our original TypeScript, comments included — so shipping
    // them publishes the whole frontend source. `scripts/stash-sourcemaps.mjs`
    // (run from `beforeBuildCommand`) moves them to `sourcemaps/<version>/`
    // instead: users get minified JS, and `pnpm symbolicate` still turns their
    // stack traces back into real file/line frames against the archived maps.
    sourcemap: "hidden",
    // The Material file-icon set (~1250 small SVGs) would otherwise be inlined as
    // base64 into the JS bundle. Emit them as standalone asset files instead — in
    // a Tauri app they load instantly from local disk, and the JS stays lean.
    assetsInlineLimit: (file: string) => (file.includes("material-icon-theme") ? false : undefined),
    // Vite's 500 kB warning is about network download time; this app's bundle
    // loads from local disk (no download), so large chunks like the diff viewer
    // (@git-diff-view) are fine. The app is already route-/feature-split, so raise
    // the threshold to silence the irrelevant noise while still catching a chunk
    // that unexpectedly balloons.
    chunkSizeWarningLimit: 1500,
  },

  // Vite options tailored for Tauri development, applied during `tauri dev`/`build`.
  //
  // 1. Don't clobber Rust compiler errors in the terminal.
  clearScreen: false,
  // 2. Tauri expects a fixed port and fails fast if it's taken.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. Don't watch `src-tauri` — Rust changes are handled by `tauri dev`.
      ignored: ["**/src-tauri/**"],
    },
  },

  // Vitest configuration (jsdom so React components can render in Node).
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
