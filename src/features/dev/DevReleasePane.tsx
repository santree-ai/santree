/**
 * The Dev tab's **Release** pane: pick the next version, write the changelog
 * entry, and cut the release — bumping the four files that declare the version,
 * committing just those, tagging, and pushing the tag, which is what starts the
 * signed and notarized build in CI.
 *
 * Everything the release guard would reject is shown *before* the button rather
 * than discovered in a failed workflow run: versions that disagree across the
 * files, a stable version with no changelog entry, a tag that already exists.
 * The backend re-checks all of it and refuses before writing anything, so this
 * is a shortcut to the answer, not the enforcement.
 *
 * The tag is the channel — `v0.2.0` is stable and moves `releases/latest` (which
 * the website's download button resolves through), `v0.2.0-beta.N` publishes as
 * a pre-release that pointer skips.
 */
import { useState } from "react";

import type { DevVersion } from "../../bindings";
import { WarningIcon } from "../../components/icons";
import { Button, ConfirmDialog, Spinner } from "../../components/primitives";
import { useDevRelease, useDevVersion } from "../../lib/queries";
import { alpha, palette } from "../../theme/colors";

/** Is this version a beta? Same rule the release workflow splits channels on. */
const isBeta = (version: string) => version.includes("-beta.");

export function DevReleasePane({ repoPath }: { repoPath: string }) {
  const { data: info, isLoading } = useDevVersion(repoPath);

  if (isLoading || !info) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  // Keyed on the declared version so a finished release resets the form to the
  // next set of choices rather than leaving stale notes in the box.
  return <ReleaseForm key={info.current} repoPath={repoPath} info={info} />;
}

function ReleaseForm({ repoPath, info }: { repoPath: string; info: DevVersion }) {
  const choices = [
    { value: info.next.beta, label: "Beta" },
    { value: info.next.release, label: isBeta(info.current) ? "Finish beta" : "Patch" },
    { value: info.next.minor, label: "Minor" },
    { value: info.next.major, label: "Major" },
  ];
  const [version, setVersion] = useState(choices[0].value);
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);
  const { mutateAsync: release, isPending } = useDevRelease(repoPath);

  const beta = isBeta(version);
  const hasEntry = info.changelogVersions.includes(version);
  // The guard fails a *stable* tag with no `## <version>` section, since that
  // section becomes the release body and the in-app "What's new". A beta without
  // one falls back to a commit-compare link.
  const needsNotes = !beta && !hasEntry && notes.trim() === "";
  const blocked = info.mismatched.length > 0 || needsNotes;

  // A version already tagged can't be released again; surfaced here so the
  // choice reads as unavailable rather than failing on the button.
  const alreadyTagged = info.latestTag === `v${version}`;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[640px] flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[11.5px] text-muted-3">
          <span>
            Declared <span className="font-mono text-fg-2">{info.current}</span>
          </span>
          <span>
            Latest tag <span className="font-mono text-fg-2">{info.latestTag ?? "none"}</span>
          </span>
          <span>
            Branch <span className="font-mono text-fg-2">{info.branch || "—"}</span>
          </span>
          {info.dirtyFiles > 0 && (
            <span className="font-mono" style={{ color: palette.amber }}>
              {info.dirtyFiles} uncommitted
            </span>
          )}
        </div>

        {info.mismatched.length > 0 && (
          <div
            className="flex gap-2 rounded-lg border px-3 py-2 text-[11.5px] text-fg-3"
            style={{
              borderColor: alpha(35, palette.amber),
              background: alpha(10, palette.amber),
            }}
          >
            <WarningIcon size={13} className="mt-0.5 flex-none" />
            <span>
              {info.mismatched.join(" and ")} {info.mismatched.length > 1 ? "declare" : "declares"}{" "}
              a different version from package.json. The release guard fails any tag while they
              disagree. Releasing from here rewrites all four to match, but it's worth knowing why
              they drifted.
            </span>
          </div>
        )}

        <div>
          <Label>Next version</Label>
          <div className="flex flex-wrap gap-2">
            {choices.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setVersion(c.value)}
                className={`flex cursor-pointer flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors ${
                  version === c.value
                    ? "border-accent bg-accent-fill/10"
                    : "border-line-2 hover:border-line-strong"
                }`}
              >
                <span className="font-mono text-[12px] text-fg-2">{c.value}</span>
                <span className="text-[10px] text-muted-4">{c.label}</span>
              </button>
            ))}
          </div>
          <input
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            spellCheck={false}
            aria-label="Version to release"
            className="mt-2 w-full rounded-md border border-line-2 bg-input px-2.5 py-1.5 font-mono text-[12px] text-fg-3 outline-none focus:border-line-strong"
          />
          <p className="mt-1.5 text-[10.5px] text-muted-4">
            {beta
              ? "Beta: published as a pre-release, so releases/latest skips it and the website's download button doesn't move."
              : "Stable: moves releases/latest, which is what the website's download button resolves through."}
          </p>
        </div>

        <div>
          <Label>
            CHANGELOG · <span className="font-mono">## {version}</span>
          </Label>
          {hasEntry ? (
            <p className="text-[11.5px] text-muted-3">
              Already written. The existing section is kept as-is.
            </p>
          ) : (
            <>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={6}
                placeholder={
                  "- What changed, for users.\n- Plain bullets: the app renders them as text."
                }
                className="w-full resize-y rounded-lg border border-line-2 bg-input px-2.5 py-2 font-mono text-[11.5px] leading-[1.6] text-fg-3 outline-none placeholder:text-muted-4 focus:border-line-strong"
              />
              <p className="mt-1.5 text-[10.5px] text-muted-4">
                {beta
                  ? "Optional for a beta: without one the release notes fall back to a commit-compare link."
                  : "Required for a stable release: this section becomes the release body and the in-app “What's new”."}
              </p>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line pt-4">
          <Button
            variant="primary"
            disabled={blocked || alreadyTagged || isPending}
            onClick={() => setConfirming(true)}
          >
            {isPending ? "Releasing…" : `Release ${version}`}
          </Button>
          <span className="text-[10.5px] text-muted-4">
            {alreadyTagged
              ? `v${version} is already tagged.`
              : needsNotes
                ? "A stable release needs changelog notes."
                : "Writes 4 files, commits them, tags, and pushes. CI builds and publishes."}
          </span>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        title={`Release ${version}?`}
        message={
          <>
            This pushes <span className="font-mono">v{version}</span> to origin, which starts the
            signed, notarized build and publishes it on the{" "}
            <strong>{beta ? "beta" : "stable"}</strong> channel. Installed apps update themselves
            from it, and a published release can't be quietly taken back.
          </>
        }
        confirmLabel={`Push v${version}`}
        busyLabel="Releasing…"
        danger
        onConfirm={() => release({ version, notes })}
        onClose={() => setConfirming(false)}
      />
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 font-mono text-[9.5px] tracking-[.06em] text-muted-4 uppercase">
      {children}
    </div>
  );
}
