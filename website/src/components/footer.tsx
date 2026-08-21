import { Link } from "@tanstack/react-router";
import { Logo } from "~/components/logo";

export function Footer() {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto grid max-w-5xl gap-12 px-6 py-16 sm:grid-cols-[1fr_auto_auto] sm:gap-24">
        <div>
          <div className="flex items-center gap-2.5 font-medium">
            <Logo size={18} />
            <span className="text-[15px] tracking-tight">santree</span>
          </div>
          <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-muted">
            A desktop app for managing AI coding agents across your repo's tickets.
          </p>
        </div>
        <nav aria-label="Product">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-4">Product</p>
          <ul className="mt-4 space-y-2.5 text-[13px] text-muted">
            <li>
              <Link to="/" hash="loop" className="transition-colors hover:text-fg">
                How it works
              </Link>
            </li>
            <li>
              <Link to="/" hash="features" className="transition-colors hover:text-fg">
                Features
              </Link>
            </li>
            <li>
              <a
                href="https://github.com/santree-ai/santree/releases/latest/download/santree-macos.dmg"
                className="transition-colors hover:text-fg"
              >
                Download
              </a>
            </li>
          </ul>
        </nav>
        <nav aria-label="Resources">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-4">
            Resources
          </p>
          <ul className="mt-4 space-y-2.5 text-[13px] text-muted">
            <li>
              <Link to="/docs" className="transition-colors hover:text-fg">
                Docs
              </Link>
            </li>
            <li>
              <a
                href="https://github.com/santree-ai/santree"
                className="transition-colors hover:text-fg"
              >
                GitHub
              </a>
            </li>
            <li>
              <a
                href="https://github.com/santree-ai/santree/blob/main/LICENSE"
                className="transition-colors hover:text-fg"
              >
                License
              </a>
            </li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-hairline">
        <p className="mx-auto max-w-5xl px-6 py-6 font-mono text-[11px] text-muted-4">
          © 2026 santree · made with worktrees
        </p>
      </div>
    </footer>
  );
}
