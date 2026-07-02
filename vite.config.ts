import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// @ts-expect-error -- process is a Node global, not typed in the browser env.
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
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
    // Local files only — no download cost in a Tauri app — so ship them to get
    // readable stack traces (file/line, unminified names) from production crashes
    // instead of a wall of minified gibberish.
    sourcemap: true,
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
