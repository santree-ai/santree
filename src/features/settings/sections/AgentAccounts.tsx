/** Settings → Agents' Accounts block, for Claude Code and Codex: the CLI's own
 *  login (the Default) and every extra login santree keeps for it — each its own
 *  config folder, signed in through the vendor's own login command in a
 *  terminal the user watches. Which one new sessions launch on is a setting; a
 *  running session moves only on the tab's "Continue on …", one click at a time
 *  (COMPLIANCE.md, "Agent accounts"). */

import { type FormEvent, type ReactNode, useState } from "react";

import type { AgentAccount } from "../../../bindings";
import { PlayIcon, PlusIcon } from "../../../components/icons";
import { Button, ConfirmDialog } from "../../../components/primitives";
import { BudgetLine } from "../../../components/shell/status/BudgetLine";
import { meterColor, type UsageWindow } from "../../../components/shell/status/usageWindows";
import { useAccountWindows } from "../../../components/shell/status/useAccountWindows";
import {
  AGENT_ACCOUNT_KEY,
  providerSettingKey,
  useAgentAccountLoginCommand,
  useAgentAccounts,
  useCreateAgentAccount,
  useRemoveAgentAccount,
  useSetSetting,
  useSetting,
} from "../../../lib/queries";
import { useLiveNow } from "../../../lib/relativeTime";
import { LoginTerminal } from "../LoginTerminal";
import { Block } from "../widgets";

type Kind = "Claude" | "Codex";

export function AgentAccountsBlock({
  kind,
  defaultStatus,
}: {
  kind: Kind;
  /** What the Default account's row says about its login — the email, or
   *  whether the CLI is signed in — from the provider's own auth read. */
  defaultStatus: string;
}) {
  const accounts = useAgentAccounts(kind);
  const windowsOf = useAccountWindows(kind);
  const nowMs = useLiveNow();
  const key = providerSettingKey(AGENT_ACCOUNT_KEY, kind);
  const chosen = useSetting("app", key).data ?? "";
  const { mutate: setSetting } = useSetSetting();
  const create = useCreateAgentAccount();
  const remove = useRemoveAgentAccount();
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const login = useAgentAccountLoginCommand(kind, signingIn);
  const [removing, setRemoving] = useState<AgentAccount | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  const list = accounts.data ?? [];
  // A setting naming an account that is gone launches on the Default (the
  // backend falls back), so that is what the choice shows.
  const current = list.some((a) => a.id === chosen) ? chosen : "";
  const choose = (id: string) => setSetting({ scope: "app", key, value: id || null });
  const cli = kind === "Claude" ? "Claude Code" : "Codex";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const label = draft?.trim();
    if (!label) return;
    create.mutate(
      { agent: kind, label },
      {
        onSuccess: (account) => {
          setDraft(null);
          // A new account is signed out: its login is the next thing to do.
          setSigningIn(account.id);
        },
      },
    );
  };

  return (
    <Block
      title="Accounts"
      subtitle={`Extra ${cli} logins, each with its own config folder. New sessions start on the one chosen here; a running tab moves with its "Continue on" menu.`}
    >
      <fieldset className="overflow-hidden rounded-lg border border-line-3 bg-surface">
        <legend className="sr-only">Account for new {cli} sessions</legend>
        <AccountRow
          name={`agent-account-${kind}`}
          label="Default"
          detail={defaultStatus}
          checked={current === ""}
          onChoose={() => choose("")}
          windows={windowsOf(null)}
          nowMs={nowMs}
        />
        {list.map((a) => (
          <AccountRow
            key={a.id}
            name={`agent-account-${kind}`}
            label={a.label}
            detail={a.email ?? (a.signedIn ? "Signed in" : "Not signed in")}
            checked={current === a.id}
            onChoose={() => choose(a.id)}
            windows={windowsOf(a.id)}
            nowMs={nowMs}
            actions={
              <>
                {!a.signedIn && signingIn !== a.id && (
                  <Button size="sm" onClick={() => setSigningIn(a.id)}>
                    <PlayIcon size={10} />
                    Sign in
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setRemoving(a)}>
                  Remove
                </Button>
              </>
            }
          />
        ))}
      </fieldset>

      {signingIn !== null && login.data && (
        <LoginTerminal
          key={signingIn}
          refId={`login:${kind}:${signingIn}`}
          command={login.data}
          onClose={() => {
            setSigningIn(null);
            void accounts.refetch();
          }}
        />
      )}

      {draft === null ? (
        <Button onClick={() => setDraft("")} className="mt-3">
          <PlusIcon size={11} />
          Add account
        </Button>
      ) : (
        <form onSubmit={submit} className="mt-3 flex items-center gap-2">
          <input
            // biome-ignore lint/a11y/noAutofocus: the field just opened on the user's click.
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(null);
            }}
            placeholder="Name, e.g. Work"
            aria-label={`New ${cli} account name`}
            maxLength={64}
            spellCheck={false}
            className="w-full flex-1 rounded-lg border border-line-3 bg-input px-[11px] py-2 text-[12px] text-fg-3 placeholder:text-muted-4"
          />
          <Button type="submit" disabled={!draft.trim() || create.isPending}>
            {create.isPending ? "Adding…" : "Add"}
          </Button>
          <Button variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </form>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.label ?? "this account"}?`}
        message={
          removing
            ? `Deletes its folder in santree (${removing.dir}). ${cli}'s own saved login for it, in your keychain, is left untouched; sign out in ${cli} first if you want that gone too. Tabs that ran on it continue on the Default account.`
            : ""
        }
        confirmLabel="Remove"
        busyLabel="Removing…"
        danger
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync({ agent: kind, id: removing.id });
          if (signingIn === removing.id) setSigningIn(null);
        }}
        onClose={() => setRemoving(null)}
      />
    </Block>
  );
}

function AccountRow({
  name,
  label,
  detail,
  checked,
  onChoose,
  windows,
  nowMs,
  actions,
}: {
  /** The radio group's name — one per provider. */
  name: string;
  label: string;
  detail: string;
  checked: boolean;
  onChoose: () => void;
  windows: UsageWindow[];
  nowMs: number;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 border-t border-line px-3 py-2.5 first-of-type:border-t-0">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChoose}
        aria-label={`Use ${label} for new sessions`}
        className="mt-[3px] flex-none cursor-pointer accent-[var(--accent)]"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="flex-none text-[12px] font-medium text-fg-2">{label}</span>
          <span className="min-w-0 truncate text-[11.5px] text-muted-3" title={detail}>
            {detail}
          </span>
        </div>
        {windows.length > 0 && (
          <div className="flex max-w-[320px] flex-col gap-0.5">
            {windows.map((w) => (
              <BudgetLine
                key={w.label}
                label={w.longLabel}
                pct={w.pct}
                color={meterColor(w.pct)}
                value={`${w.pct}%`}
                resetsAtMs={w.resetsAtMs}
                nowMs={nowMs}
              />
            ))}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-none items-center gap-1.5">{actions}</div>}
    </div>
  );
}
