/** The per-repo Linear section: which connected org supplies this repo's issues. */

import { Button, ChevronSelect } from "../../../components/primitives";
import {
  useLinearConnect,
  useLinearOrgs,
  useLinearStatus,
  useSetRepoLinearOrg,
} from "../../../lib/queries";
import { LINEAR_BRAND } from "../../../theme/colors";
import { Heading, SELECT_CLASS } from "../widgets";
import { linearBadge } from "./Integrations";

export function RepoLinearSection({ repo }: { repo: string }) {
  const { data: orgs = [] } = useLinearOrgs();
  const { data: status } = useLinearStatus(repo);
  const setOrg = useSetRepoLinearOrg();
  const connect = useLinearConnect();

  return (
    <>
      <Heading
        title={`Linear · ${repo}`}
        subtitle="Choose which connected organization supplies this repo's issues."
      />

      {orgs.length === 0 ? (
        <div className="flex items-center gap-[13px] rounded-xl border border-line-2 bg-raised p-4">
          {linearBadge}
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-medium text-fg-3">No Linear orgs connected</div>
            <div className="mt-[3px] text-[11.5px] text-muted-3">
              Connect one to pull this repo's assigned issues.
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
            {connect.isPending ? "Connecting…" : "Connect"}
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-line-2 bg-raised p-4">
          <div className="mb-[3px] text-[12.5px] font-medium text-fg-3">Issues source</div>
          <div className="mb-3 text-[11.5px] text-muted-3">
            Issues in the graph for <span className="font-mono text-fg-3">{repo}</span> come from
            this org.
          </div>
          <div className="flex items-center gap-2">
            <ChevronSelect
              value={status?.orgSlug ?? ""}
              onChange={(v) => setOrg.mutate({ repo, slug: v })}
              className={SELECT_CLASS}
              wrapperClassName="flex-1"
            >
              {orgs.map((org) => (
                <option key={org.slug} value={org.slug} className="bg-input">
                  {org.name} ({org.slug})
                </option>
              ))}
            </ChevronSelect>
            <Button onClick={() => setOrg.mutate({ repo, slug: null })}>Reset to default</Button>
          </div>
        </div>
      )}
    </>
  );
}
