/**
 * The top bar's keep-awake toggle (macOS only): hold the Mac awake — no display
 * sleep, so no lock screen — while long agent runs are on screen. Backed by
 * `caffeinate` tied to the app's pid (quitting santree always releases it), and
 * session-scoped on purpose: it never persists, so a toggle forgotten weeks ago
 * can't leave the laptop permanently unlocked. Renders nothing off-macOS.
 */
import { useKeepAwake } from "../../lib/queries";
import { CoffeeIcon } from "../icons";

export function KeepAwakeButton() {
  const { supported, active, toggle } = useKeepAwake();
  if (!supported) return null;
  return (
    <button
      type="button"
      onClick={() => toggle(!active)}
      aria-pressed={active}
      title={
        active
          ? "Keeping the Mac awake — click to allow sleep"
          : "Keep the Mac awake (no sleep, no lock)"
      }
      aria-label={active ? "Allow the Mac to sleep" : "Keep the Mac awake"}
      className={`flex h-[22px] w-[22px] flex-none cursor-pointer items-center justify-center rounded-md hover:bg-hover focus-visible:ring-1 focus-visible:ring-[color:var(--accent)] focus-visible:outline-none ${
        active ? "text-[color:var(--accent)]" : "text-muted-3 hover:text-fg-2"
      }`}
    >
      <CoffeeIcon size={12} />
    </button>
  );
}
