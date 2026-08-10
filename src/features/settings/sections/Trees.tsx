/** The worktree half of Settings → Work: setup + commit preferences, and the
 *  per-repo `.santree/init.sh` setup-script editor (with bash syntax
 *  highlighting). There is no "Trees" settings pane — these cards render inside
 *  Work (see `Work.tsx`), and the legacy `?section=trees` deep-link resolves
 *  there. The persisted keys keep their `trees_*` names (they're stored values,
 *  not UI labels). */

import { type ReactNode, useEffect, useState } from "react";
import EditorImport from "react-simple-code-editor";

// react-simple-code-editor is CJS (`exports.default`); depending on how Vite's
// dep pre-bundle interops it, the default import can arrive as the module
// namespace ({ default: Editor }) rather than the component. Unwrap defensively.
const Editor = ((EditorImport as unknown as { default?: typeof EditorImport }).default ??
  EditorImport) as typeof EditorImport;

import { ChevronDownIcon } from "../../../components/icons";
import { Button, ChevronSelect, Segmented } from "../../../components/primitives";
import {
  type BatchSetup,
  COMMIT_MESSAGE_MODEL_KEY,
  DEFAULT_HELPER_MODEL,
  PR_BODY_MODEL_KEY,
  TREES_AUTO_PR_KEY,
  TREES_AUTO_PUSH_KEY,
  TREES_BATCH_SETUP_KEY,
  TREES_DEFAULT_EDITOR_KEY,
  TREES_DIFF_MODE_KEY,
  TREES_RUN_SETUP_KEY,
  TREES_STAGE_ALL_KEY,
  useBoolSetting,
  useInitScript,
  useMakeInitExecutable,
  useOpeners,
  useResolvedBoolSetting,
  useResolvedSetting,
  useSetInitScript,
  useSetSetting,
  useSetting,
} from "../../../lib/queries";
import { highlightShell } from "../shellHighlight";
import { Field, HeadlessModelField, SELECT_CLASS, ToggleRow } from "../widgets";

const STARTER_SCRIPT = `#!/usr/bin/env bash
# Runs in a new worktree right after it's created.
# Available env: $SANTREE_WORKTREE_PATH, $SANTREE_REPO_ROOT

`;

/** A card-wrapped group of fields. */
function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">{children}</div>;
}

/** A boolean preference rendered as a toggle row — app defaults, or (when
 *  `forRepo` is set) a per-repo override that falls back to the app value. */
export function BoolToggle({
  settingKey,
  label,
  hint,
  forRepo,
}: {
  settingKey: string;
  label: string;
  hint?: ReactNode;
  forRepo?: string;
}) {
  const scope = forRepo ? `repo:${forRepo}` : "app";
  const appValue = useBoolSetting("app", settingKey).value;
  const resolvedValue = useResolvedBoolSetting(forRepo ?? "", settingKey).value;
  const value = forRepo ? resolvedValue : appValue;
  const { mutate: setSetting } = useSetSetting();
  return (
    <ToggleRow
      label={label}
      hint={hint}
      on={value}
      onChange={(next) => setSetting({ scope, key: settingKey, value: next ? "true" : "false" })}
    />
  );
}

const BATCH_OPTIONS: { value: BatchSetup; label: string }[] = [
  { value: "always", label: "Always run" },
  { value: "ask", label: "Ask once" },
  { value: "never", label: "Never" },
];

type DiffMode = "split" | "unified";
const DIFF_OPTIONS: { value: DiffMode; label: string }[] = [
  { value: "split", label: "Split" },
  { value: "unified", label: "Unified" },
];

/** The worktree setup + commit preferences and the per-repo setup-script editor.
 *  Heading-less — rendered under the merged "Work" settings section. App
 *  defaults, or (when `forRepo` is set) per-repo overrides — the same scope
 *  convention as the Work action config it sits beside. */
export function WorktreeSettings({ repo, forRepo }: { repo: string; forRepo?: string }) {
  const scope = forRepo ? `repo:${forRepo}` : "app";
  const { data: appBatch } = useSetting("app", TREES_BATCH_SETUP_KEY);
  const { data: resolvedBatch } = useResolvedSetting(forRepo ?? "", TREES_BATCH_SETUP_KEY);
  const batch = forRepo ? resolvedBatch : appBatch;
  const { data: appDiffMode } = useSetting("app", TREES_DIFF_MODE_KEY);
  const { data: resolvedDiffMode } = useResolvedSetting(forRepo ?? "", TREES_DIFF_MODE_KEY);
  const diffMode = forRepo ? resolvedDiffMode : appDiffMode;
  const { data: appDefaultEditor } = useSetting("app", TREES_DEFAULT_EDITOR_KEY);
  const { data: resolvedDefaultEditor } = useResolvedSetting(
    forRepo ?? "",
    TREES_DEFAULT_EDITOR_KEY,
  );
  const defaultEditor = forRepo ? resolvedDefaultEditor : appDefaultEditor;
  const { data: openers = [] } = useOpeners();
  const { mutate: setSetting } = useSetSetting();

  const firstEditor =
    openers.find((o) => o.available && o.key !== "finder" && o.key !== "terminal")?.key ?? "finder";
  const effectiveEditor = defaultEditor || firstEditor;

  return (
    <>
      <Card>
        <div className="pt-2.5 pb-0.5">
          <div className="text-[13px] font-semibold text-fg-bright">Scripts</div>
          <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
            The setup that runs when a worktree is created, and how batches behave.
          </div>
        </div>
        <BoolToggle
          settingKey={TREES_RUN_SETUP_KEY}
          label="Run setup on new worktrees"
          hint="Run .santree/init.sh automatically right after creating a worktree."
          forRepo={forRepo}
        />
        <Field
          label="When starting several tasks at once"
          hint="Avoid being asked per-task when sending multiple issues to agents together."
        >
          <Segmented<BatchSetup>
            options={BATCH_OPTIONS}
            value={(batch as BatchSetup) ?? "ask"}
            onChange={(value) => setSetting({ scope, key: TREES_BATCH_SETUP_KEY, value })}
          />
        </Field>
        <SetupScriptField repo={repo} />
      </Card>

      <Card>
        <BoolToggle
          settingKey={TREES_STAGE_ALL_KEY}
          label="Stage all files before committing"
          hint="Stage every change automatically instead of asking for confirmation."
          forRepo={forRepo}
        />
        <BoolToggle
          settingKey={TREES_AUTO_PUSH_KEY}
          label="Push to origin after every commit"
          hint="Automatically push the branch to its remote right after committing (sets upstream on the first push)."
          forRepo={forRepo}
        />
        <BoolToggle
          settingKey={TREES_AUTO_PR_KEY}
          label="Open the PR dialog after a commit"
          hint="When a worktree has a commit and no PR yet, automatically open the create-PR dialog after committing. Requires the GitHub CLI (gh) to be authenticated."
          forRepo={forRepo}
        />
      </Card>

      <Card>
        <div className="pt-2.5 pb-0.5">
          <div className="text-[13px] font-semibold text-fg-bright">AI drafts</div>
          <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
            The models behind the ✨ commit message and the PR description. Edit what they're asked
            in Settings → Prompts.
          </div>
        </div>
        <HeadlessModelField
          label="Commit message"
          hint="Writes a subject line from the staged diff. The cheap tier is genuinely enough here — it's a one-line summary of a capped diff."
          settingKey={COMMIT_MESSAGE_MODEL_KEY}
          defaultModel={DEFAULT_HELPER_MODEL}
          forRepo={forRepo}
        />
        <HeadlessModelField
          label="PR description"
          hint="Fills the PR body from the diff, the ticket, and (optionally) the worktree's session transcripts. Worth a stronger model on a large PR — there's real reading to do."
          settingKey={PR_BODY_MODEL_KEY}
          defaultModel={DEFAULT_HELPER_MODEL}
          forRepo={forRepo}
        />
      </Card>

      <Card>
        <Field
          label="Default editor"
          hint="The app the worktree's “Open in” button opens by default."
        >
          <ChevronSelect
            className={SELECT_CLASS}
            value={effectiveEditor}
            onChange={(v) => setSetting({ scope, key: TREES_DEFAULT_EDITOR_KEY, value: v })}
          >
            {openers.map((o) => (
              <option key={o.key} value={o.key} disabled={!o.available} className="bg-input">
                {o.label}
                {o.available ? "" : " — not installed"}
              </option>
            ))}
          </ChevronSelect>
        </Field>
        <Field label="Diff layout" hint="How file diffs are shown in the Trees diff panel.">
          <Segmented<DiffMode>
            options={DIFF_OPTIONS}
            value={(diffMode as DiffMode) ?? "split"}
            onChange={(value) => setSetting({ scope, key: TREES_DIFF_MODE_KEY, value })}
          />
        </Field>
      </Card>
    </>
  );
}

/** The `.santree/init.sh` editor, collapsed by default inside the Scripts card —
 *  click the row to expand the editor. */
function SetupScriptField({ repo }: { repo: string }) {
  const [open, setOpen] = useState(false);
  const { data: script } = useInitScript(repo);
  const { mutate: save, isPending: saving } = useSetInitScript(repo);
  const { mutate: makeExecutable, isPending: chmodding } = useMakeInitExecutable(repo);

  // Local draft: null means "showing the saved content as-is".
  const [draft, setDraft] = useState<string | null>(null);
  // Reset the draft when switching repos so we don't carry one repo's edits over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on repo change.
  useEffect(() => setDraft(null), [repo]);

  const base = script?.exists ? script.content : STARTER_SCRIPT;
  const value = draft ?? base;
  // No script yet: the starter template itself is a valid save, so "Create
  // script" must be clickable even with zero edits.
  const dirty = !script?.exists || (draft !== null && draft !== base);
  const needsChmod = !!script?.exists && !script.executable;

  // Drop the draft only once the write lands: on failure the optimistic rollback
  // restores the saved script, so clearing it eagerly would destroy the edit the
  // user is about to retry.
  const onSave = () => {
    save(value, { onSuccess: () => setDraft(null) });
  };

  return (
    <div className="border-t border-line py-3.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center gap-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-fg-3">Setup script</div>
          <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
            <code className="text-fg-3">.santree/init.sh</code> — runs in each new worktree.
            {needsChmod && !open && <span className="text-status-amber"> · not executable</span>}
          </div>
        </div>
        <span className="flex flex-none items-center gap-1 text-[11px] text-muted-2">
          {open ? "Hide" : script?.exists ? "Edit" : "Create"}
          <ChevronDownIcon size={11} className={open ? "" : "-rotate-90"} />
        </span>
      </button>

      {open &&
        (repo ? (
          <SetupScriptBody
            value={value}
            onValueChange={setDraft}
            onSave={onSave}
            dirty={dirty}
            saving={saving}
            exists={!!script?.exists}
            needsChmod={needsChmod}
            makeExecutable={makeExecutable}
            chmodding={chmodding}
          />
        ) : (
          <div className="mt-3 text-[12px] text-muted-3">
            Add a repository to configure its setup script.
          </div>
        ))}
    </div>
  );
}

/** The expanded editor body of {@link SetupScriptField}. */
function SetupScriptBody({
  value,
  onValueChange,
  onSave,
  dirty,
  saving,
  exists,
  needsChmod,
  makeExecutable,
  chmodding,
}: {
  value: string;
  onValueChange: (v: string) => void;
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
  exists: boolean;
  needsChmod: boolean;
  makeExecutable: () => void;
  chmodding: boolean;
}) {
  return (
    <div className="mt-3">
      {needsChmod && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-status-amber/40 bg-status-amber/10 px-3 py-2.5">
          <div className="min-w-0 flex-1 text-[11.5px] text-fg-3">
            This script isn't executable, so it won't run when a worktree is created.
          </div>
          <Button onClick={() => makeExecutable()} disabled={chmodding} className="flex-none">
            Make executable
          </Button>
        </div>
      )}

      <div className="shell-editor overflow-hidden rounded-lg border border-line-3 bg-input">
        <Editor
          value={value}
          onValueChange={onValueChange}
          highlight={highlightShell}
          padding={12}
          style={{
            fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
            fontSize: 12.5,
            lineHeight: 1.6,
            minHeight: 200,
            color: "var(--color-fg-2)",
          }}
        />
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="primary" onClick={onSave} disabled={!dirty || saving}>
          {exists ? "Save" : "Create script"}
        </Button>
      </div>
    </div>
  );
}
