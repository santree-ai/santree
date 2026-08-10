import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The site deploys as STATIC HTML to GitHub Pages: `prerender` renders every
// route to plain .html at build time (crawlLinks walks the internal links, so
// /docs is picked up from the nav), and the deploy workflow publishes
// dist/client. There is no server anywhere — TanStack Start is used here for
// its SSR-quality build-time rendering, then the pages hydrate into a normal
// SPA in the browser.
//
// Tailwind v4 is a Vite plugin — no PostCSS step; the scanned directories are
// declared by @source in src/styles.css, not here.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Plugin order matters: tailwind → tanstackStart → viteReact (Start must
  // run before the React plugin).
  plugins: [
    tailwindcss(),
    tanstackStart({
      prerender: {
        enabled: true,
        crawlLinks: true,
      },
    }),
    viteReact(),
    // React Compiler. A SEPARATE plugin, not an option on viteReact —
    // @vitejs/plugin-react v6 moved its transform to oxc and silently ignores
    // the v4-era `babel` option. The compiler runtime ships inside React 19.
    babel({ presets: [reactCompilerPreset()] }),
  ],
});
