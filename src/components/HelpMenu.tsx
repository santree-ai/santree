/** The help popover anchored at the bottom-left of the window. */
import { useApp } from "../state/AppContext";

const KbdIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#9b9ba3"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </svg>
);
const DocsIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#9b9ba3"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);
const FeedbackIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#9b9ba3"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
const DiagIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#9b9ba3"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

interface Item {
  icon?: React.ReactNode;
  label: string;
  shortcut?: string;
  external?: boolean;
  indented?: boolean;
}

const ITEMS: Item[] = [
  { icon: <KbdIcon />, label: "Keyboard shortcuts", shortcut: "⌘/" },
  { icon: <DocsIcon />, label: "Docs", external: true },
  { label: "Best practices", external: true, indented: true },
  { label: "Changelog", external: true, indented: true },
  { icon: <FeedbackIcon />, label: "Send feedback", shortcut: "⌘⌥F" },
  { label: "Discord", external: true, indented: true },
  { label: "Submit a prompt", indented: true },
  { icon: <DiagIcon />, label: "Diagnostics" },
  { label: "Open debug tools", indented: true },
];

export function HelpMenu() {
  const { helpOpen, setHelpOpen } = useApp();
  if (!helpOpen) return null;

  return (
    <>
      {/* Click-away catcher */}
      <button
        type="button"
        aria-label="Close help"
        className="fixed inset-0 z-[70] cursor-default"
        onClick={() => setHelpOpen(false)}
      />
      <div className="absolute bottom-[54px] left-3 z-[80] w-[302px] rounded-xl border border-line-3 bg-popover p-1.5 shadow-[0_22px_58px_-18px_rgba(0,0,0,.9)]">
        {ITEMS.map((item) => (
          <button
            type="button"
            key={item.label}
            onClick={() => setHelpOpen(false)}
            className="flex w-full cursor-pointer items-center gap-[11px] rounded-md px-2.5 py-2 text-left text-[13px] text-fg-3 hover:bg-input"
            style={item.indented ? { paddingLeft: 36, fontSize: 12.5 } : undefined}
          >
            {item.icon}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <span className="font-mono text-[11px] text-muted-3">{item.shortcut}</span>
            )}
            {item.external && <span className="text-[11px] text-muted-4">↗</span>}
          </button>
        ))}
        <div className="mt-1 border-t border-line-2 px-2.5 pt-2.5 pb-1 font-mono text-[10.5px] text-muted-4">
          santree v0.8.0 · Claude Code 2.1.156 · Codex 0.138.0
        </div>
      </div>
    </>
  );
}
