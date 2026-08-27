/**
 * The keep-awake hold, as a status-bar segment.
 *
 * A long agent run is worthless if the Mac sleeps and locks halfway through, and
 * the hold that prevents it (`caffeinate`, tied to this app's pid) is invisible
 * once set — so it belongs in the bar that says what is currently true, not in a
 * menu. It reads as a plain toggle: dimmed when off, lit and labelled when on,
 * because "the machine will not sleep" is a state you want to be able to
 * disprove at a glance. Renders nothing off-macOS, where there is no hold to take.
 */
import { useKeepAwake } from "../../../lib/queries";
import { CoffeeIcon } from "../../icons";
import { StatusButton } from "./StatusSegment";

/** The caffeinate toggle. Shares its state with every other keep-awake control. */
export function KeepAwakeSegment() {
  const { supported, active, toggle } = useKeepAwake();
  if (!supported) return null;

  return (
    <StatusButton
      active={active}
      onClick={() => toggle(!active)}
      aria-pressed={active}
      aria-label={active ? "Allow the Mac to sleep" : "Keep the Mac awake"}
      title={
        active
          ? "Keeping the Mac awake. Click to allow sleep."
          : "Keep the Mac awake (no sleep, no lock)"
      }
    >
      <CoffeeIcon size={11} />
      {active && <span>awake</span>}
    </StatusButton>
  );
}
