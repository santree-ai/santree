/**
 * What Reviews shows when `gh` has no token.
 *
 * Both reads behind this tab degrade to empty without one — the inbox returns no
 * PRs, the merge queue returns no queue — so a broken auth state rendered exactly
 * like a quiet morning with nothing to review. This is the difference, said out
 * loud, and it points at the one place the app already signs `gh` in: Settings →
 * Integrations → GitHub, which hosts the `gh auth login` terminal.
 *
 * `onOpenSettings` is optional so the pure sidebar render stays testable without a
 * router (the same reason `onOpenMergeQueue` is optional there); without it the
 * state still names the problem, it just can't offer the jump.
 */
import { GitHubLogo } from "../../components/icons";
import { Button, EmptyState } from "../../components/primitives";

export function GitHubNotConnected({ onOpenSettings }: { onOpenSettings?: () => void }) {
  return (
    <EmptyState
      icon={<GitHubLogo size={18} className="text-muted-4" />}
      title="GitHub isn't connected"
      subtitle={
        <>
          santree reads pull requests through the <span className="font-mono">gh</span> CLI, which
          isn't signed in — so this is what it couldn't ask, not what it found.
          {onOpenSettings && (
            <div className="mt-2.5 flex justify-center">
              <Button size="sm" onClick={onOpenSettings}>
                Connect GitHub
              </Button>
            </div>
          )}
        </>
      }
    />
  );
}
