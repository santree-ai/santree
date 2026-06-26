import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("super-secret-stack-trace");
}

// React logs caught errors to console.error; silence it for a clean run.
let spy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  spy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => spy.mockRestore());

test("renders the friendly fallback and never leaks the raw error", () => {
  render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );

  expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  expect(screen.getByText("Try again")).toBeInTheDocument();
  expect(screen.getByText("Report issue")).toBeInTheDocument();
  // The raw JS error must never be shown to the user.
  expect(screen.queryByText(/super-secret-stack-trace/)).toBeNull();
});
