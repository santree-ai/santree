/** The Appearance section: color theme, text size, and how people's display
 *  names are shown.
 *
 *  Lives inside Settings → General rather than owning a nav item: three controls
 *  is not a destination, and "make this readable" is the same errand as the rest
 *  of General. `embedded` drops its own heading so the host can title it — the
 *  arrangement {@link UpdatesSection} already uses. */

import { useState } from "react";

import { MonitorIcon, MoonIcon, SunIcon } from "../../../components/icons";
import { Button, ChevronSelect, Segmented } from "../../../components/primitives";
import type { DisplayNames } from "../../../lib/queries";
import { useDisplayNames } from "../../../lib/queries";
import { applyZoom, DEFAULT_ZOOM, loadZoom, step, ZOOM_STEPS } from "../../../lib/zoom";
import { type Theme, useApp } from "../../../state/AppContext";
import { CardRow, Heading } from "../widgets";

/** Text size, mirroring ⌘+ / ⌘- / ⌘0 — the same ladder, so the two controls can't
 *  disagree. Kept beside Theme because that's where people look for "make this
 *  readable", and a shortcut nobody discovers isn't a feature. */
function TextSizeControl() {
  const [level, setLevel] = useState(loadZoom);
  const set = (next: number) => {
    setLevel(next);
    applyZoom(next);
  };
  return (
    <div className="flex flex-none items-center gap-1.5">
      <Button
        size="sm"
        onClick={() => set(step(level, -1))}
        disabled={level <= ZOOM_STEPS[0]}
        aria-label="Decrease text size"
      >
        −
      </Button>
      <button
        type="button"
        onClick={() => set(DEFAULT_ZOOM)}
        title="Reset to 100%"
        className="h-6 w-[52px] cursor-pointer rounded-md text-center text-sm text-fg hover:bg-hover-2 tabular-nums"
      >
        {Math.round(level * 100)}%
      </button>
      <Button
        size="sm"
        onClick={() => set(step(level, 1))}
        disabled={level >= ZOOM_STEPS[ZOOM_STEPS.length - 1]}
        aria-label="Increase text size"
      >
        +
      </Button>
    </div>
  );
}

/** One grouped card, a row per control — the label says what it is, the control
 *  sits at the trailing edge, the way the system's own settings lay out. */
export function AppearanceSection({ embedded = false }: { embedded?: boolean }) {
  const { theme, setTheme } = useApp();
  const { value: displayNames, setValue: setDisplayNames } = useDisplayNames();
  return (
    <>
      {!embedded && (
        <Heading
          title="Appearance"
          subtitle="Choose a color theme. Auto follows your system setting."
        />
      )}
      <div className="rounded-xl border border-line-2 bg-raised">
        <CardRow label="Theme" hint="Auto follows your system setting.">
          {() => (
            <Segmented<Theme>
              ariaLabel="Theme"
              options={[
                { value: "dark", label: "Dark", icon: <MoonIcon size={12} /> },
                { value: "light", label: "Light", icon: <SunIcon size={12} /> },
                { value: "auto", label: "Auto", icon: <MonitorIcon size={12} /> },
              ]}
              value={theme}
              onChange={setTheme}
              className="w-[228px] flex-none"
            />
          )}
        </CardRow>
        <CardRow
          label="Text size"
          hint="Scales the whole app, terminals included. Also ⌘+ and ⌘− anywhere, ⌘0 to reset."
        >
          {() => <TextSizeControl />}
        </CardRow>
        <CardRow
          label="Display names"
          hint="How people are shown across issues, triage, comments, and the on-call schedule."
        >
          {(labelId) => (
            <ChevronSelect
              value={displayNames}
              onChange={(v) => setDisplayNames(v as DisplayNames)}
              className="w-[148px] rounded-md border border-line-3 bg-input py-1 pr-8 pl-2.5 text-sm text-fg"
              wrapperClassName="flex-none"
              aria-labelledby={labelId}
            >
              <option value="full" className="bg-input">
                Full name
              </option>
              <option value="username" className="bg-input">
                Username
              </option>
            </ChevronSelect>
          )}
        </CardRow>
      </div>
    </>
  );
}
