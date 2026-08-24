/** Settings → Prompts: a full-pane composer for the prompts shared by every
 *  provider and workflow.
 *
 *  Left: a workflow-grouped library rail plus Shared blocks (reusable partials —
 *  the built-in Issue context plus any you create). Right: a side-by-side editor
 *  + live preview. Prompts are minijinja templates — reference
 *  `{{ variables }}`, branch with `{% if %}`/`{% for %}`, and embed another prompt
 *  with `{% include "name" %}`. Overrides are per app (User scope) or per repo. */

import { type ReactNode, useEffect, useRef, useState } from "react";
import EditorImport from "react-simple-code-editor";

import { useEdgeResize } from "../../../lib/useEdgeResize";

// react-simple-code-editor is CJS (`exports.default`); depending on how Vite's
// dep pre-bundle interops it, the default import can arrive as the module
// namespace ({ default: Editor }) rather than the component. Unwrap defensively.
const Editor = ((EditorImport as unknown as { default?: typeof EditorImport }).default ??
  EditorImport) as typeof EditorImport;

import type { PromptInfo } from "../../../bindings";
import { PlusIcon, TrashIcon } from "../../../components/icons";
import { Badge, Button, ChevronSelect, EdgeResizeHandle } from "../../../components/primitives";
import {
  useCreatePromptBlock,
  useDeletePromptBlock,
  usePreviewPrompt,
  usePrompts,
  useSetPrompt,
  useTasks,
  useTriageDetail,
} from "../../../lib/queries";
import { highlightJinja, highlightRendered } from "../jinjaHighlight";

const EDITOR_STYLE = {
  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  fontSize: 12.5,
  lineHeight: 1.6,
  minHeight: "100%",
  color: "var(--color-fg-2)",
} as const;

// Live preview pane width (px), dragged via the divider between editor and
// preview. Session-only — resets to DEFAULT on app relaunch.
const PREVIEW_MIN = 320;
const PREVIEW_MAX = 900;
const PREVIEW_DEFAULT = 480;

const FLOW_GROUPS = [
  { title: "Triage", names: ["triage"] },
  { title: "Work", names: ["work", "fill-commit", "fill-pr"] },
  { title: "Reviews", names: ["pr-review", "fix-ci"] },
  { title: "English tutor", names: ["english-tutor", "english-analysis"] },
] as const;

/** Debounce a value so the preview doesn't refetch on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function PromptsSection({ repo, forRepo }: { repo: string; forRepo: boolean }) {
  const scope = forRepo ? `repo:${repo}` : "app";
  const { data: prompts } = usePrompts(scope);
  // App-scope overrides are what a repo with no override inherits — fetch them so
  // the Repo editor edits from the real inherited value. (When scope is "app" this
  // is the same query, deduped by React Query.)
  const { data: appPrompts } = usePrompts("app");
  const [selected, setSelected] = useState<string>("work");
  const [creating, setCreating] = useState(false);
  // Held here (not in PromptEditor, which is keyed per-prompt and remounts) so the
  // dragged preview width survives switching between prompts.
  const [previewWidth, setPreviewWidth] = useState(PREVIEW_DEFAULT);

  const flows = prompts?.filter((p) => p.kind === "flow") ?? [];
  const blocks = prompts?.filter((p) => p.kind === "block") ?? [];
  const groupedFlowNames = new Set<string>(FLOW_GROUPS.flatMap((group) => [...group.names]));
  const otherFlows = flows.filter((prompt) => !groupedFlowNames.has(prompt.name));
  const current = prompts?.find((p) => p.name === selected);

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="flex w-[212px] flex-none flex-col gap-4 overflow-y-auto border-r border-line bg-raised/30 py-4">
        {FLOW_GROUPS.map((group) => (
          <RailGroup
            key={group.title}
            title={group.title}
            items={group.names
              .map((name) => flows.find((prompt) => prompt.name === name))
              .filter((prompt): prompt is PromptInfo => prompt !== undefined)}
            selected={creating ? null : selected}
            onSelect={(n) => {
              setCreating(false);
              setSelected(n);
            }}
          />
        ))}
        {otherFlows.length > 0 && (
          <RailGroup
            title="Other"
            items={otherFlows}
            selected={creating ? null : selected}
            onSelect={(n) => {
              setCreating(false);
              setSelected(n);
            }}
          />
        )}
        <div className="border-t border-line pt-4">
          <RailGroup
            title="Shared blocks"
            items={blocks}
            selected={creating ? null : selected}
            onSelect={(n) => {
              setCreating(false);
              setSelected(n);
            }}
          />
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="mx-2 mt-1 flex w-[calc(100%-16px)] cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-[7px] text-left text-[12px] text-muted-2 hover:bg-hover hover:text-fg-2"
          >
            <PlusIcon size={12} /> New block
          </button>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {creating ? (
          <NewBlockForm
            existing={prompts ?? []}
            onCancel={() => setCreating(false)}
            onCreated={(name) => {
              setCreating(false);
              setSelected(name);
            }}
          />
        ) : current ? (
          <PromptEditor
            key={`${scope}:${current.name}`}
            prompt={current}
            appPrompt={appPrompts?.find((a) => a.name === current.name)}
            scope={scope}
            forRepo={forRepo}
            repo={repo}
            previewWidth={previewWidth}
            onPreviewWidth={setPreviewWidth}
            onDeleted={() => setSelected("work")}
          />
        ) : (
          <div className="p-8 text-[12px] text-muted-3">Loading prompts…</div>
        )}
      </div>
    </div>
  );
}

function RailGroup({
  title,
  items,
  selected,
  onSelect,
  children,
}: {
  title: string;
  items: PromptInfo[];
  selected: string | null;
  onSelect: (name: string) => void;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 px-4 font-mono text-[10px] tracking-[.07em] text-muted-4 uppercase">
        {title}
      </div>
      {items.map((p) => {
        const active = p.name === selected;
        return (
          <button
            key={p.name}
            type="button"
            onClick={() => onSelect(p.name)}
            className={`mx-2 flex w-[calc(100%-16px)] cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] text-left text-[12.5px] hover:bg-hover ${
              active ? "bg-hover text-fg-bright" : "text-fg-3"
            }`}
            style={active ? { boxShadow: "inset 2px 0 0 var(--accent)" } : undefined}
          >
            <span className="min-w-0 flex-1 truncate">{p.label}</span>
            {p.overrideSource !== null && (
              <span
                className="h-1.5 w-1.5 flex-none rounded-full"
                style={{ background: "var(--accent)" }}
                title="Overridden in this scope"
              />
            )}
          </button>
        );
      })}
      {children}
    </div>
  );
}

function PromptEditor({
  prompt,
  appPrompt,
  scope,
  forRepo,
  repo,
  previewWidth,
  onPreviewWidth,
  onDeleted,
}: {
  prompt: PromptInfo;
  appPrompt: PromptInfo | undefined;
  scope: string;
  forRepo: boolean;
  repo: string;
  previewWidth: number;
  onPreviewWidth: (w: number) => void;
  onDeleted: () => void;
}) {
  const { mutate: setPrompt, isPending } = useSetPrompt(scope);
  const { mutate: deleteBlock } = useDeletePromptBlock();

  // What this scope inherits when it has no override of its own: the app override
  // (repo scope) or the built-in default (app scope). Custom blocks have no
  // embedded default, so their app value is the base.
  const inheritedBase = forRepo ? (appPrompt?.overrideSource ?? prompt.default) : prompt.default;
  const savedValue = prompt.overrideSource ?? inheritedBase;

  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? savedValue;
  const dirty = draft !== null && draft !== savedValue;
  const overridden = prompt.overrideSource !== null;
  const isCustomAppScope = !prompt.builtin && !forRepo;

  // Reset and Delete discard the draft on purpose, and both can unmount this
  // editor before their write lands — mark it discarded so the unmount flush
  // below can't resurrect it. Typing again re-arms the flush.
  const discarded = useRef(false);
  const edit = (next: string) => {
    discarded.current = false;
    setDraft(next);
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [issueId, setIssueId] = useState("");

  const textareaId = `prompt-editor-${scope}-${prompt.name}`.replace(/[^\w-]/g, "_");

  // react-simple-code-editor doesn't forward these to its textarea, and WKWebView
  // otherwise applies macOS smart substitution — turning a typed `--` into an
  // em-dash or `"` into curly quotes, mangling template symbols. Set them once the
  // textarea mounts.
  useEffect(() => {
    const ta = document.getElementById(textareaId);
    if (!ta) return;
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocomplete", "off");
    ta.setAttribute("spellcheck", "false");
  }, [textareaId]);

  // Drop the draft only once the write lands: on failure the optimistic rollback
  // restores the *saved* text, so clearing it eagerly would destroy the edit the
  // user is about to retry.
  const onSave = () => {
    if (!dirty) return;
    setPrompt({ name: prompt.name, content: value }, { onSuccess: () => setDraft(null) });
  };
  const onReset = () => {
    discarded.current = true;
    setPrompt({ name: prompt.name, content: null }, { onSuccess: () => setDraft(null) });
  };
  const onDelete = () => {
    discarded.current = true;
    deleteBlock(prompt.name);
    onDeleted();
  };

  // Selecting another prompt in the rail remounts this editor (it's keyed per
  // prompt), and a ⌘-shortcut can navigate away mid-edit — neither fires a save.
  // Flush an unsaved draft on teardown so typing is never silently dropped (same
  // idiom as SkillEditor / TaskNotes). Refs so this doesn't re-fire per keystroke.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savedRef = useRef(savedValue);
  savedRef.current = savedValue;
  const nameRef = useRef(prompt.name);
  nameRef.current = prompt.name;
  const setPromptRef = useRef(setPrompt);
  setPromptRef.current = setPrompt;
  useEffect(
    () => () => {
      const d = draftRef.current;
      if (!discarded.current && d !== null && d !== savedRef.current) {
        setPromptRef.current({ name: nameRef.current, content: d });
      }
    },
    [],
  );

  const insert = (snippet: string) => {
    const ta = document.getElementById(textareaId) as HTMLTextAreaElement | null;
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? value.length;
    edit(value.slice(0, start) + snippet + value.slice(end));
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      const caret = start + snippet.length;
      ta.setSelectionRange(caret, caret);
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex-none border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-fg-bright">{prompt.label}</span>
          {prompt.builtin ? (
            overridden && <Badge>Modified</Badge>
          ) : (
            <Badge color="var(--color-muted)">Custom block</Badge>
          )}
        </div>
        <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
          {prompt.description}
        </div>
        <CompositionLine includes={prompt.includes} usedBy={prompt.usedBy} />
      </div>

      {/* Editor | Preview */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-line">
          <div className="prompt-editor min-h-0 flex-1 overflow-auto bg-input">
            <Editor
              value={value}
              onValueChange={edit}
              highlight={highlightJinja}
              padding={14}
              textareaId={textareaId}
              style={EDITOR_STYLE}
            />
          </div>
          {/* Variable palette */}
          <div className="flex-none border-t border-line bg-raised/30 px-4 py-2.5">
            <div className="mb-1.5 font-mono text-[9.5px] tracking-[.06em] text-muted-4 uppercase">
              Insert
            </div>
            <div className="flex max-h-[76px] flex-wrap gap-1.5 overflow-y-auto">
              {prompt.variables.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  title={v.description}
                  onClick={() => insert(`{{ ${v.name} }}`)}
                  className="cursor-pointer rounded border border-line-3 bg-input px-[6px] py-[2px] font-mono text-[10.5px] text-fg-3 hover:border-line-strong hover:text-fg-bright"
                >
                  {v.name}
                </button>
              ))}
              {prompt.includes.map((inc) => (
                <button
                  key={`inc-${inc}`}
                  type="button"
                  title={`Embed the “${inc}” block`}
                  onClick={() => insert(`{% include "${inc}" %}`)}
                  className="cursor-pointer rounded border border-dashed border-line-3 bg-input px-[6px] py-[2px] font-mono text-[10.5px] text-accent hover:border-line-strong"
                >
                  {`include "${inc}"`}
                </button>
              ))}
            </div>
          </div>
        </div>

        <PreviewPane
          name={prompt.name}
          content={value}
          repo={repo}
          issueId={issueId}
          onIssueChange={setIssueId}
          width={previewWidth}
          onWidth={onPreviewWidth}
        />
      </div>

      {/* Actions */}
      <div className="flex flex-none items-center justify-between gap-2 border-t border-line px-5 py-3">
        <div className="text-[11px] text-muted-3">
          {forRepo && !overridden
            ? "Inherits the User default."
            : overridden && prompt.builtin
              ? "Overridden."
              : ""}
        </div>
        <div className="flex items-center gap-2">
          {isCustomAppScope ? (
            confirmDelete ? (
              <>
                <span className="text-[11px] text-muted-2">Delete this block?</span>
                <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
                <Button variant="danger" onClick={onDelete}>
                  Delete
                </Button>
              </>
            ) : (
              <Button onClick={() => setConfirmDelete(true)}>
                <TrashIcon size={12} className="mr-1" /> Delete block
              </Button>
            )
          ) : (
            <Button onClick={onReset} disabled={!overridden || isPending}>
              {prompt.builtin ? "Reset to default" : "Reset override"}
            </Button>
          )}
          <Button variant="primary" onClick={onSave} disabled={!dirty || isPending}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The "Includes … · Used by …" composition links under the header. */
function CompositionLine({ includes, usedBy }: { includes: string[]; usedBy: string[] }) {
  if (includes.length === 0 && usedBy.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-3">
      {includes.length > 0 && (
        <span>
          Includes: <span className="font-mono text-fg-3">{includes.join(", ")}</span>
        </span>
      )}
      {usedBy.length > 0 && (
        <span>
          Used by: <span className="font-mono text-fg-3">{usedBy.join(", ")}</span>
        </span>
      )}
    </div>
  );
}

/** Live preview against sample data or a real Linear issue. Resizable via the
 *  left-edge divider between it and the editor. */
function PreviewPane({
  name,
  content,
  repo,
  issueId,
  onIssueChange,
  width,
  onWidth,
}: {
  name: string;
  content: string;
  repo: string;
  issueId: string;
  onIssueChange: (id: string) => void;
  width: number;
  onWidth: (w: number) => void;
}) {
  // The chosen issue is already cached (fetched once, keyed by id) — pass it to the
  // renderer rather than re-fetching, so the preview updates on every keystroke.
  const { data: detail } = useTriageDetail(repo, issueId || null);
  // A short debounce just coalesces bursts of fast typing; the render itself is a
  // pure, in-memory round-trip, so this stays snappy.
  const debounced = useDebounced(content, 80);
  const { data, isFetching } = usePreviewPrompt(
    name,
    debounced,
    repo,
    issueId || undefined,
    issueId ? detail : undefined,
  );
  const { data: tasks = [] } = useTasks(repo);
  const error = data?.error ?? null;

  const resize = useEdgeResize({
    cssVar: "--prompt-preview",
    width,
    min: PREVIEW_MIN,
    max: PREVIEW_MAX,
    edge: "left",
    onCommit: onWidth,
  });
  // The CSS var lives on documentElement and outlives this pane's remounts (it
  // remounts per selected prompt); re-assert the committed width on mount so a
  // stale var from an earlier drag can't desync from `width`.
  useEffect(() => {
    document.documentElement.style.setProperty("--prompt-preview", `${width}px`);
  }, [width]);

  return (
    <div
      className="relative flex flex-none flex-col"
      style={{ width: `var(--prompt-preview, ${width}px)` }}
    >
      <EdgeResizeHandle edge="left" {...resize} />
      <div className="flex flex-none items-center gap-2 border-b border-line px-4 py-2">
        <span className="font-mono text-[9.5px] tracking-[.06em] text-muted-4 uppercase">
          Preview
        </span>
        {isFetching && <span className="text-[10px] text-muted-4">rendering…</span>}
        <div className="ml-auto w-[220px]">
          <ChevronSelect
            value={issueId}
            onChange={onIssueChange}
            className="w-full rounded-md border border-line-3 bg-input py-1 pr-7 pl-2 font-mono text-[11px] text-fg-3"
          >
            <option value="">Sample ticket</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} — {t.title}
              </option>
            ))}
          </ChevronSelect>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-app/40">
        {error ? (
          <pre className="m-3 whitespace-pre-wrap rounded-lg border border-status-red/40 bg-status-red/10 px-3 py-2.5 font-mono text-[11px] text-status-red">
            {error}
          </pre>
        ) : data?.output ? (
          // Rendered output with the `{{ … }}`-substituted values tinted (see
          // highlightRendered). Input is HTML-escaped there; only our own marker
          // sentinels become spans, so this is safe to inject.
          <pre
            className="prompt-render whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-[1.55] text-fg-3"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: highlightRendered escapes the output; only marker sentinels are turned into spans.
            dangerouslySetInnerHTML={{ __html: highlightRendered(data.output) }}
          />
        ) : (
          <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-[1.55] text-fg-3">
            Type a template to see its preview.
          </pre>
        )}
      </div>
    </div>
  );
}

/** The create-a-shared-block form shown in the editor pane. */
function NewBlockForm({
  existing,
  onCancel,
  onCreated,
}: {
  existing: PromptInfo[];
  onCancel: () => void;
  onCreated: (name: string) => void;
}) {
  const { mutateAsync: create, isPending } = useCreatePromptBlock();
  const [label, setLabel] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Derive a slug from the label until the user edits the name directly.
  const [nameEdited, setNameEdited] = useState(false);
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  const effectiveName = nameEdited ? name : slug(label);

  const taken = existing.some((p) => p.name === effectiveName);
  const valid = /^[a-z][a-z0-9-]*$/.test(effectiveName) && !taken;

  const submit = async () => {
    if (!valid) {
      setError(taken ? "That name is already taken." : "Use lowercase letters, digits or dashes.");
      return;
    }
    try {
      await create({ name: effectiveName, label: label.trim() || effectiveName });
      onCreated(effectiveName);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="mx-auto mt-10 w-[440px]">
      <div className="mb-1 text-[15px] font-semibold text-fg-bright">New shared block</div>
      <div className="mb-5 text-[12px] text-muted-3">
        A reusable partial you can embed in any prompt with{" "}
        <code className="font-mono text-fg-3">{`{% include "…" %}`}</code>.
      </div>
      <label className="mb-1 block text-[12px] font-medium text-fg-3" htmlFor="block-label">
        Label
      </label>
      <input
        id="block-label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="House style"
        className="mb-4 w-full rounded-lg border border-line-3 bg-input px-3 py-2 text-[13px] text-fg-2 outline-none focus:border-line-strong"
      />
      <label className="mb-1 block text-[12px] font-medium text-fg-3" htmlFor="block-name">
        Include name
      </label>
      <input
        id="block-name"
        value={effectiveName}
        onChange={(e) => {
          setNameEdited(true);
          setName(e.target.value);
        }}
        placeholder="house-style"
        className="w-full rounded-lg border border-line-3 bg-input px-3 py-2 font-mono text-[12.5px] text-fg-2 outline-none focus:border-line-strong"
      />
      <div className="mt-1.5 text-[11px] text-muted-3">
        Referenced as{" "}
        <code className="font-mono text-fg-3">{`{% include "${effectiveName || "…"}" %}`}</code>.
      </div>
      {error && <div className="mt-2 text-[11.5px] text-status-red">{error}</div>}
      <div className="mt-5 flex items-center gap-2">
        <Button variant="primary" onClick={submit} disabled={!valid || isPending}>
          Create block
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
