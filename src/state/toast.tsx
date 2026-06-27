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
  toasts = [...toasts, { id, variant, message, title: opts.title, duration }].slice(-MAX_VISIBLE);
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
      role="status"
      aria-live={t.variant === "error" ? "assertive" : "polite"}
      className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-line-2 bg-panel py-2.5 pr-2 pl-3 shadow-xl"
      style={{ borderLeft: `2.5px solid ${v.color}`, animation: "toastIn .2s ease-out" }}
    >
      <span className="mt-px flex-none" style={{ color: v.color }}>
        <v.Icon size={14} />
      </span>
      <div className="min-w-0 flex-1 pt-px">
        <div className="text-[12px] font-semibold text-fg-bright">{t.title ?? v.label}</div>
        <div className="mt-0.5 text-[11.5px] leading-[1.45] break-words text-fg-2">{t.message}</div>
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
 */
export function ToastViewport() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[200] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {items.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
