/** The help + settings + version row at the bottom of each tab sidebar. */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { CSSProperties } from "react";

import { useApp } from "../state/AppContext";
import { GearIcon, HelpIcon } from "./icons";

const APP_VERSION = "v0.8.0";

function iconButtonStyle(active: boolean): CSSProperties {
  return active
    ? {
        background: "color-mix(in srgb, var(--accent) 18%, transparent)",
        borderColor: "color-mix(in srgb, var(--accent) 55%, transparent)",
        color: "var(--accent)",
      }
    : { background: "transparent", borderColor: "#2a2a31", color: "#8b8b94" };
}

export function SidebarFooter() {
  const { helpOpen, setHelpOpen } = useApp();
  const navigate = useNavigate();
  const onSettings = useRouterState({
    select: (s) => s.location.pathname.startsWith("/settings"),
  });

  return (
    <div className="flex flex-none items-center gap-1.5 border-t border-line px-2.5 py-2">
      <button
        type="button"
        onClick={() => setHelpOpen(!helpOpen)}
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors hover:!border-line-strong hover:!text-fg-2"
        style={iconButtonStyle(helpOpen)}
        aria-label="Help"
      >
        <HelpIcon />
      </button>
      <button
        type="button"
        onClick={() => navigate({ to: "/settings" })}
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors hover:!border-line-strong hover:!text-fg-2"
        style={iconButtonStyle(onSettings)}
        aria-label="Settings"
      >
        <GearIcon />
      </button>
      <div className="flex-1" />
      <span className="font-mono text-[9px] text-muted-5">{APP_VERSION}</span>
    </div>
  );
}
