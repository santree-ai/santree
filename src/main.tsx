import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ErrorScreen } from "./components/ErrorScreen";
import { QuitGuard } from "./components/QuitGuard";
import { TerminalsProvider } from "./features/terminal/TerminalsContext";
import { initFocusModality } from "./lib/focusModality";
import { forwardConsoleToLog } from "./lib/logging";
import { readFailures, writeFailures } from "./lib/queryFailures";
import { applyZoom, loadZoom } from "./lib/zoom";
import { routeTree } from "./routeTree.gen";
import { AppProvider } from "./state/AppContext";
import { ToastViewport } from "./state/toast";
import "./styles.css";

// Mirror console.* into the shared on-disk log file (no-op outside Tauri).
forwardConsoleToLog();

// Restore the chosen text size. The webview always starts at 1×, so this has to
// run every launch — and before first paint, or the app renders at normal size
// and visibly jumps.
applyZoom(loadZoom());

// Track pointer vs keyboard so focus rings only show for keyboard navigation.
initFocusModality();

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
  // Every failed read and write is logged, and surfaced as a red toast by the rules
  // in `lib/queryFailures.ts` — for most views the only place an error shows.
  queryCache: new QueryCache(readFailures),
  mutationCache: new MutationCache(writeFailures),
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

// The screenshot fixture mode (`VITE_SANTREE_FIXTURES=1 pnpm dev:alt`): a fake
// world served at the IPC boundary, for README and website captures. Both
// conditions are build-time constants, so a production bundle drops the import
// and the module behind it entirely — see `src/dev/fixtures/README.md`.
async function boot() {
  if (import.meta.env.DEV && import.meta.env.VITE_SANTREE_FIXTURES === "1") {
    const { installFixtures } = await import("./dev/fixtures/install");
    await installFixtures();
  }
  createRoot(rootElement as HTMLElement).render(
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
}

void boot();
