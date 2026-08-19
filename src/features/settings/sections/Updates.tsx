/** Settings → Updates: the release channel, and the manual check + install. */
import { Button, Segmented } from "../../../components/primitives";
import {
  parseUpdateChannel,
  UPDATE_CHANNEL_KEY,
  type UpdateChannelSetting,
  useAppVersion,
  useCheckForUpdate,
  useInstallUpdate,
  useSetSetting,
  useSetting,
  useUpdateProgress,
} from "../../../lib/queries";
import { Field, Heading, KvRow } from "../widgets";

const CHANNELS: { value: UpdateChannelSetting; label: string }[] = [
  { value: "stable", label: "Stable" },
  { value: "beta", label: "Beta" },
];

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export function UpdatesSection() {
  const { data: version } = useAppVersion();
  const { data: rawChannel } = useSetting("app", UPDATE_CHANNEL_KEY);
  const channel = parseUpdateChannel(rawChannel);
  const { mutate: setSetting } = useSetSetting();
  const check = useCheckForUpdate();
  const install = useInstallUpdate();
  const progress = useUpdateProgress();

  // `undefined` = never checked this session; `null` = checked, already current.
  const update = check.data;
  // f64 crosses the bridge as `number | null` (JSON carries no NaN/Infinity), so
  // both fields need a floor before any arithmetic — same as the usage totals.
  const downloaded = progress?.downloaded ?? 0;
  const percent = progress?.total ? Math.round((downloaded / progress.total) * 100) : null;

  return (
    <>
      <Heading title="Updates" subtitle="How santree updates itself." />

      <div className="mb-3.5 rounded-xl border border-line-2 bg-raised px-4 py-0.5">
        <Field
          label="Release channel"
          hint="Beta gets every release as soon as it builds. Switching back to Stable takes effect once a stable release passes the beta you're on — updates only ever move forward."
        >
          <Segmented<UpdateChannelSetting>
            options={CHANNELS}
            value={channel}
            onChange={(value) => {
              // Drop the previous answer with the channel that produced it: the
              // backend re-checks against the new manifest, and a stale "update
              // available" here would offer a version the other channel serves.
              check.reset();
              setSetting({ scope: "app", key: UPDATE_CHANNEL_KEY, value });
            }}
          />
        </Field>
      </div>

      <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
        <div className="px-1 pt-0.5">
          <KvRow label="Version" value={version ? `${version} (${channel})` : "…"} />
        </div>

        <div className="flex items-center gap-3 border-t border-line px-4 py-3">
          <div className="min-w-0 flex-1 text-[12px] text-muted-3">
            {install.isPending
              ? percent !== null
                ? `Downloading… ${percent}%`
                : progress
                  ? `Downloading… ${mb(downloaded)}`
                  : "Starting the download…"
              : update
                ? `Version ${update.version} is available.`
                : update === null
                  ? "santree is up to date."
                  : "Check whether a newer version has been released."}
          </div>
          {update ? (
            <Button
              variant="primary"
              onClick={() => install.mutate(undefined, { onError: () => check.reset() })}
              disabled={install.isPending}
            >
              {install.isPending ? "Installing…" : "Install and restart"}
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => check.mutate()}
              disabled={check.isPending || install.isPending}
            >
              {check.isPending ? "Checking…" : "Check for updates"}
            </Button>
          )}
        </div>

        {install.isPending && (
          <div className="h-[3px] w-full bg-line">
            <div
              className="h-full bg-accent transition-[width] duration-200"
              // Indeterminate (no content-length) reads as a full bar rather than
              // an empty one, which looks like nothing is happening.
              style={{ width: percent === null ? "100%" : `${percent}%` }}
            />
          </div>
        )}

        {update?.notes && !install.isPending && (
          <div className="max-h-[220px] overflow-y-auto border-t border-line bg-surface px-4 py-3">
            <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-muted-3 uppercase">
              What's new
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-[1.55] text-fg-3">
              {update.notes}
            </pre>
          </div>
        )}
      </div>
    </>
  );
}
