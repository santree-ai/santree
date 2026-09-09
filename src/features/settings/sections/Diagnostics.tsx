/** Settings → General → Diagnostics: turn "it broke" into one file to send.
 *
 *  santree's logs live in two directories and there can be several of them, so
 *  the alternative to this button is talking someone through Finder before the
 *  report can even start. One press writes the lot — plus the version and OS a
 *  report has to state — into the download folder, and the path stays on screen
 *  afterwards so the file can actually be found and attached.
 *
 *  The folder is not a choice: the backend resolves it (see `export_logs`),
 *  because a destination sent from here would be an IPC-borne write path with
 *  nothing to validate it against. */
import { useState } from "react";

import { CopyIcon } from "../../../components/icons";
import { copyText } from "../../../components/menuRows";
import { Button, Spinner } from "../../../components/primitives";
import { useExportLogs } from "../../../lib/queries";
import { CardRow } from "../widgets";

/** Bytes as something a person can read, so the row says whether the export is
 *  a snippet or an attachment before they try to send it. */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DiagnosticsSection() {
  const { mutate: exportLogs, isPending } = useExportLogs();
  // Held rather than derived from the mutation so the path survives a re-render
  // and stays readable after the toast has gone.
  const [saved, setSaved] = useState<{ path: string; bytes: number; count: number } | null>(null);

  return (
    <div className="rounded-xl border border-line-2 bg-raised">
      <CardRow
        label="Export logs"
        hint="Writes santree's logs, its version and your OS into one text file in your downloads folder — attach it to a bug report. It contains project and branch names, ticket ids and file paths, so read it before sharing it outside your team."
      >
        {(labelId) => (
          <Button
            aria-labelledby={labelId}
            disabled={isPending}
            onClick={() =>
              exportLogs(undefined, {
                onSuccess: (result) =>
                  setSaved({
                    path: result.path,
                    // `?? 0`: the count is `f64` because specta cannot export a
                    // 64-bit integer, and every such field arrives as `number | null`.
                    bytes: result.bytes ?? 0,
                    count: result.files.length,
                  }),
              })
            }
          >
            {isPending ? <Spinner size={12} /> : "Export logs"}
          </Button>
        )}
      </CardRow>
      {saved && (
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-[11px] text-fg-3" title={saved.path}>
              {saved.path}
            </div>
            <div className="mt-[3px] text-[11px] text-muted-3">
              {saved.count} log{saved.count === 1 ? "" : "s"} · {sizeLabel(saved.bytes)}
            </div>
          </div>
          <Button size="sm" onClick={() => copyText(saved.path, "Path")}>
            <CopyIcon size={12} />
            <span className="ml-1.5">Copy path</span>
          </Button>
        </div>
      )}
    </div>
  );
}
