/** Settings → Issue trackers → TickTick: the account connection.
 *
 *  App-scoped, like Linear's and Jira's cards, and simpler: an install connects
 *  one TickTick account, either through TickTick's OAuth app (when this build
 *  carries its client id) or with a personal API token pasted from TickTick.
 *  *Which* lists a repo reads is the per-repo Ticket tracker pane
 *  (`RepoTracker.tsx`). */

import { useState } from "react";

import { TickTickLogo } from "../../../components/icons";
import { Badge, Button } from "../../../components/primitives";
import {
  useTickTickConnect,
  useTickTickConnectToken,
  useTickTickDisconnect,
  useTickTickStatus,
} from "../../../lib/queries";
import { TICKTICK_BRAND } from "../../../theme/colors";
import { CardRow, Heading } from "../widgets";

/** TickTick's app-icon treatment — its two-colour mark (blue ring, yellow check)
 *  on a white tile. Unlike Linear's and Jira's white-on-brand tiles, TickTick's
 *  colour lives in the mark itself. */
export const ticktickBadge = (
  <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] border border-line-2 bg-white">
    <TickTickLogo size={20} branded />
  </div>
);

export function TickTickSection() {
  const { data: status } = useTickTickStatus();
  const connect = useTickTickConnect();
  const disconnect = useTickTickDisconnect();
  const connected = status?.connected === true;

  return (
    <>
      <Heading
        title="TickTick"
        subtitle="Connect your TickTick account. Each repo picks its tracker and which lists it reads (Settings → Repo → Ticket tracker)."
      />

      <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
        <div className="flex items-center gap-[13px] p-4">
          {ticktickBadge}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-fg-bright">TickTick</span>
              {connected && <Badge color="var(--color-status-green)">connected</Badge>}
              {connected && !status.canWrite && <Badge>read-only</Badge>}
            </div>
            <div className="mt-[3px] text-[11.5px] text-muted-3">
              {connected
                ? status.via === "token"
                  ? "Connected with a personal API token"
                  : "Connected through TickTick sign-in"
                : "Connect to pull your tasks into your projects"}
            </div>
          </div>
          {connected ? (
            <Button onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          ) : (
            status?.oauthAvailable && (
              // Brand-colored primary, as Linear's and Jira's cards do: the one
              // deliberate exception to the accent fill.
              <Button
                variant="primary"
                onClick={() => connect.mutate()}
                disabled={connect.isPending}
                style={{ background: TICKTICK_BRAND, color: "white" }}
              >
                {connect.isPending ? "Connecting…" : "Sign in with TickTick"}
              </Button>
            )
          )}
        </div>

        {status && !connected && <TokenRow />}
      </div>
    </>
  );
}

/** The personal-token way in: works on every build, OAuth app or not. */
function TokenRow() {
  return (
    <CardRow
      label="Use a personal API token"
      hint="In TickTick, open Settings → Account → API Token, create one and paste it here. santree keeps it in your keychain."
    >
      {(labelId) => <TickTickTokenForm labelId={labelId} />}
    </CardRow>
  );
}

/** Paste a personal API token and connect with it. The backend checks the token
 *  against TickTick before keeping it, so a typo fails here, not later. Shared
 *  with the per-repo pane's connect card. */
export function TickTickTokenForm({ labelId }: { labelId?: string }) {
  const connect = useTickTickConnectToken();
  const [token, setToken] = useState("");
  const trimmed = token.trim();

  return (
    <form
      className="flex flex-none items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        connect.mutate(trimmed, { onSuccess: () => setToken("") });
      }}
    >
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="API token"
        autoComplete="off"
        spellCheck={false}
        aria-labelledby={labelId}
        aria-label={labelId ? undefined : "TickTick API token"}
        className="w-[200px] rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[11.5px] text-fg-3 placeholder:text-muted-4"
      />
      <Button type="submit" disabled={!trimmed || connect.isPending}>
        {connect.isPending ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}
