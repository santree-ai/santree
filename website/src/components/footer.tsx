import { Link } from "@tanstack/react-router";

/** One footer: one rule above it, one grid, and the last line set in the same type as the links. */
export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-in">
        <div>
          <p className="text-[15px] font-medium tracking-tight">santree</p>
          <p className="t-body mt-3 max-w-xs text-[13.5px]">Tickets in, pull requests out.</p>
        </div>
        <div className="foot-links">
          <nav aria-label="Product">
            <p className="t-label">Product</p>
            <ul>
              <li>
                <Link to="/" hash="how">
                  How it works
                </Link>
              </li>
              <li>
                <Link to="/" hash="faq">
                  FAQ
                </Link>
              </li>
              <li>
                <a href="https://github.com/santree-ai/santree/releases/latest/download/santree-macos.dmg">
                  Download
                </a>
              </li>
            </ul>
          </nav>
          <nav aria-label="Resources">
            <p className="t-label">Resources</p>
            <ul>
              <li>
                <Link to="/docs">Docs</Link>
              </li>
              <li>
                <a href="https://github.com/santree-ai/santree">GitHub</a>
              </li>
              <li>
                <a href="https://github.com/santree-ai/santree/blob/main/LICENSE">License</a>
              </li>
            </ul>
          </nav>
        </div>
        <p className="foot-last t-label">© 2026 santree · MIT licensed</p>
      </div>
    </footer>
  );
}
