/**
 * Toast notifications — the app's way to surface async/background outcomes that
 * have no page of their own: a backend/auth error (red), a background action
 * that completed without a redirect (green), and so on.
 *
 * The store is a module-level external store (not React context) so it can be
 * driven from *outside* the React tree — most importantly the TanStack Query
 * `MutationCache`, which turns every failed mutation into a red toast centrally
 * (see `main.tsx`). Components read it via `useSyncExternalStore` in
 * {@link ToastViewport}, and anyone can raise one with the {@link toast} API.
 */
import { useSyncExternalStore } from "react";

import { CheckIcon, CloseIcon, WarningIcon } from "../components/icons";

export type ToastVariant = "success" | "error" | "info" | "warning";

export interface Toast {
  id: number;
  variant: ToastVariant;
  /** Bold one-liner; defaults to a per-variant label when omitted. */
  title?: string;
  /** The body message. */
  message: string;
  /** Auto-dismiss after this many ms; `0` keeps it until dismissed. */
  duration: number;
}

export interface ToastOptions {
  title?: string;
  duration?: number;
}

/** How long each variant lingers — errors stay longest since they need action. */
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 4500,
  warning: 6000,
  error: 7000,
};

/** Cap concurrent toasts so a burst of failures can't bury the screen. */
const MAX_VISIBLE = 4;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Toast[] {
  return toasts;
}

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function scheduleDismiss(id: number, duration: number) {
  if (duration > 0)
    timers.set(
      id,
      setTimeout(() => dismissToast(id), duration),
    );
}

/**
 * Show a toast. Identical back-to-back toasts (same variant + message) refresh
 * the existing one's timer instead of stacking, so a retrying mutation can't
 * spam the same error.
 */
export function showToast(variant: ToastVariant, message: string, opts: ToastOptions = {}): number {
  const duration = opts.duration ?? DEFAULT_DURATION[variant];

  const existing = toasts.find((t) => t.variant === variant && t.message === message);
  if (existing) {
    const timer = timers.get(existing.id);
    if (timer) clearTimeout(timer);
    scheduleDismiss(existing.id, duration);
    return existing.id;
  }

  const id = nextId++;
  const next = [...toasts, { id, variant, message, title: opts.title, duration }];
  while (next.length > MAX_VISIBLE) {
    // Drop the oldest *non-error* first so a transient success can't push an
    // unread error off-screen; only evict an error if nothing else is left.
    const i = next.findIndex((t) => t.variant !== "error");
    const [dropped] = next.splice(i === -1 ? 0 : i, 1);
    const timer = timers.get(dropped.id);
    if (timer) clearTimeout(timer);
    timers.delete(dropped.id);
  }
  toasts = next;
  emit();
  scheduleDismiss(id, duration);
  return id;
}

/** Imperative API, usable from React and non-React code alike. */
export const toast = {
  success: (message: string, opts?: ToastOptions) => showToast("success", message, opts),
  error: (message: string, opts?: ToastOptions) => showToast("error", message, opts),
  info: (message: string, opts?: ToastOptions) => showToast("info", message, opts),
  warning: (message: string, opts?: ToastOptions) => showToast("warning", message, opts),
};

const VARIANT: Record<ToastVariant, { color: string; label: string; Icon: typeof CheckIcon }> = {
  success: { color: "var(--color-status-green)", label: "Done", Icon: CheckIcon },
  error: { color: "var(--color-status-red)", label: "Something went wrong", Icon: WarningIcon },
  warning: { color: "var(--color-status-amber)", label: "Heads up", Icon: WarningIcon },
  info: { color: "var(--accent)", label: "Note", Icon: CheckIcon },
};

function ToastCard({ toast: t }: { toast: Toast }) {
  const v = VARIANT[t.variant];
  return (
    <div
      className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line-2 bg-panel py-2.5 pr-2 pl-3 shadow-xl"
      style={{ borderLeft: `2.5px solid ${v.color}`, animation: "toastIn .2s ease-out" }}
    >
      <span className="mt-px flex-none" style={{ color: v.color }}>
        <v.Icon size={14} />
      </span>
      <div className="min-w-0 flex-1 pt-px">
        <div className="text-[12px] font-semibold text-fg-bright">{t.title ?? v.label}</div>
        <div className="selectable mt-0.5 text-[11.5px] leading-[1.45] break-words text-fg-2">
          {t.message}
        </div>
      </div>
      <button
        type="button"
        onClick={() => dismissToast(t.id)}
        aria-label="Dismiss notification"
        className="flex flex-none cursor-pointer items-center rounded p-1 text-muted-4 transition-colors hover:text-fg-2"
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

/**
 * Renders the stacked toasts, bottom-right (clear of the macOS titlebar/chrome).
 * Mount once near the app root; reads the module store directly, so it needs no
 * provider.
 *
 * The `aria-live` region lives here — on the always-mounted wrapper — rather
 * than on each `ToastCard`. Screen readers only reliably announce *changes*
 * inside a live region that already existed in the DOM; a region that appears
 * fully-formed (as each card would, mounting with its text already in place)
 * is often not announced at all. A second, visually-hidden `assertive` region
 * mirrors error toasts specifically, so they interrupt (per their severity)
 * instead of queuing politely behind whatever else is being read.
 */
export function ToastViewport() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const errors = items.filter((t) => t.variant === "error");
  return (
    <>
      <div
        role="log"
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[200] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {items.map((t) => (
          <ToastCard key={t.id} toast={t} />
        ))}
      </div>
      <div role="alert" aria-live="assertive" className="sr-only">
        {errors.map((t) => (
          <div key={t.id}>
            {t.title ?? VARIANT.error.label}: {t.message}
          </div>
        ))}
      </div>
    </>
  );
}
