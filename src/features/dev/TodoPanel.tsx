/**
 * The Dev tab's TODO sidebar: capture bugs/ideas fast while dogfooding — paste
 * screenshots straight into the composer (⌘V) — tick items off, and hand one to
 * the Dev Claude session ("Send to Claude" renders it into an on-disk prompt).
 */
import { type ClipboardEvent, useCallback, useState } from "react";

import type { DevTodo } from "../../bindings";
import { Button, Skeleton } from "../../components/primitives";
import {
  useAddDevTodo,
  useDeleteDevTodo,
  useDevScreenshot,
  useDevTodos,
  useSetDevTodoDone,
} from "../../lib/queries";
import { formatRelativeTime, useLiveNow } from "../../lib/relativeTime";

interface PendingShot {
  id: string;
  /** `data:image/…;base64,` URL — previewed as-is and sent to the backend. */
  url: string;
}

export function TodoPanel({ onSend }: { onSend: (id: string) => void }) {
  const todos = useDevTodos();
  const add = useAddDevTodo();
  const [body, setBody] = useState("");
  const [shots, setShots] = useState<PendingShot[]>([]);

  const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData.items).filter(
      (i) => i.type === "image/png" || i.type === "image/jpeg",
    );
    if (images.length === 0) return; // plain text pastes stay native
    e.preventDefault();
    for (const item of images) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result;
        if (typeof url === "string") {
          setShots((s) => [...s, { id: crypto.randomUUID(), url }]);
        }
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const canSubmit = body.trim().length > 0 || shots.length > 0;
  const submit = () => {
    if (!canSubmit) return;
    add.mutate({
      id: crypto.randomUUID(),
      body: body.trim(),
      screenshots: shots.map((s) => s.url),
    });
    setBody("");
    setShots([]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-col gap-2 border-b border-line p-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="Found a bug? Write it down. Screenshots paste right here."
          aria-label="New dev todo"
          className="selectable w-full resize-none rounded-md border border-line-2 bg-input px-2.5 py-2 text-[12px] text-fg-2 placeholder:text-muted-4 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]"
        />
        {shots.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {shots.map((s, i) => (
              <div key={s.id} className="relative">
                <img
                  src={s.url}
                  alt={`Pasted screenshot ${i + 1}`}
                  className="h-12 w-12 rounded border border-line object-cover"
                />
                <button
                  type="button"
                  aria-label={`Remove screenshot ${i + 1}`}
                  onClick={() => setShots((cur) => cur.filter((x) => x.id !== s.id))}
                  className="absolute -top-1.5 -right-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-[9px] text-muted-2 hover:text-fg-2"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] text-muted-4">⌘↵ to add</span>
          <Button size="sm" variant="tinted" disabled={!canSubmit} onClick={submit}>
            Add
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {(todos.data ?? []).length === 0 ? (
          <div className="px-4 py-8 text-center text-[11px] text-muted-4">
            {todos.isFetched ? "Nothing captured yet." : ""}
          </div>
        ) : (
          todos.data?.map((t) => <TodoRow key={t.id} todo={t} onSend={onSend} />)
        )}
      </div>
    </div>
  );
}

function TodoRow({ todo, onSend }: { todo: DevTodo; onSend: (id: string) => void }) {
  const setDone = useSetDevTodoDone();
  const del = useDeleteDevTodo();
  const now = useLiveNow();

  // Row actions reveal on hover but must stay reachable by keyboard, so they
  // also un-hide on focus-visible rather than being display:none'd away.
  const action =
    "cursor-pointer opacity-0 transition-opacity hover:text-fg-2 focus-visible:opacity-100 group-hover:opacity-100";

  return (
    <div className="group border-b border-line px-3 py-2.5">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={todo.done}
          onChange={() => setDone.mutate({ id: todo.id, done: !todo.done })}
          aria-label={todo.done ? "Mark as not done" : "Mark as done"}
          className="mt-0.5 h-3 w-3 flex-none cursor-pointer accent-[var(--accent)]"
        />
        <div className="min-w-0 flex-1">
          <div
            className={`selectable whitespace-pre-wrap text-[12px] leading-[1.45] ${
              todo.done ? "text-muted-4 line-through" : "text-fg-2"
            }`}
          >
            {todo.body}
          </div>
          {todo.screenshots.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1.5">
              {todo.screenshots.map((p) => (
                <TodoShot key={p} path={p} />
              ))}
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-2.5 text-[10.5px] text-muted-4">
            <span>{formatRelativeTime(todo.createdAtMs ?? now, now)}</span>
            <span className="flex-1" />
            <button type="button" className={action} onClick={() => onSend(todo.id)}>
              Send to Claude
            </button>
            <button type="button" className={action} onClick={() => del.mutate(todo.id)}>
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TodoShot({ path }: { path: string }) {
  const src = useDevScreenshot(path);
  if (!src.data) return <Skeleton className="h-16 w-40 rounded border border-line" />;
  return (
    <img
      src={src.data}
      alt="Attached screenshot"
      className="max-h-40 max-w-full self-start rounded border border-line"
    />
  );
}
