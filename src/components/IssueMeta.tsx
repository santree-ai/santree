/**
 * A ticket's meta, under its title: who filed it and when, then its properties
 * the way Linear lists them ({@link IssueProperties}).
 *
 * One row for both hosts of a ticket's detail, the rail's `IssuePane` and the
 * page's `IssueHeader`. They had drifted into two copies of the same markup,
 * each missing a field the other had, which is the drift a shared row exists to
 * end. `dense` is the rail's register: a size down, a smaller avatar, so the row
 * keeps to its column.
 */
import type { TriageDetail } from "../bindings";
import { Avatar } from "./Avatar";
import { factsOfDetail, IssueProperties } from "./IssueProperties";
import { RelativeTime } from "./RelativeTime";

export function IssueMeta({
  detail,
  dense = false,
  withoutPriority = false,
  className = "",
}: {
  detail: TriageDetail;
  dense?: boolean;
  /** The host's own header already carries the priority. */
  withoutPriority?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div
        className={`flex items-center gap-1.5 ${dense ? "text-[10.5px]" : "text-[11px]"} text-muted-3`}
      >
        <Avatar name={detail.author} src={detail.authorAvatarUrl} size={dense ? 15 : 17} />
        {detail.author}
        <span className="text-muted-5">·</span>
        <RelativeTime ms={detail.createdAtMs} />
      </div>
      <IssueProperties
        facts={factsOfDetail(detail)}
        dense={dense}
        withoutPriority={withoutPriority}
      />
    </div>
  );
}
