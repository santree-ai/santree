/** The help + settings + version row at the bottom of each tab sidebar. */
import { useNavigate, useRouterState } from "@tanstack/react-router";

import { useAppVersion } from "../lib/queries";
import { CHROME } from "../state/AppContext";
import { iconButtonStyle } from "../theme/colors";
import { HelpMenu } from "./HelpMenu";
import { GearIcon } from "./icons";

export function SidebarFooter() {
  const { data: version } = useAppVersion();
  const navigate = useNavigate();
  const onSettings = useRouterState({
    select: (s) => s.location.pathname.startsWith("/settings"),
  });

  return (
    <div
      className={`flex ${CHROME.statusBar} flex-none items-center gap-1.5 border-t border-line px-2.5`}
    >
      <HelpMenu />
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
      <span className="font-mono text-[9px] text-muted-5">{version ? `v${version}` : ""}</span>
    </div>
  );
}
