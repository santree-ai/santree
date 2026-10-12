/**
 * The santree server's trouble light: a dot for `Down` and `Failing`, and for a
 * start or a stop that has gone on longer than it should.
 *
 * Silent otherwise, like the banner it pairs with and by the same rule
 * (`useServerAttention`): a server that is running (or off, in a build with
 * in-app terminals) needs no word, and the ordinary start at launch is over well
 * inside the grace period. A click lands on Settings → Terminal, where the card
 * has Start, Restart and the logs.
 */
import { useNavigate } from "@tanstack/react-router";

import { useServerStatus } from "../../../lib/queries";
import { serverStateView, TONE_DOT, useServerAttention } from "../../../lib/serverStatus";
import { StatusButton } from "./StatusSegment";

export function ServerSegment() {
  const { data } = useServerStatus();
  const navigate = useNavigate();
  const attention = useServerAttention(data?.state);

  if (!data || !attention) return null;
  const { state } = data;
  const view = serverStateView(state);
  const reason = state.kind === "Down" || state.kind === "Failing" ? ` ${state.reason}` : "";

  return (
    <StatusButton
      active
      aria-label={`${view.short}. Open Terminal settings`}
      title={`${view.sentence}${reason} Click for Terminal settings.`}
      onClick={() => navigate({ to: "/settings", search: { section: "terminal" } })}
    >
      <span aria-hidden className={`h-1.5 w-1.5 flex-none rounded-full ${TONE_DOT[view.tone]}`} />
      <span>{view.short}</span>
    </StatusButton>
  );
}
