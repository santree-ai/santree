import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DownloadButton } from "~/components/download-button";
import { GitHubLogo } from "~/components/icons";
import { Logo } from "~/components/logo";

// Router Links with `to="/"` + hash (not bare `#loop` anchors) so they work
// from ANY page — a bare hash on /docs points at nothing and goes nowhere.
const links = [
  { label: "How it works", hash: "loop" },
  { label: "Features", hash: "features" },
];

/** Slim full-width header: invisible over the hero, gaining a hairline
 * border + blur only once the page scrolls under it. Starts transparent on
 * the server and first client render (scrolled=false), so hydration always
 * agrees; a reload mid-page corrects in the first scroll event. */
export function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-40 border-b transition-colors duration-300 ${
        scrolled ? "border-hairline bg-app/75 backdrop-blur-xl" : "border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-14 max-w-6xl items-center px-6">
        <Link to="/" className="flex items-center gap-2 font-medium">
          <Logo size={19} />
          <span className="text-[15px] tracking-tight">santree</span>
        </Link>

        <div className="ml-auto hidden items-center gap-0.5 md:flex">
          {links.map((l) => (
            <Link
              key={l.hash}
              to="/"
              hash={l.hash}
              className="rounded-md px-2.5 py-1.5 text-[13.5px] text-muted transition-colors hover:text-fg"
            >
              {l.label}
            </Link>
          ))}
          <Link
            to="/docs"
            className="rounded-md px-2.5 py-1.5 text-[13.5px] text-muted transition-colors hover:text-fg"
          >
            Docs
          </Link>
        </div>

        <div className="ml-2 flex items-center gap-1.5 md:ml-4">
          <a
            href="https://github.com/santree-ai/santree"
            aria-label="santree on GitHub"
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-muted transition-colors hover:text-fg"
          >
            <GitHubLogo size={16} />
          </a>
          <div className="hidden sm:block">
            <DownloadButton size="sm" />
          </div>
        </div>
      </nav>
    </header>
  );
}
