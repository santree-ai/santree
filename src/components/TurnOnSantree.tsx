/** "Turn on santree for this Mac…" — the one way santree asks for itself to be
 *  turned on (docs/remote.md, "This Mac's settings").
 *
 *  santree on grants a shell on the box, so the Daedalus agent never sends it:
 *  it names the Daedalus page where an admin confirms it, behind the first
 *  characters of this Mac's key typed, and santree opens that page in the
 *  browser. What happened next is a line under the button, never a toast. */

import type { DaedalusSettingAnswer } from "../bindings";
import { useDaedalusMachine, useSetDaedalusSetting } from "../lib/queries";
import { ExternalLinkIcon } from "./icons";
import { Button } from "./primitives";

/** What to say under the button once the agent has answered. */
export function santreeAnswerLine(
  answer: DaedalusSettingAnswer | undefined,
  keyShort: string | null,
): string | null {
  switch (answer?.kind) {
    case undefined:
      return null;
    case "Opened":
      return keyShort
        ? `Confirm in the browser. It asks for the start of this Mac's key: ${keyShort}`
        : "Confirm in the browser.";
    case "Unchanged":
      return "santree is already on for this Mac.";
    case "Sent":
      return null;
    case "AgentOutdated":
      return "Update the Daedalus agent to turn santree on from here, or turn it on in Daedalus › Settings › Machines.";
    case "Refused":
      return answer.reason;
  }
}

export function TurnOnSantree({ className }: { className?: string }) {
  const machine = useDaedalusMachine();
  const turnOn = useSetDaedalusSetting();
  const keyShort = machine.data?.kind === "Ready" ? machine.data.settings.fingerprintShort : null;
  const line = santreeAnswerLine(turnOn.data, keyShort);
  return (
    <div className={className}>
      <Button
        size="sm"
        disabled={turnOn.isPending}
        onClick={() => turnOn.mutate({ key: "Santree", value: true })}
      >
        Turn on santree for this Mac…
        <ExternalLinkIcon size={11} className="ml-1.5" />
      </Button>
      {line && (
        <div role="status" className="mt-1.5 text-[11.5px] leading-[1.5] text-muted-3">
          {line}
        </div>
      )}
    </div>
  );
}
