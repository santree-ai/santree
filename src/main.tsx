import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ErrorScreen } from "./components/ErrorScreen";
import { TerminalsProvider } from "./features/terminal/TerminalsContext";
import { routeTree } from "./routeTree.gen";
import { AppProvider } from "./state/AppContext";
import { ToastViewport, toast } from "./state/toast";
import "./styles.css";

// Backend data rarely changes within a session; cache it generously.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
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
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AppProvider>
          <TerminalsProvider>
            <RouterProvider router={router} />
          </TerminalsProvider>
        </AppProvider>
        <ToastViewport />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
