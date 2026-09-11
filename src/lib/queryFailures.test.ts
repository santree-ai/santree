/**
 * The app's one policy for failed reads and writes, through a real QueryClient:
 * which failures toast, and that each leaves one log line naming what failed.
 */
import { MutationCache, MutationObserver, QueryCache, QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("../state/toast", () => ({ toast: { error: toastError } }));

import { readFailures, writeFailures } from "./queryFailures";

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

let qc: QueryClient;
beforeEach(() => {
  qc = new QueryClient({
    queryCache: new QueryCache(readFailures),
    mutationCache: new MutationCache(writeFailures),
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  toastError.mockClear();
  warn.mockClear();
});

const ok = () => Promise.resolve(["pr"]);
const fail = (message: string) => () => Promise.reject(new Error(message));

/** One fetch of `key`; its rejection is swallowed, since the cache's callbacks are
 *  what's under test. */
const fetch = (key: string, fn: () => Promise<unknown>, meta?: { silent?: boolean }) =>
  qc.fetchQuery({ queryKey: [key], queryFn: fn, meta, staleTime: 0 }).catch(() => {});

const logged = () => warn.mock.calls.map((call) => call[0]);

describe("readFailures", () => {
  it("toasts a read that fails with nothing on screen, and logs it under its key", async () => {
    await fetch("reviews", fail("GitHub GraphQL is temporarily unavailable (502 Bad Gateway)."));

    expect(toastError).toHaveBeenCalledWith(
      "GitHub GraphQL is temporarily unavailable (502 Bad Gateway).",
    );
    expect(logged()).toEqual([
      'read failed ["reviews"]: GitHub GraphQL is temporarily unavailable (502 Bad Gateway).',
    ]);
  });

  /** The view still shows the last good answer, so one failed refresh is a blip for
   *  the log; a second in a row is a failure the user has to hear about. */
  it("keeps a refresh that fails under data on screen quiet once, and toasts the next", async () => {
    await fetch("reviews", ok);

    await fetch("reviews", fail("blip"));
    expect(toastError).not.toHaveBeenCalled();
    expect(logged()).toEqual(['read failed ["reviews"]: blip']);

    await fetch("reviews", fail("blip"));
    expect(toastError).toHaveBeenCalledWith("blip");
  });

  it("starts counting again after a success", async () => {
    await fetch("reviews", ok);
    await fetch("reviews", fail("blip"));
    await fetch("reviews", ok);
    await fetch("reviews", fail("blip"));

    expect(toastError).not.toHaveBeenCalled();
    expect(logged()).toEqual(['read failed ["reviews"]: blip', 'read failed ["reviews"]: blip']);
  });

  it("logs one line per distinct failure, not one per failing tick", async () => {
    await fetch("usage", fail("rate limited"));
    await fetch("usage", fail("rate limited"));
    await fetch("usage", fail("signed out"));

    expect(logged()).toEqual([
      'read failed ["usage"]: rate limited',
      'read failed ["usage"]: signed out',
    ]);
  });

  it("logs a silent read and never toasts it", async () => {
    await fetch("usage", fail("rate limited"), { silent: true });
    await fetch("usage", fail("rate limited"), { silent: true });

    expect(toastError).not.toHaveBeenCalled();
    expect(logged()).toEqual(['read failed ["usage"]: rate limited']);
  });
});

describe("writeFailures", () => {
  const mutate = (fn: () => Promise<unknown>, opts: { mutationKey?: string[]; silent?: boolean }) =>
    new MutationObserver(qc, {
      mutationFn: fn,
      mutationKey: opts.mutationKey,
      meta: opts.silent ? { silent: true } : undefined,
    })
      .mutate(undefined)
      .catch(() => {});

  it("toasts and logs a failed write", async () => {
    await mutate(fail("nope"), { mutationKey: ["save"] });

    expect(toastError).toHaveBeenCalledWith("nope");
    expect(logged()).toEqual(['write failed ["save"]: nope']);
  });

  it("only logs a silent one", async () => {
    await mutate(fail("quiet"), { silent: true });

    expect(toastError).not.toHaveBeenCalled();
    expect(logged()).toEqual(["write failed: quiet"]);
  });
});
