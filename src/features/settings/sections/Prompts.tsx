/** Settings → Prompts: a full-pane composer for the prompts shared by every
 *  provider and workflow.
 *
 *  Left: a workflow-grouped library rail plus Shared blocks (reusable partials —
 *  the built-in Issue context plus any you create). Right: a side-by-side editor
 *  + live preview. Prompts are minijinja templates — reference
 *  `{{ variables }}`, branch with `{% if %}`/`{% for %}`, and embed another prompt
 *  with `{% include "name" %}`. Overrides are per app (User scope) or per repo. */

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import EditorImport from "react-simple-code-editor";

import { useEdgeResize } from "../../../lib/useEdgeResize";

// react-simple-code-editor is CJS (`exports.default`); depending on how Vite's
// dep pre-bundle interops it, the default import can arrive as the module
// namespace ({ default: Editor }) rather than the component. Unwrap defensively.
const Editor = ((EditorImport as unknown as { default?: typeof EditorImport }).default ??
  EditorImport) as typeof EditorImport;

import type {
  PromptInfo,
  PromptPreviewKind,
  PromptWorkItemSample,
  ReviewWorkItemSource,
} from "../../../bindings";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CommitIcon,
  DocsIcon,
  ExternalLinkIcon,
  LinearLogo,
  ListIcon,
  LockIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  PrIcon,
  QueueIcon,
  SparklesIcon,
  TelescopeIcon,
  TrashIcon,
} from "../../../components/icons";
import { MarkdownDocument } from "../../../components/Markdown";
import {
  Badge,
  Button,
  ChevronSelect,
  EdgeResizeHandle,
  Segmented,
  TerminalActivity,
} from "../../../components/primitives";
import {
  useCreatePromptBlock,
  useDeletePromptBlock,
  usePreviewPrompt,
  usePrompts,
  useSetPrompt,
  useTasks,
  useTriageDetail,
} from "../../../lib/queries";
import { shortRepoName } from "../../../lib/repoName";
import { usePersistedState } from "../../../lib/usePersistedState";
import { highlightJinja, highlightRendered, stripRenderMarks } from "../jinjaHighlight";

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
  // The queue prompt sits with the review prompt: both act on a pull request's
  // review, one drafting it and the other working through it.
  { title: "Reviews", names: ["pr-review", "pr-fix"] },
  { title: "English tutor", names: ["english-tutor", "english-analysis"] },
] as const;

/** Where the template language is documented. minijinja is the engine — a Rust
 *  implementation of Jinja2 — so what a prompt can do is what it documents. The
 *  `.njk` extension on the shipped defaults is Nunjucks's, borrowed for editor
 *  highlighting; the dialects mostly agree, but this is the reference. */
const SYNTAX_DOCS = [
  { label: "Syntax", url: "https://docs.rs/minijinja/latest/minijinja/syntax/index.html" },
  { label: "Filters", url: "https://docs.rs/minijinja/latest/minijinja/filters/index.html" },
  { label: "Tests", url: "https://docs.rs/minijinja/latest/minijinja/tests/index.html" },
] as const;

/** The rail's last group: the reusable partials, built-in and user-made. */
const BLOCKS_GROUP = "Shared blocks";

/** Which rail groups are folded — persisted, because the rail is a map of the
 *  app's prompts, and a map you refold on every visit is one you stop folding. */
const COLLAPSED_KEY = "settings.prompts.collapsed";

/** How the preview shows the rendered prompt: as the markdown the agent reads,
 *  or as its source with every substituted value tinted. Persisted with the
 *  fold state, for the same reason. */
type PreviewView = "markdown" | "source";
const PREVIEW_VIEW_KEY = "settings.prompts.preview-view";
const PREVIEW_VIEWS: { value: PreviewView; label: string }[] = [
  { value: "markdown", label: "Markdown" },
  { value: "source", label: "Source" },
];

type IconComponent = ComponentType<{ size?: number; className?: string }>;

/** Each built-in prompt's mark in the rail — the glyph its workflow wears
 *  elsewhere in Settings, so the rail reads as the same map. Blocks, and any
 *  prompt this doesn't know, get the document. */
const PROMPT_ICONS: Record<string, IconComponent> = {
  triage: TelescopeIcon,
  work: PlayIcon,
  "pr-fix": QueueIcon,
  "fill-commit": CommitIcon,
  "fill-pr": PrIcon,
  "pr-review": SparklesIcon,
  "english-tutor": PencilIcon,
  "english-analysis": ListIcon,
  issue: LinearLogo,
};
const promptIcon = (prompt: PromptInfo): IconComponent => PROMPT_ICONS[prompt.name] ?? DocsIcon;

/** What each kind of queue item is called in the sample editor, in the order
 *  the "Add" row offers them. */
const QUEUE_KINDS: { value: ReviewWorkItemSource; label: string }[] = [
  { value: "check", label: "Failing check" },
  { value: "githubThread", label: "Review comment" },
  { value: "aiDraft", label: "AI draft" },
  { value: "manual", label: "Note" },
];

/** Which fields a kind of item carries: a check is named and has an annotation,
 *  a comment has an author and a body, a draft only a body, a note neither. */
const hasAuthor = (kind: ReviewWorkItemSource) => kind === "check" || kind === "githubThread";
const hasBody = (kind: ReviewWorkItemSource) => kind !== "manual";

/** The queue the Start-work preview opens with — one item of each kind, the
 *  same four the backend renders when handed none (`sample_work_items` in
 *  prompts.rs), so an untouched editor and the backend's own render agree. */
const SAMPLE_QUEUE: PromptWorkItemSample[] = [
  {
    source: "check",
    description: "Fix failing check: test (ubuntu-latest)",
    path: "src/auth.rs",
    line: 42,
    author: "test (ubuntu-latest)",
    body: "assertion failed: attempts <= 5",
  },
  {
    source: "githubThread",
    description: "Reset the counter after a successful login",
    path: "src/auth.rs",
    line: 31,
    author: "octocat",
    body: "The counter never resets after a success, so a slow typist locks themselves out.",
  },
  {
    source: "aiDraft",
    description: "The limiter keys on a client-controlled header",
    path: "src/auth.rs",
    line: 18,
    author: null,
    body: "`X-Forwarded-For` is client-controlled; key on the peer address unless the app sits behind a trusted proxy.",
  },
  {
    source: "manual",
    description: "Add a test for the 429 response body",
    path: null,
    line: null,
    author: null,
    body: null,
  },
];

/** A row of the sample queue, with a key of its own so edits and removals keep
 *  each input on the item it was typed into. */
interface QueueRow {
  key: number;
  item: PromptWorkItemSample;
}

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
  const [collapsed, setCollapsed] = usePersistedState<Record<string, boolean>>(COLLAPSED_KEY, {});

  const flows = prompts?.filter((p) => p.kind === "flow") ?? [];
  const blocks = prompts?.filter((p) => p.kind === "block") ?? [];
  const groupedFlowNames = new Set<string>(FLOW_GROUPS.flatMap((group) => [...group.names]));
  const otherFlows = flows.filter((prompt) => !groupedFlowNames.has(prompt.name));
  const current = prompts?.find((p) => p.name === selected);

  // Every group the rail draws, in order: the workflows, anything the map above
  // doesn't place, and the blocks last behind a rule.
  const groups: { title: string; items: PromptInfo[] }[] = [
    ...FLOW_GROUPS.map((group) => ({
      title: group.title,
      items: group.names
        .map((name) => flows.find((prompt) => prompt.name === name))
        .filter((prompt): prompt is PromptInfo => prompt !== undefined),
    })),
    ...(otherFlows.length > 0 ? [{ title: "Other", items: otherFlows }] : []),
    { title: BLOCKS_GROUP, items: blocks },
  ];

  const select = (name: string) => {
    setCreating(false);
    setSelected(name);
  };
  const toggleGroup = (title: string) =>
    setCollapsed((current) => ({ ...current, [title]: !current[title] }));

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <PromptsHeader repo={repo} forRepo={forRepo} />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[228px] flex-none flex-col overflow-y-auto border-r border-line bg-raised/30 py-2">
          {groups.map((group) => (
            <RailGroup
              key={group.title}
              title={group.title}
              items={group.items}
              open={!collapsed[group.title]}
              onToggle={() => toggleGroup(group.title)}
              selected={creating ? null : selected}
              onSelect={select}
              separatorBefore={group.title === BLOCKS_GROUP}
            >
              {group.title === BLOCKS_GROUP && (
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="mx-2 mt-0.5 flex w-[calc(100%-16px)] cursor-pointer items-center gap-2 rounded-md py-[6px] pr-2.5 pl-[23px] text-left text-[12px] text-muted-2 hover:bg-hover hover:text-fg-2"
                >
                  <PlusIcon size={12} className="flex-none" /> New block
                </button>
              )}
            </RailGroup>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {creating ? (
            <NewBlockForm
              existing={prompts ?? []}
              onCancel={() => setCreating(false)}
              onCreated={(name) => {
                select(name);
                // The new block is selected, so its group must be open to show it.
                setCollapsed((current) => ({ ...current, [BLOCKS_GROUP]: false }));
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
            <div className="flex flex-1 items-center justify-center">
              <TerminalActivity label="Loading prompts…" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The pane's header: what these are, whose they are, and where the language
 *  is documented. The other sections get theirs from `Heading`; this pane is
 *  full-bleed with two columns under it, so it draws its own band at the same
 *  type sizes. */
function PromptsHeader({ repo, forRepo }: { repo: string; forRepo: boolean }) {
  return (
    <div className="flex flex-none flex-wrap items-start gap-x-8 gap-y-2 border-b border-line px-5 py-4">
      <div className="min-w-0 flex-1 basis-[440px]">
        <h1 className="text-[17px] font-semibold tracking-[-.01em] text-fg-bright">Prompts</h1>
        <p className="mt-1 max-w-[720px] text-[12px] leading-[1.55] text-muted-3">
          Every prompt santree hands an agent, in one place.{" "}
          {forRepo ? (
            <>
              These are the overrides for{" "}
              <span className="font-medium text-fg-3">{shortRepoName(repo)}</span>; a prompt without
              one inherits the User default.
            </>
          ) : (
            <>These are the User defaults, used by every project without an override of its own.</>
          )}{" "}
          A change applies to the next launch, and Reset returns the built-in. They are Jinja
          templates, rendered by minijinja: reference a <Code>{"{{ variable }}"}</Code>, branch with{" "}
          <Code>{"{% if %}"}</Code>, loop with <Code>{"{% for %}"}</Code>, and embed a shared block
          with <Code>{'{% include "name" %}'}</Code>.
        </p>
      </div>
      <div className="flex flex-none items-center gap-3 pt-1.5 text-[11px] text-muted-3">
        <span className="font-mono text-[9.5px] tracking-[.06em] text-muted-4 uppercase">
          Reference
        </span>
        {SYNTAX_DOCS.map((doc) => (
          <DocLink key={doc.label} label={doc.label} url={doc.url} />
        ))}
      </div>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[11px] text-fg-3">{children}</code>;
}

/** One folding group of the rail. Its rows hang from the heading's label, not
 *  its chevron, so a prompt reads as the heading's child and not its sibling.
 *  Folded, the heading carries the count — the only thing left to say. */
function RailGroup({
  title,
  items,
  open,
  onToggle,
  selected,
  onSelect,
  separatorBefore = false,
  children,
}: {
  title: string;
  items: PromptInfo[];
  open: boolean;
  onToggle: () => void;
  selected: string | null;
  onSelect: (name: string) => void;
  separatorBefore?: boolean;
  children?: ReactNode;
}) {
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className={separatorBefore ? "mt-2 border-t border-line pt-2" : ""}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="tree-band group mx-2 flex w-[calc(100%-16px)] cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-left"
      >
        <Chevron size={9} className="flex-none text-muted-4 group-hover:text-muted-3" />
        <span className="font-mono text-[10px] tracking-[.07em] text-muted-4 uppercase">
          {title}
        </span>
        {!open && (
          <span className="ml-auto font-mono text-[10px] text-muted-4 tabular-nums">
            {items.length}
          </span>
        )}
      </button>
      {open &&
        items.map((p) => {
          const active = p.name === selected;
          const Icon = promptIcon(p);
          return (
            <button
              key={p.name}
              type="button"
              onClick={() => onSelect(p.name)}
              data-active={active}
              className={`selection-row mx-2 flex w-[calc(100%-16px)] cursor-pointer items-center gap-2 rounded-md py-[6px] pr-2.5 pl-[23px] text-left text-[12.5px] ${
                active ? "text-fg-bright" : "text-fg-3"
              }`}
            >
              <Icon size={13} className={`flex-none ${active ? "text-fg-2" : "text-muted-3"}`} />
              <span className="min-w-0 flex-1 truncate">{p.label}</span>
              {!p.editable ? (
                <span
                  role="img"
                  className="flex flex-none text-muted-4"
                  title="Read-only"
                  aria-label="Read-only"
                >
                  <LockIcon size={10} />
                </span>
              ) : (
                p.overrideSource !== null && (
                  <span
                    className="h-1.5 w-1.5 flex-none rounded-full"
                    style={{ background: "var(--accent)" }}
                    title="Overridden in this scope"
                  />
                )
              )}
            </button>
          );
        })}
      {open && children}
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
          {!prompt.editable ? (
            <Badge color="var(--color-muted)">
              <LockIcon size={10} className="mr-1" />
              Read-only
            </Badge>
          ) : prompt.builtin ? (
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
              onValueChange={prompt.editable ? edit : () => {}}
              readOnly={!prompt.editable}
              highlight={highlightJinja}
              padding={14}
              textareaId={textareaId}
              style={EDITOR_STYLE}
            />
          </div>
          {/* Variable palette — or, for a prompt that can't be edited, the one
              line saying so and what it receives. */}
          {!prompt.editable ? (
            <div className="flex flex-none items-center gap-2 border-t border-line bg-raised/30 px-4 py-2.5 text-[11px] text-muted-3">
              <LockIcon size={11} className="flex-none text-muted-4" />
              <span>
                Shown as the agent gets it. It receives{" "}
                <span className="font-mono text-fg-3">
                  {prompt.variables.map((v) => v.name).join(", ")}
                </span>
                .
              </span>
            </div>
          ) : (
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
          )}
        </div>

        <PreviewPane
          name={prompt.name}
          kind={prompt.preview}
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
          {!prompt.editable
            ? "Read-only."
            : forRepo && !overridden
              ? "Inherits the User default."
              : overridden && prompt.builtin
                ? "Overridden."
                : ""}
        </div>
        <div className="flex items-center gap-2">
          {!prompt.editable ? null : isCustomAppScope ? (
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
          {prompt.editable && (
            <Button variant="primary" onClick={onSave} disabled={!dirty || isPending}>
              Save
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** An outbound documentation link. */
function DocLink({ label, url }: { label: string; url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      // WKWebView ignores target="_blank" (see Markdown.tsx) — hand the URL to
      // the opener plugin instead, keeping the href for right-click-to-copy.
      onClick={(e) => {
        e.preventDefault();
        void openUrl(url);
      }}
      title={url}
      className="inline-flex items-center gap-0.5 underline decoration-line-strong underline-offset-2 hover:text-fg-2"
    >
      {label} <ExternalLinkIcon size={9} />
    </a>
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

/** Live preview against sample data or a real Linear issue, rendered as the
 *  markdown the agent reads or shown as source with the substitutions tinted.
 *  Resizable via the left-edge divider between it and the editor. */
function PreviewPane({
  name,
  kind,
  content,
  repo,
  issueId,
  onIssueChange,
  width,
  onWidth,
}: {
  name: string;
  /** What the prompt is previewed against — a ticket to pick, a queue to build
   *  beside it, or sample data alone with nothing to pick. */
  kind: PromptPreviewKind;
  content: string;
  repo: string;
  issueId: string;
  onIssueChange: (id: string) => void;
  width: number;
  onWidth: (w: number) => void;
}) {
  const resizeTarget = useRef<HTMLDivElement>(null);
  // The chosen issue is already cached (fetched once, keyed by id) — pass it to the
  // renderer rather than re-fetching, so the preview updates on every keystroke.
  const { data: detail } = useTriageDetail(repo, issueId || null);
  // A short debounce just coalesces bursts of fast typing; the render itself is a
  // pure, in-memory round-trip, so this stays snappy.
  const debounced = useDebounced(content, 80);
  // The Start-work prompt's stand-in queue. Session-only, like the preview
  // width: it is a playground, not a setting.
  const [rows, setRows] = useState<QueueRow[]>(() =>
    SAMPLE_QUEUE.map((item, key) => ({ key, item })),
  );
  const nextKey = useRef(SAMPLE_QUEUE.length);
  const queue = useMemo(() => rows.map((row) => row.item), [rows]);
  const debouncedQueue = useDebounced(queue, 80);
  const { data, isFetching } = usePreviewPrompt(
    name,
    debounced,
    repo,
    issueId || undefined,
    // `null` is Linear's "no such issue" — the preview treats it like an
    // unresolved one and renders against the sample ticket instead.
    issueId ? (detail ?? undefined) : undefined,
    kind === "queue" ? debouncedQueue : undefined,
  );
  const { data: tasks = [] } = useTasks(repo);
  const error = data?.error ?? null;
  const [view, setView] = usePersistedState<PreviewView>(PREVIEW_VIEW_KEY, "markdown");

  const resize = useEdgeResize({
    cssVar: "--prompt-preview",
    target: resizeTarget,
    width,
    min: PREVIEW_MIN,
    max: PREVIEW_MAX,
    edge: "left",
    onCommit: onWidth,
  });
  return (
    <div
      ref={resizeTarget}
      className="relative flex flex-none flex-col"
      style={
        {
          "--prompt-preview": `${width}px`,
          width: `var(--prompt-preview, ${width}px)`,
        } as CSSProperties
      }
    >
      <EdgeResizeHandle edge="left" {...resize} />
      <div className="flex flex-none items-center gap-2 border-b border-line px-4 py-2">
        <span className="font-mono text-[9.5px] tracking-[.06em] text-muted-4 uppercase">
          Preview
        </span>
        {isFetching && <span className="text-[10px] text-muted-4">rendering…</span>}
        {kind === "sample" ? (
          <span className="ml-auto truncate text-[10.5px] text-muted-4">Sample data</span>
        ) : (
          <div className="ml-auto min-w-0 max-w-[220px] flex-1">
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
        )}
        <Segmented options={PREVIEW_VIEWS} value={view} onChange={setView} className="w-[142px]" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-app/40">
        {kind === "queue" && (
          <SampleQueueEditor
            rows={rows}
            onChange={setRows}
            onAdd={(source) =>
              setRows((current) => [
                ...current,
                { key: nextKey.current++, item: blankItem(source) },
              ])
            }
          />
        )}
        {error ? (
          <pre className="m-3 whitespace-pre-wrap rounded-lg border border-status-red/40 bg-status-red/10 px-3 py-2.5 font-mono text-[11px] text-status-red">
            {error}
          </pre>
        ) : data?.output ? (
          view === "markdown" ? (
            // What the agent reads, laid out as it would read it. The
            // substitution marks are stripped: markdown can't carry the tint,
            // and the private-use characters would otherwise render as boxes.
            <MarkdownDocument className="px-4 py-3 text-[12.5px] leading-[1.6] text-fg-2">
              {stripRenderMarks(data.output)}
            </MarkdownDocument>
          ) : (
            // Rendered output with the `{{ … }}`-substituted values tinted (see
            // highlightRendered). Input is HTML-escaped there; only our own marker
            // sentinels become spans, so this is safe to inject.
            <pre
              className="prompt-render whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-[1.55] text-fg-3"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: highlightRendered escapes the output; only marker sentinels are turned into spans.
              dangerouslySetInnerHTML={{ __html: highlightRendered(data.output) }}
            />
          )
        ) : (
          <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-[1.55] text-fg-3">
            Type a template to see its preview.
          </pre>
        )}
      </div>
    </div>
  );
}

/** A fresh row of a kind, blank where the kind has something to say. */
function blankItem(source: ReviewWorkItemSource): PromptWorkItemSample {
  return {
    source,
    description: "",
    path: null,
    line: null,
    author: hasAuthor(source) ? "" : null,
    body: hasBody(source) ? "" : null,
  };
}

const QUEUE_INPUT =
  "min-w-0 rounded border border-line-3 bg-input px-1.5 py-[3px] font-mono text-[10.5px] text-fg-3 outline-none placeholder:text-muted-4 focus:border-line-strong";

/** The Start-work preview's stand-in queue: the rows the prompt is rendered
 *  over, each one queue item of one kind — a failing check, a review comment,
 *  an AI draft, a note of your own. The backend turns the rows into the agent's
 *  JSON through the same code a real queue goes through, so what the preview
 *  shows is what the agent would get, kind by kind. */
function SampleQueueEditor({
  rows,
  onChange,
  onAdd,
}: {
  rows: QueueRow[];
  onChange: (rows: QueueRow[]) => void;
  onAdd: (source: ReviewWorkItemSource) => void;
}) {
  const update = (key: number, patch: Partial<PromptWorkItemSample>) =>
    onChange(
      rows.map((row) => (row.key === key ? { ...row, item: { ...row.item, ...patch } } : row)),
    );
  const remove = (key: number) => onChange(rows.filter((row) => row.key !== key));
  return (
    <div className="border-b border-line bg-raised/30 px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-mono text-[9.5px] tracking-[.06em] text-muted-4 uppercase">
          Sample queue
        </span>
        <span className="truncate text-[10.5px] text-muted-4">
          Becomes the JSON below exactly as a real queue does.
        </span>
      </div>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <SampleQueueRow
            key={row.key}
            item={row.item}
            onChange={(patch) => update(row.key, patch)}
            onRemove={() => remove(row.key)}
          />
        ))}
        {rows.length === 0 && (
          <div className="text-[11px] text-muted-4">
            Empty. Add an item to see how the prompt carries it.
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {QUEUE_KINDS.map((kind) => (
          <button
            key={kind.value}
            type="button"
            onClick={() => onAdd(kind.value)}
            className="flex cursor-pointer items-center gap-1 rounded border border-dashed border-line-3 bg-input px-[6px] py-[2px] font-mono text-[10.5px] text-fg-3 hover:border-line-strong hover:text-fg-bright"
          >
            <PlusIcon size={9} /> {kind.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** One sample item: its kind and wording, then the fields that kind has — the
 *  check's name and annotation, the comment's author and body, the draft's body
 *  — and where it anchors. */
function SampleQueueRow({
  item,
  onChange,
  onRemove,
}: {
  item: PromptWorkItemSample;
  onChange: (patch: Partial<PromptWorkItemSample>) => void;
  onRemove: () => void;
}) {
  const kind = item.source;
  const kindLabel = QUEUE_KINDS.find((k) => k.value === kind)?.label ?? kind;
  return (
    <div className="space-y-1 rounded-md border border-hairline bg-input/40 p-1.5">
      <div className="flex items-center gap-1.5">
        <ChevronSelect
          value={kind}
          onChange={(next) => {
            // Changing the kind keeps the words and the anchor; the fields the
            // new kind lacks go, and the ones it gains start blank.
            const source = next as ReviewWorkItemSource;
            onChange({
              source,
              author: hasAuthor(source) ? (item.author ?? "") : null,
              body: hasBody(source) ? (item.body ?? "") : null,
            });
          }}
          className="w-[132px] flex-none rounded border border-line-3 bg-input py-[3px] pr-6 pl-1.5 font-mono text-[10.5px] text-fg-3"
        >
          {QUEUE_KINDS.map((k) => (
            <option key={k.value} value={k.value} className="bg-input">
              {k.label}
            </option>
          ))}
        </ChevronSelect>
        <input
          value={item.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="What the item asks for"
          aria-label={`${kindLabel} description`}
          className={`${QUEUE_INPUT} flex-1`}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${kindLabel.toLowerCase()}`}
          title="Remove"
          className="flex h-5 w-5 flex-none cursor-pointer items-center justify-center rounded text-muted-4 hover:bg-hover hover:text-fg-2"
        >
          <TrashIcon size={11} />
        </button>
      </div>
      {(hasAuthor(kind) || hasBody(kind)) && (
        <div className="flex items-center gap-1.5">
          {hasAuthor(kind) && (
            <input
              value={item.author ?? ""}
              onChange={(e) => onChange({ author: e.target.value })}
              placeholder={kind === "check" ? "Check name" : "Author"}
              aria-label={kind === "check" ? "Check name" : "Author"}
              className={`${QUEUE_INPUT} w-[132px] flex-none`}
            />
          )}
          {hasBody(kind) && (
            <input
              value={item.body ?? ""}
              onChange={(e) => onChange({ body: e.target.value })}
              placeholder={
                kind === "check"
                  ? "Annotation message"
                  : kind === "aiDraft"
                    ? "Draft body"
                    : "Comment"
              }
              aria-label="Body"
              className={`${QUEUE_INPUT} flex-1`}
            />
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          value={item.path ?? ""}
          onChange={(e) => onChange({ path: e.target.value || null })}
          placeholder="path/to/file"
          aria-label="Path"
          className={`${QUEUE_INPUT} flex-1`}
        />
        <input
          value={item.line ?? ""}
          onChange={(e) => {
            const line = Number.parseInt(e.target.value, 10);
            onChange({ line: Number.isFinite(line) && line > 0 ? line : null });
          }}
          placeholder="line"
          inputMode="numeric"
          aria-label="Line"
          className={`${QUEUE_INPUT} w-14 flex-none`}
        />
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
