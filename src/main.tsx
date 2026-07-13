import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ErrorScreen } from "./components/ErrorScreen";
import { QuitGuard } from "./components/QuitGuard";
import { TerminalsProvider } from "./features/terminal/TerminalsContext";
import { forwardConsoleToLog } from "./lib/logging";
import { routeTree } from "./routeTree.gen";
import { AppProvider } from "./state/AppContext";
import { ToastViewport, toast } from "./state/toast";
import "./styles.css";

// Mirror console.* into the shared on-disk log file (no-op outside Tauri).
forwardConsoleToLog();

// Backend data rarely changes within a session; cache it generously.
const queryClient = new QueryClient({
  defaultOptions: {
    // Most queries wrap a Result-typed backend command (git/sqlite/gh) whose
    // failures are deterministic, not transient — TanStack's default `retry: 3`
    // (with backoff) just re-runs the same failing command 3x (~7s) before the
    // error/empty state renders, stalling the UI against our snappy-UX bar.
    // One retry still absorbs a genuine one-off network blip (Linear/GitHub).
    queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false, retry: 1 },
  },
  // Surface every failed read as a red toast, the same way mutations do below.
  // A *not-connected* backend never errors — it returns an empty result (the
  // no-mock-data rule), and the view shows its empty state — so a query error is
  // always a real failure (an expired Linear token, a dead `gh`) and must never
  // be swallowed into a cheerful "all caught up". Consumers almost all default
  // their data (`= []`) and never read `isError`, so this is the one place it
  // surfaces. The toast store collapses identical back-to-back messages, so a
  // failing poll refreshes one toast instead of stacking.
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (query.meta?.silent) return;
      toast.error(error instanceof Error ? error.message : String(error));
    },
  }),
  // Surface every failed mutation (settings save, Linear connect, status change…)
  // as a red toast in one place, so individual call sites don't each repeat it.
  // A mutation can opt out with `meta: { silent: true }` when it owns its own UI.
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.meta?.silent) return;
      toast.error(error instanceof Error ? error.message : String(error));
    },
  }),
});

// Replace TanStack Router's raw default error UI with our friendly screen for
// any error thrown while rendering a route.
const router = createRouter({
  routeTree,
  defaultErrorComponent: ({ error, reset }) => <ErrorScreen error={error} onRetry={reset} />,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root not found");
}

createRoot(rootElement).render(
  <StrictMode>
    {/* QueryClientProvider wraps ErrorBoundary (not the reverse) so QuitGuard — which
        only needs query context, not the app tree — survives a render error instead
        of unmounting with everything else and losing its `quit-requested` listener,
        the one working ⌘Q the ErrorScreen depends on. */}
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary>
        <AppProvider>
          <TerminalsProvider>
            <RouterProvider router={router} />
          </TerminalsProvider>
        </AppProvider>
        <ToastViewport />
      </ErrorBoundary>
      <QuitGuard />
    </QueryClientProvider>
  </StrictMode>,
);
