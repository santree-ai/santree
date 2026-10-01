/**
 * A repo's mark. A Daedalus project draws the app icon the box serves — as an
 * `<img>` with a `data:` URL, never as markup in the document — and keeps the
 * GitHub mark when there is none, when the box's bytes aren't an image santree
 * draws, or when the image won't decode. Until the first answer it draws
 * neither, so the mark never swaps under the user.
 *
 * The data layer is real and the bridge is stubbed.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DaedalusIcon, Repo } from "../../bindings";

const SVG_B64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const state = vi.hoisted(() => ({
  repos: [] as Repo[],
  /** What the next `daedalusIcon` answers; a function to hold the answer back. */
  answer: (() => Promise.resolve(null)) as (name: string) => Promise<DaedalusIcon | null>,
  asked: [] as string[],
}));

vi.mock("../../bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../bindings")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      listRepos: () => Promise.resolve({ status: "ok" as const, data: state.repos }),
      daedalusIcon: async (name: string) => {
        state.asked.push(name);
        return { status: "ok" as const, data: await state.answer(name) };
      },
    },
  };
});

import { RepoAvatar } from "./RepoAvatar";

const repo = (name: string, location: Repo["location"], path: string) =>
  ({ name, location, path }) as Repo;

const draw = async (name: string) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The repo list is already loaded wherever a mark is drawn.
  await client.prefetchQuery({ queryKey: ["repos"], queryFn: () => state.repos });
  const view = render(
    <QueryClientProvider client={client}>
      <RepoAvatar repo={name} size={16} />
    </QueryClientProvider>,
  );
  return { ...view, client };
};

const img = (container: HTMLElement) => container.querySelector("img");

beforeEach(() => {
  state.repos = [
    repo("acme/iris", "Daedalus", "/home/santiago/projects/iris"),
    repo("acme/web", "Local", "/Users/me/web"),
  ];
  state.answer = () => Promise.resolve(null);
  state.asked = [];
});

describe("RepoAvatar on a Daedalus project", () => {
  it("draws the box's icon as an image, never as inline markup", async () => {
    state.answer = () => Promise.resolve({ contentType: "image/svg+xml", data: SVG_B64 });
    const { container } = await draw("acme/iris");
    await waitFor(() =>
      expect(img(container)?.getAttribute("src")).toBe(`data:image/svg+xml;base64,${SVG_B64}`),
    );
    // The SVG is the image's source, not part of the document: no element of
    // it — and so no script — is anywhere in the DOM.
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("alert");
    // Asked by the workspace's name: the last component of its server path.
    expect(state.asked).toEqual(["iris"]);
  });

  it("draws neither mark until the first answer, then the icon", async () => {
    let release: (icon: DaedalusIcon | null) => void = () => {};
    state.answer = () => new Promise((resolve) => (release = resolve));
    const { container } = await draw("acme/iris");
    await waitFor(() => expect(state.asked).toEqual(["iris"]));
    expect(img(container)).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    await act(async () => release({ contentType: "image/png", data: "iVBORw0KGgo=" }));
    await waitFor(() =>
      expect(img(container)?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo="),
    );
  });

  it("keeps the GitHub mark when the box has no icon", async () => {
    const { container } = await draw("acme/iris");
    await waitFor(() =>
      expect(img(container)?.getAttribute("src")).toBe("https://github.com/acme.png?size=64"),
    );
  });

  it("keeps the GitHub mark for bytes that aren't an image santree draws", async () => {
    for (const icon of [
      { contentType: "text/html", data: btoa("<html></html>") },
      { contentType: "image/svg+xml", data: "not base64!" },
      { contentType: "image/png", data: "A".repeat(4 * Math.ceil((64 * 1024 + 1) / 3)) },
    ]) {
      state.answer = () => Promise.resolve(icon);
      const { container, unmount } = await draw("acme/iris");
      await waitFor(() =>
        expect(img(container)?.getAttribute("src")).toBe("https://github.com/acme.png?size=64"),
      );
      unmount();
    }
  });

  it("falls back to the GitHub mark when the icon won't decode", async () => {
    state.answer = () => Promise.resolve({ contentType: "image/png", data: "iVBORw0KGgo=" });
    const { container } = await draw("acme/iris");
    await waitFor(() => expect(img(container)?.getAttribute("src")).toMatch(/^data:image\/png/));
    fireEvent.error(img(container) as HTMLImageElement);
    expect(img(container)?.getAttribute("src")).toBe("https://github.com/acme.png?size=64");
  });

  it("keeps the drawn icon while it is asked again", async () => {
    state.answer = () => Promise.resolve({ contentType: "image/png", data: "iVBORw0KGgo=" });
    const { container, client } = await draw("acme/iris");
    await waitFor(() => expect(img(container)?.getAttribute("src")).toMatch(/^data:image\/png/));
    let release: (icon: DaedalusIcon | null) => void = () => {};
    state.answer = () => new Promise((resolve) => (release = resolve));
    // What the link watcher does on every link change.
    void client.invalidateQueries({ queryKey: ["daedalus-icon"] });
    await waitFor(() => expect(state.asked).toEqual(["iris", "iris"]));
    expect(img(container)?.getAttribute("src")).toMatch(/^data:image\/png/);
    await act(async () => release({ contentType: "image/png", data: "iVBORw0KGgo=" }));
  });
});

describe("RepoAvatar on a project on this Mac", () => {
  it("never asks the box", async () => {
    const { container } = await draw("acme/web");
    await waitFor(() =>
      expect(img(container)?.getAttribute("src")).toBe("https://github.com/acme.png?size=64"),
    );
    expect(state.asked).toEqual([]);
  });
});
