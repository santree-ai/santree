/**
 * "Tell santree where this CLI is" — the escape hatch for installs discovery
 * can't see.
 *
 * santree resolves CLIs by asking a login shell, which is the only way a
 * Finder-launched app can see the PATH a terminal has. But a *non-interactive*
 * login shell never reads `.zshrc` / `/etc/zshrc`, and that's exactly where some
 * package managers (Nix, notably) put their PATH setup — so a perfectly good,
 * authenticated `gh` can read as "not installed". Detection now falls back to
 * probing known roots, and this field covers whatever's left: a wrapper script, an
 * unusual prefix, or two copies where you want a specific one.
 */

import { useEffect, useState } from "react";

import { CheckIcon, WarningIcon } from "../../components/icons";
import { Button, Spinner } from "../../components/primitives";
import { useBinaryStatus, useSetBinaryPath } from "../../lib/queries";

export function BinaryPathField({ name, hint }: { name: string; hint?: string }) {
  const { data: status, isLoading } = useBinaryStatus(name);
  const { mutate: save, isPending } = useSetBinaryPath(name);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Adopt the stored value once it arrives, but never clobber an edit in flight.
  const stored = status?.overridePath ?? "";
  useEffect(() => {
    setDraft((d) => (d === null ? stored : d));
  }, [stored]);
  const value = draft ?? stored;

  const submit = (next: string | null) => {
    setError(null);
    save(next, {
      onSuccess: (s) => setDraft(s.overridePath ?? ""),
      // Inline, beside the field that produced it — a path the backend rejected is
      // about *this input*, and a corner toast makes the user hunt for the reason.
      onError: (e: Error) => setError(e.message),
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 text-[11.5px] text-muted-3">
        <Spinner size={10} /> Looking for {name}…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
      <label className="text-[11.5px] text-muted-3" htmlFor={`binpath-${name}`}>
        Path to <span className="font-mono text-fg-3">{name}</span>
        {hint && <span className="text-muted-4"> — {hint}</span>}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={`binpath-${name}`}
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={status?.path ?? `/absolute/path/to/${name}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(value.trim() || null);
          }}
          className="min-w-[220px] flex-1 rounded-lg border border-line-3 bg-input px-[11px] py-1.5 font-mono text-[11.5px] text-fg-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]"
        />
        <Button size="sm" disabled={isPending} onClick={() => submit(value.trim() || null)}>
          {isPending ? <Spinner size={10} /> : null}
          Use this
        </Button>
        {status?.overridePath && (
          <Button
            size="sm"
            variant="ghost"
            disabled={isPending}
            onClick={() => {
              setDraft("");
              submit(null);
            }}
            title="Go back to finding it automatically"
          >
            Clear
          </Button>
        )}
      </div>

      {error ? (
        <div className="flex items-start gap-1.5 text-[11.5px] text-status-amber">
          <WarningIcon size={12} className="mt-px flex-none" />
          {error}
        </div>
      ) : status?.path ? (
        <div className="flex items-start gap-1.5 text-[11.5px] text-muted-3">
          <CheckIcon size={12} className="mt-px flex-none text-status-green" />
          <span>
            Using <span className="font-mono text-fg-3">{status.path}</span>
            {/* The version is the proof it's the right binary — a path can be
                valid, executable, and still the wrong program. */}
            {status.version && <span className="text-muted-4"> · {status.version}</span>}
            {!status.version && (
              <span className="text-muted-4"> · it didn't report a --version</span>
            )}
          </span>
        </div>
      ) : null}
    </div>
  );
}
