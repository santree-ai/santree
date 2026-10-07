import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { Footer } from "~/components/footer";
import { Nav } from "~/components/nav";

// Imported as ?url and declared as a <link> below — a bare CSS import is
// injected by JS after the client bundle evaluates, so the SSR document
// would arrive unstyled and repaint.
import stylesCss from "../styles.css?url";

const SITE_URL = "https://santree.toscanini.me";
const TITLE = "santree: the ticket is the prompt";
const DESCRIPTION =
  "A desktop app that starts coding agents from your tickets. santree writes each agent's prompt from the ticket, runs it in a worktree of its own, and turns review comments into the next prompt.";

// Picks the landing's layout before first paint (components/tree/stage.tsx):
// `pin` scrolls the camera through the tree on wide screens; without it the
// stations are cards in the page's flow. Decided here, not after hydration,
// so the prerendered page never reflows from one into the other.
const LAYOUT = `try{var d=document.documentElement;if(matchMedia("(min-width: 1000px) and (min-height: 560px)").matches&&!matchMedia("(prefers-reduced-motion: reduce)").matches)d.classList.add("pin")}catch(e){}`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "theme-color", content: "#060708" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "santree" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:url", content: SITE_URL },
      { property: "og:image", content: `${SITE_URL}/og.png` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
      { name: "twitter:image", content: `${SITE_URL}/og.png` },
    ],
    links: [
      { rel: "stylesheet", href: stylesCss },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.png", type: "image/png" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "canonical", href: SITE_URL },
    ],
    scripts: [{ children: LAYOUT }],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // The layout script adds a class before hydration.
    <html lang="en" className="bg-app" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-app text-fg antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-panel focus:px-3 focus:py-2"
        >
          Skip to content
        </a>
        <div className="grain" aria-hidden />
        <Nav />
        {children}
        <Footer />
        <Scripts />
      </body>
    </html>
  );
}
