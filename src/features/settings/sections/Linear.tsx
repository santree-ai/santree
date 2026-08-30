/** Settings → Integrations → Linear: the workspace connection, what the next
 *  connect asks for, and how the sidebar nests what Linear returns.
 *
 *  Everything here is app-scoped — a Linear workspace is connected once for the
 *  whole install, and the sidebar tree is cross-repo. *Which* connected org a
 *  given repo draws its issues from is the per-repo pane (`RepoLinear.tsx`). */

import { type ReactNode, useId } from "react";

import { LinearLogo } from "../../../components/icons";
import { Badge, Button, ChevronSelect } from "../../../components/primitives";
import {
  LINEAR_GROUP_BY_KEY,
  LINEAR_SCOPE_KEY,
  type LinearGroupBy,
  type LinearScope,
  parseLinearGroupBy,
  parseLinearScope,
  useLinearApiBudget,
  useLinearConnect,
  useLinearOrgs,
  useSetSetting,
  useSetting,
} from "../../../lib/queries";
import { LINEAR_BRAND } from "../../../theme/colors";
import { ApiBudgetMeters } from "../ApiBudget";
import { Heading } from "../widgets";

/** Linear's real app-icon treatment — the official monochrome logomark, white on
 *  a near-black tile (theme-independent, like the GitHub mark beside it). */
export const linearBadge = (
  <div
    className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] text-white"
    style={{ background: "#101113" }}
  >
    <LinearLogo size={19} />
  </div>
);

/** The dropdowns in the card's preference rows: label on the left, control on
 *  the right, so the two rows read as one column of choices. */
const ROW_SELECT_CLASS =
  "rounded-lg border border-line-3 bg-input py-2 pr-8 pl-[11px] text-[12px] text-fg-3";

/** The sidebar nestings, in increasing depth. The labels are the user's words
 *  for the shape, not the stored discriminants. */
const GROUP_BY_OPTIONS: { value: LinearGroupBy; label: string }[] = [
  { value: "none", label: "None" },
  { value: "project", label: "Project" },
  { value: "milestone", label: "Milestone" },
  { value: "project_milestone", label: "Project → Milestone" },
];

export function LinearSection() {
  const { data: orgs = [] } = useLinearOrgs();
  const connect = useLinearConnect();
  const scope: LinearScope = parseLinearScope(useSetting("app", LINEAR_SCOPE_KEY).data);
  const groupBy: LinearGroupBy = parseLinearGroupBy(useSetting("app", LINEAR_GROUP_BY_KEY).data);
  const { mutate: setSetting } = useSetSetting();
  const connected = orgs.length > 0;

  return (
    <>
      <Heading
        title="Linear"
        subtitle="Connect your task tracker. Each repo picks which connected org it uses (Settings → Repo → Linear)."
      />

      <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
        <div className="flex items-center gap-[13px] p-4">
          {linearBadge}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-semibold text-fg-bright">Linear</span>
              {connected && <Badge color="var(--color-status-green)">connected</Badge>}
            </div>
            <div className="mt-[3px] text-[11.5px] text-muted-3">
              {connected
                ? `${orgs.length} ${orgs.length === 1 ? "org" : "orgs"} connected, chosen per repo`
                : "Connect to sync your assigned issues"}
            </div>
          </div>
          {/* Brand-colored primary — the Linear purple with white text is the one
              deliberate exception to the accent fill (a "connect to Linear" cue). */}
          <Button
            variant="primary"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
            style={{ background: LINEAR_BRAND, color: "#ffffff" }}
          >
            {connect.isPending ? "Connecting…" : connected ? "Add org" : "Connect"}
          </Button>
        </div>

        {/* What the NEXT connect asks for. Deliberately not derived from the
            connected orgs: the grant is fixed at authorize time, so this is a
            request, and changing it only matters on the trip through Linear. */}
        <CardRow
          label="Permissions to request"
          hint="Read-only workspaces still show issues, triage and comments. santree just can't change anything. Choose write access intentionally; reconnect any workspace that was granted read-only."
        >
          {(labelId) => (
            <ChevronSelect
              value={scope}
              onChange={(value) => setSetting({ scope: "app", key: LINEAR_SCOPE_KEY, value })}
              className={`w-[148px] ${ROW_SELECT_CLASS}`}
              wrapperClassName="flex-none"
              aria-labelledby={labelId}
            >
              <option value="read" className="bg-input">
                Read-only
              </option>
              <option value="read_write" className="bg-input">
                Read &amp; write
              </option>
            </ChevronSelect>
          )}
        </CardRow>

        {/* One selector rather than nested toggles: project and milestone are
            levels of the same nesting, so the user picks the depth outright. */}
        <CardRow
          label="Group issues by"
          hint="How the sidebar nests each project's tickets and worktrees. The tree is cross-repo, so this shape applies everywhere."
        >
          {(labelId) => (
            <ChevronSelect
              value={groupBy}
              onChange={(value) => setSetting({ scope: "app", key: LINEAR_GROUP_BY_KEY, value })}
              className={`w-[186px] ${ROW_SELECT_CLASS}`}
              wrapperClassName="flex-none"
              aria-labelledby={labelId}
            >
              {GROUP_BY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value} className="bg-input">
                  {option.label}
                </option>
              ))}
            </ChevronSelect>
          )}
        </CardRow>

        {connected && (
          <div className="border-t border-line bg-surface px-4 py-2">
            {orgs.map((org) => (
              <div key={org.slug} className="flex items-center gap-2 py-1.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: LINEAR_BRAND }} />
                <span className="text-[12px] text-fg-3">{org.name}</span>
                <span className="font-mono text-[10.5px] text-muted-4">{org.slug}</span>
                {!org.canWrite && <Badge>read-only</Badge>}
              </div>
            ))}
          </div>
        )}

        {connected && <LinearBudget />}
      </div>
    </>
  );
}

/** A label + hint on the left, one control on the right. The caption is wired to
 *  the control via `aria-labelledby` (handed to the child as an id), so the
 *  visible text doubles as the control's programmatic name. */
function CardRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: ReactNode;
  children: (labelId: string) => ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="flex items-center gap-4 border-t border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <div id={labelId} className="mb-[3px] text-[12.5px] font-medium text-fg-3">
          {label}
        </div>
        <div className="text-[11.5px] text-muted-3">{hint}</div>
      </div>
      {children(labelId)}
    </div>
  );
}

/** Each connected workspace's remaining Linear budget.
 *
 *  One block per org because the limits are per user per OAuth app, so two
 *  workspaces genuinely have two budgets. The "as of" line is not decoration:
 *  Linear reports the budget only in the headers of a call that already spent
 *  some of it, so this is the last reading santree took, not a live meter. */
function LinearBudget() {
  const { data: budgets = [], isFetching } = useLinearApiBudget();
  if (budgets.length === 0) return null;

  return (
    <div className="border-t border-line px-4 py-3.5">
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-fg-3">API budget</span>
        <span className="text-[11.5px] text-muted-3">
          Per workspace, per hour. Throttling stops on whichever pool runs out first.
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {budgets.map((budget) => (
          <div key={budget.slug}>
            {budgets.length > 1 && (
              <div className="mb-1.5 text-[11.5px] text-muted-2">{budget.name}</div>
            )}
            <ApiBudgetMeters
              windows={budget.windows}
              caption={
                isFetching
                  ? "Reading…"
                  : `As reported by Linear on santree's last call, ${new Date(
                      budget.observedAtMs ?? 0,
                    ).toLocaleTimeString()}. Linear only reports this in a response, so there is nothing to poll.`
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}
