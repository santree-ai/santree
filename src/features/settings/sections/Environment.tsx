/** Settings → Environment: variables (and `.env` file references) santree injects
 *  into every terminal it spawns — triage, worktree agents, the Terminal tab, and
 *  Claude tabs. App scope applies everywhere; a repo scope adds/overrides for that
 *  repo (resolved + merged in the backend, repo winning). See `env.rs`. */

import { useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";

import {
  DocsIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "../../../components/icons";
import { Button } from "../../../components/primitives";
import {
  ENV_FILES_KEY,
  ENV_VARS_KEY,
  type EnvVar,
  queryKeys,
  useEnvFiles,
  useEnvFileVars,
  useEnvVars,
  useSetSetting,
} from "../../../lib/queries";
import { Heading } from "../widgets";

/** Parse a pasted `KEY=VALUE` block (one per line) into variables — the bulk-add
 *  path. Skips blanks/comments, tolerates a leading `export`, and strips one pair
 *  of surrounding quotes from the value. */
function parseBlock(text: string): EnvVar[] {
  const out: EnvVar[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out.push({ name: line.slice(0, eq).trim(), value });
  }
  return out;
}

/** Last-write-wins dedupe by name, preserving order of first appearance. */
function dedupe(vars: EnvVar[]): EnvVar[] {
  const byName = new Map<string, EnvVar>();
  for (const v of vars) byName.set(v.name, v);
  return [...byName.values()];
}

export function EnvironmentSection({ repo }: { repo?: string }) {
  const scope = repo ? `repo:${repo}` : "app";
  return (
    <>
      <Heading
        title="Environment"
        subtitle={
          repo
            ? "Variables for this repo, merged over your app-level ones (repo wins). Injected into every terminal santree starts here."
            : "Variables injected into every terminal santree starts — triage, worktree agents, the Terminal tab, and Claude tabs."
        }
      />
      <div className="space-y-5">
        <VarsCard scope={scope} />
        <EnvFilesCard scope={scope} />
      </div>
    </>
  );
}

function VarsCard({ scope }: { scope: string }) {
  const { vars } = useEnvVars(scope);
  const { mutate: setSetting } = useSetSetting();
  const save = (next: EnvVar[]) =>
    setSetting({ scope, key: ENV_VARS_KEY, value: JSON.stringify(next) });

  // Which row is being edited (by index), or "new" for the add form, or null.
  const [editing, setEditing] = useState<number | "new" | null>(null);
  // Keyed by name, not index: deleting a row shifts the ones below it up, and an
  // index-keyed reveal would then un-mask a different variable's secret.
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const toggleReveal = (name: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const commit = (draft: EnvVar) => {
    if (editing === "new") {
      // A pasted block (newline or `=` in the name) bulk-adds; else a single var.
      const additions =
        draft.name.includes("\n") || draft.name.includes("=") ? parseBlock(draft.name) : [draft];
      if (additions.length) save(dedupe([...vars, ...additions]));
    } else if (typeof editing === "number") {
      save(dedupe(vars.map((v, i) => (i === editing ? draft : v))));
    }
    setEditing(null);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-fg-bright">Variables</div>
          {/* The padlock on each row is a promise, so say what backs it: `env.rs` keeps
              the names in santree's database and the values in the OS keychain. */}
          <div className="mt-[3px] text-[11.5px] text-muted-3">
            Values are stored in your OS keychain, never in santree's database.
          </div>
        </div>
        {editing !== "new" && (
          <Button onClick={() => setEditing("new")}>
            <PlusIcon size={12} />
            Add variable
          </Button>
        )}
      </div>

      {vars.length === 0 && editing !== "new" ? (
        <div className="px-4 py-8 text-center">
          <div className="text-[12.5px] font-medium text-fg-3">No variables set</div>
          <div className="mt-1 text-[11.5px] text-muted-3">
            Add a variable to make it available in every terminal santree starts.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-line">
          {vars.map((v, i) =>
            editing === i ? (
              <VarForm
                key={`edit-${v.name}`}
                initial={v}
                onCancel={() => setEditing(null)}
                onSave={commit}
              />
            ) : (
              <div key={v.name} className="flex items-center gap-3 px-4 py-2.5">
                <LockIcon size={13} className="flex-none text-muted-3" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2">
                  {v.name}
                </span>
                <span className="font-mono text-[11.5px] text-muted-3">
                  {revealed.has(v.name) ? (
                    <span className="max-w-[220px] truncate text-fg-3">{v.value}</span>
                  ) : (
                    "••••••••"
                  )}
                </span>
                <IconBtn
                  label={revealed.has(v.name) ? "Hide value" : "Reveal value"}
                  onClick={() => toggleReveal(v.name)}
                >
                  {revealed.has(v.name) ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                </IconBtn>
                <IconBtn label="Edit variable" onClick={() => setEditing(i)}>
                  <PencilIcon size={13} />
                </IconBtn>
                <IconBtn
                  label="Delete variable"
                  danger
                  onClick={() => save(vars.filter((_, j) => j !== i))}
                >
                  <TrashIcon size={14} />
                </IconBtn>
              </div>
            ),
          )}
          {editing === "new" && <VarForm bulk onCancel={() => setEditing(null)} onSave={commit} />}
        </div>
      )}
    </div>
  );
}

/** The add/edit form for one variable. In `bulk` (add) mode the name field also
 *  accepts a pasted `KEY=VALUE` block to add several at once. */
function VarForm({
  initial,
  bulk = false,
  onCancel,
  onSave,
}: {
  initial?: EnvVar;
  bulk?: boolean;
  onCancel: () => void;
  onSave: (v: EnvVar) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [value, setValue] = useState(initial?.value ?? "");
  const canSave = name.trim().length > 0;
  // Focus the name field when the form opens (avoids the autoFocus a11y warning).
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => nameRef.current?.focus(), []);

  return (
    <div className="space-y-2.5 bg-surface px-4 py-3.5">
      <div>
        <div className="mb-1 text-[11px] font-medium text-muted-2">Name</div>
        <input
          ref={nameRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) onSave({ name: name.trim(), value });
            if (e.key === "Escape") onCancel();
          }}
          placeholder="MY_VARIABLE"
          className="w-full rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[11.5px] text-fg-3 placeholder:text-muted-4"
        />
        {bulk && (
          <div className="mt-1 text-[10.5px] text-muted-4">
            Tip: paste a block of <span className="font-mono">KEY=VALUE</span> lines here to add
            several at once.
          </div>
        )}
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium text-muted-2">Value</div>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={2}
          className="w-full resize-y rounded-lg border border-line-3 bg-input px-[11px] py-2 font-mono text-[11.5px] text-fg-3 placeholder:text-muted-4"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!canSave}
          onClick={() => onSave({ name: name.trim(), value })}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function EnvFilesCard({ scope }: { scope: string }) {
  const { files } = useEnvFiles(scope);
  const { mutate: setSetting, mutateAsync: setSettingAsync } = useSetSetting();
  const qc = useQueryClient();
  const save = (next: string[]) =>
    setSetting({ scope, key: ENV_FILES_KEY, value: JSON.stringify(next) });

  const addFile = async () => {
    const picked = await open({ title: "Select an .env file" });
    if (typeof picked !== "string" || files.includes(picked)) return;
    // The optimistic patch renders the row (and fires its variable-count query)
    // before this write lands — and until it lands the backend won't read a file
    // it hasn't been told about (`env_file_vars` only parses registered paths), so
    // the first count can come back empty. Re-run it once the write is durable.
    // A failed write already toasts itself; the refetch then just reads 0, which
    // is the truth.
    await setSettingAsync({
      scope,
      key: ENV_FILES_KEY,
      value: JSON.stringify([...files, picked]),
    }).catch(() => undefined);
    qc.invalidateQueries({ queryKey: queryKeys.envFileVars(picked) });
  };

  return (
    <div className="overflow-hidden rounded-xl border border-line-2 bg-raised">
      <div className="border-b border-line px-4 py-3">
        <div className="text-[13px] font-semibold text-fg-bright">Env files</div>
        <div className="mt-[3px] text-[11.5px] text-muted-3">
          Load variables from <span className="font-mono">.env</span> files, re-read on each launch.
          In the native picker, press <span className="font-medium text-fg-3">⌘⇧.</span> to show
          hidden files.
        </div>
      </div>

      {files.length > 0 && (
        <div className="divide-y divide-line">
          {files.map((path, i) => (
            <EnvFileRow
              key={path}
              path={path}
              onDelete={() => save(files.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}

      <div className="px-4 py-3">
        <Button onClick={addFile}>
          <PlusIcon size={12} />
          Add env file
        </Button>
      </div>
    </div>
  );
}

function EnvFileRow({ path, onDelete }: { path: string; onDelete: () => void }) {
  const { data: names } = useEnvFileVars(path);
  const count = names?.length ?? 0;
  const base = path.split("/").pop() || path;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <DocsIcon size={14} className="flex-none text-muted-3" />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2" title={path}>
        {base}
      </span>
      <span className="flex-none text-[11px] text-muted-3">
        {count} {count === 1 ? "variable" : "variables"} loaded
      </span>
      <IconBtn label="Remove env file" danger onClick={onDelete}>
        <TrashIcon size={14} />
      </IconBtn>
    </div>
  );
}

/** A small square icon button — the row actions (reveal/edit/delete). */
function IconBtn({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-md text-muted-3 transition-colors hover:bg-hover ${
        danger ? "hover:text-status-red" : "hover:text-fg-2"
      }`}
    >
      {children}
    </button>
  );
}
