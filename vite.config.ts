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
