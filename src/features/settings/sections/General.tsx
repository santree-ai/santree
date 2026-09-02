/** Settings → General: the app-wide preferences that belong to no one feature —
 *  how it behaves, how it looks, and how it updates. Appearance and Updates are
 *  embedded rather than nav items of their own: a pane of two controls is a
 *  section, not a destination. */

import { CONFIRM_ON_QUIT_KEY, useSetSetting, useSetting } from "../../../lib/queries";
import { Heading, ToggleRow } from "../widgets";
import { AppearanceSection } from "./Appearance";
import { UpdatesSection } from "./Updates";

export function GeneralSection() {
  const { data } = useSetting("app", CONFIRM_ON_QUIT_KEY);
  // Defaults ON: only an explicit "false" opts out (matches QuitGuard's read).
  const confirmOnQuit = data !== "false";
  const { mutate: setSetting } = useSetSetting();

  return (
    <>
      <Heading title="General" subtitle="How the app looks, behaves and updates." />
      <div className="mb-5 rounded-xl border border-line-2 bg-raised px-4 py-0.5">
        <ToggleRow
          label="Confirm before quitting"
          hint="Ask for confirmation when closing the app, so you don't lose running agent terminals by accident."
          on={confirmOnQuit}
          onChange={(next) =>
            setSetting({ scope: "app", key: CONFIRM_ON_QUIT_KEY, value: next ? "true" : "false" })
          }
        />
      </div>
      <div className="mb-2.5 px-1">
        <div className="text-[13px] font-semibold text-fg-bright">Appearance</div>
        <div className="mt-0.5 text-[11.5px] text-muted-3">
          Color theme and how people's names are shown.
        </div>
      </div>
      <div className="mb-5">
        <AppearanceSection embedded />
      </div>
      <div className="mb-2.5 px-1">
        <div className="text-[13px] font-semibold text-fg-bright">Updates</div>
        <div className="mt-0.5 text-[11.5px] text-muted-3">Release channel and app version.</div>
      </div>
      <UpdatesSection embedded />
    </>
  );
}
