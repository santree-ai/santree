/** The help button + popover in each view's sidebar footer. */
import { useState } from "react";

import { useAppVersion } from "../lib/queries";
import { useAppUi } from "../state/AppContext";
import { iconButtonStyle } from "../theme/colors";
import { HelpIcon, KbdIcon } from "./icons";
import { Dropdown } from "./primitives";

export function HelpMenu() {
  const { setShortcutsOpen } = useAppUi();
  const { data: version } = useAppVersion();
  const [open, setOpen] = useState(false);

  return (
    <Dropdown
      placement="up"
      align="left"
      menuClassName="w-[302px] overflow-hidden p-1.5"
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
      {(close) => (
        <>
          <button
            type="button"
            onClick={() => {
              close();
              setShortcutsOpen(true);
            }}
            className="flex w-full cursor-pointer items-center gap-[11px] rounded-md px-2.5 py-2 text-left text-[13px] text-fg-3 hover:bg-input"
          >
            <KbdIcon className="text-muted" />
            <span className="flex-1">Keyboard shortcuts</span>
            <span className="font-mono text-[11px] text-muted-3">⌘/</span>
          </button>
          <div className="mt-1 border-t border-line-2 px-2.5 pt-2.5 pb-1 font-mono text-[10.5px] text-muted-4">
            santree {version ? `v${version}` : ""}
          </div>
        </>
      )}
    </Dropdown>
  );
}
