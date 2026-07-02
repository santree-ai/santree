/** The per-repo Linear section: which connected org supplies this repo's issues. */

import { ChevronSelect } from "../../../components/primitives";
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
          <button
            type="button"
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
            className="cursor-pointer rounded-md border-none px-3 py-1.5 text-[12px] font-medium text-white transition-[filter] hover:brightness-110 disabled:opacity-60"
            style={{ background: LINEAR_BRAND }}
          >
            {connect.isPending ? "Connecting…" : "Connect"}
          </button>
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
            <button
              type="button"
              onClick={() => setOrg.mutate({ repo, slug: null })}
              className="cursor-pointer rounded-md border border-line-3 bg-input px-3 py-2 text-[11.5px] text-muted hover:border-line-strong hover:text-fg-2"
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </>
  );
}
