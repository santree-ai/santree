import { Link } from "@tanstack/react-router";
import { DownloadButton } from "~/components/download-button";
import { GitHubLogo } from "~/components/icons";
import { Logo } from "~/components/logo";
import { WipPill } from "~/components/wip-pill";

// Router Links with `to="/"` + hash (not bare `#loop` anchors) so they work
// from ANY page — a bare hash on /docs points at nothing and goes nowhere.
const links = [
  { label: "How it works", hash: "loop" },
  { label: "Features", hash: "features" },
];

/** Floating nav: a detached, rounded, blurred bar inset from the top —
 * the page scrolls underneath it. */
export function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 px-4 pt-4">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between rounded-2xl border border-line bg-app/70 pl-5 pr-3 backdrop-blur-xl">
        <Link to="/" className="flex items-center gap-2.5 font-medium">
          <Logo size={20} />
          <span className="text-[15px] tracking-tight">santree</span>
        </Link>

        <div className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <Link
              key={l.hash}
              to="/"
              hash={l.hash}
              className="rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-fg"
            >
              {l.label}
            </Link>
          ))}
          <Link
            to="/docs"
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-fg"
          >
            Docs
            <WipPill />
          </Link>
        </div>

        <div className="flex items-center gap-2">
          <a
            href="https://github.com/santree-ai/santree"
            aria-label="santree on GitHub"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-white/5 hover:text-fg"
          >
            <GitHubLogo size={17} />
          </a>
          <div className="hidden sm:block">
            <DownloadButton size="sm" />
          </div>
        </div>
      </nav>
    </header>
  );
}
