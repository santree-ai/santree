/** The help button + popover in the sidebar footer: the app's own reference
 *  (shortcuts, docs, changelog), its home on GitHub, and the update check. Each
 *  of these already exists somewhere in the app; this is the one place they are
 *  all reachable from. */
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ReactNode, useState } from "react";

import { REPO, SITE } from "../lib/links";
import { useAppVersion, useCheckForUpdate } from "../lib/queries";
import { useAppUi } from "../state/AppContext";
import { iconButtonStyle } from "../theme/colors";
import {
  DocsIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FeedbackIcon,
  GitHubLogo,
  HelpIcon,
  KbdIcon,
  SparklesIcon,
} from "./icons";
import { Dropdown, Spinner } from "./primitives";

function Item({
  icon,
  label,
  trailing,
  external = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  /** A shortcut hint, shown at the trailing edge. */
  trailing?: ReactNode;
  /** Opens in the browser — marked so the click isn't a surprise. */
  external?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-[11px] rounded-md px-2.5 py-2 text-left text-[13px] text-fg-3 hover:bg-input"
    >
      <span className="flex w-4 flex-none items-center justify-center text-muted">{icon}</span>
      <span className="flex-1">{label}</span>
      {trailing ?? (external && <ExternalLinkIcon size={12} className="text-muted-4" />)}
    </button>
  );
}

function Separator() {
  return <div className="my-1 border-t border-line-2" />;
}

export function HelpMenu() {
  const { setShortcutsOpen } = useAppUi();
  const { data: version } = useAppVersion();
  const check = useCheckForUpdate();
  const [open, setOpen] = useState(false);

  return (
    <Dropdown
      placement="up"
      align="left"
      menuClassName="w-[248px] overflow-hidden p-1.5"
      open={open}
      onOpenChange={setOpen}
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md border transition-colors hover:!border-line-strong hover:!text-fg-2"
          style={iconButtonStyle(open)}
          aria-label="Help"
        >
          <HelpIcon />
        </button>
      )}
    >
      {(close) => {
        const run = (fn: () => void) => () => {
          close();
          fn();
        };
        const link = (url: string) => run(() => void openUrl(url));
        return (
          <>
            <Item
              icon={<KbdIcon size={14} />}
              label="Keyboard shortcuts"
              trailing={<span className="font-mono text-[11px] text-muted-3">⌘/</span>}
              onClick={run(() => setShortcutsOpen(true))}
            />
            <Item
              icon={<FeedbackIcon size={14} />}
              label="Send feedback"
              external
              onClick={link(`${REPO}/issues/new`)}
            />
            <Separator />
            <Item
              icon={<DocsIcon size={14} />}
              label="Docs"
              external
              onClick={link(`${SITE}/docs`)}
            />
            <Item
              icon={<SparklesIcon size={14} />}
              label="Changelog"
              external
              onClick={link(`${REPO}/blob/main/CHANGELOG.md`)}
            />
            <Item icon={<GitHubLogo size={14} />} label="GitHub" external onClick={link(REPO)} />
            <Separator />
            <Item
              icon={check.isPending ? <Spinner size={12} /> : <DownloadIcon size={14} />}
              label="Check for updates"
              onClick={run(() => check.mutate())}
            />
            <div className="mt-1 border-t border-line-2 px-2.5 pt-2.5 pb-1 font-mono text-[10.5px] text-muted-4">
              santree {version ? `v${version}` : ""}
            </div>
          </>
        );
      }}
    </Dropdown>
  );
}
