/** The Appearance section: color theme + how people's display names are shown. */

import { MonitorIcon, MoonIcon, SunIcon } from "../../../components/icons";
import { ChevronSelect, Segmented } from "../../../components/primitives";
import type { DisplayNames } from "../../../lib/queries";
import { useDisplayNames } from "../../../lib/queries";
import { type Theme, useApp } from "../../../state/AppContext";
import { Heading } from "../widgets";

export function AppearanceSection() {
  const { theme, setTheme } = useApp();
  const { value: displayNames, setValue: setDisplayNames } = useDisplayNames();
  return (
    <>
      <Heading
        title="Appearance"
        subtitle="Choose a color theme. Auto follows your system setting."
      />
      <div className="rounded-xl border border-line-2 bg-raised p-4">
        <div className="mb-[3px] text-[12.5px] font-medium text-fg-3">Theme</div>
        <div className="mb-[11px] text-[11.5px] text-muted-3">
          Switches the whole app between light and dark.
        </div>
        <Segmented<Theme>
          options={[
            { value: "dark", label: "Dark", icon: <MoonIcon size={13} /> },
            { value: "light", label: "Light", icon: <SunIcon size={13} /> },
            { value: "auto", label: "Auto", icon: <MonitorIcon size={13} /> },
          ]}
          value={theme}
          onChange={setTheme}
        />
      </div>
      <div className="mt-3 flex items-center gap-4 rounded-xl border border-line-2 bg-raised p-4">
        <div className="min-w-0 flex-1">
          <div className="mb-[3px] text-[12.5px] font-medium text-fg-3">Display names</div>
          <div className="text-[11.5px] text-muted-3">
            How people are shown across issues, triage, comments, and the on-call schedule.
          </div>
        </div>
        <ChevronSelect
          value={displayNames}
          onChange={(v) => setDisplayNames(v as DisplayNames)}
          className="w-[148px] rounded-lg border border-line-3 bg-input py-2 pr-8 pl-[11px] text-[12px] text-fg-3"
          wrapperClassName="flex-none"
        >
          <option value="full" className="bg-input">
            Full name
          </option>
          <option value="username" className="bg-input">
            Username
          </option>
        </ChevronSelect>
      </div>
    </>
  );
}
