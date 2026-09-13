/** A repo's tracker mark — Linear's or Jira's, whichever the repo's tickets come
 *  from. For rows that know their repo but not its provider. */
import { useTicketProvider } from "../lib/queries";
import { TrackerLogo } from "./icons";

export function RepoTrackerLogo({
  repo,
  size,
  className,
  branded,
}: {
  repo: string;
  size?: number;
  className?: string;
  branded?: boolean;
}) {
  const provider = useTicketProvider(repo);
  return <TrackerLogo provider={provider} size={size} className={className} branded={branded} />;
}
