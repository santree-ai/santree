/**
 * Window chrome controls just right of the macOS traffic lights: a sidebar
 * collapse toggle (left) and back/forward navigation (right). In `fill` mode the
 * collapse sits at the left and the arrows push to the right edge of the cell
 * (Conductor-style).
 */
import { useCanGoBack, useRouter } from "@tanstack/react-router";

function IconButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md text-muted-3 transition-colors hover:bg-hover-2 hover:text-fg-2 disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function CollapseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </svg>
  );
}

export function ChromeControls({
  canCollapse,
  collapsed,
  onToggle,
  fill = false,
}: {
  canCollapse: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** Fill the cell, pushing back/forward to the right edge (Conductor-style). */
  fill?: boolean;
}) {
  const router = useRouter();
  const canGoBack = useCanGoBack();

  const arrows = (
    <div className="flex items-center gap-0.5">
      <IconButton onClick={() => router.history.back()} disabled={!canGoBack} label="Back">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </IconButton>
      <IconButton onClick={() => router.history.forward()} label="Forward">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M9 18l6-6-6-6" />
        </svg>
      </IconButton>
    </div>
  );

  const collapse = canCollapse && (
    <IconButton onClick={onToggle} label={collapsed ? "Show sidebar" : "Hide sidebar"}>
      <CollapseIcon />
    </IconButton>
  );

  // When filling the sidebar cell: collapse on the left, back/forward pushed to
  // the right edge (Conductor-style). Otherwise group them tightly together.
  return fill ? (
    <div data-tauri-drag-region className="flex flex-1 items-center">
      {collapse}
      <div data-tauri-drag-region className="flex-1" />
      {arrows}
    </div>
  ) : (
    <div className="flex items-center gap-0.5">
      {collapse}
      {arrows}
    </div>
  );
}
