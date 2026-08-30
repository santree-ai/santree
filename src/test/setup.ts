import "@testing-library/jest-dom/vitest";

// Node ≥22 ships a global `localStorage` that is inert without
// `--localstorage-file` — every method is `undefined` — and it shadows jsdom's
// Storage in the vitest environment. Components that persist UI state through
// localStorage (sidebar collapse, active repo, …) or sessionStorage (the open
// worktree) need a working store, so replace the stubs with a minimal in-memory
// one each (fresh per test file).
class MemoryStorage {
  #map = new Map<string, string>();
  get length() {
    return this.#map.size;
  }
  clear() {
    this.#map.clear();
  }
  getItem(key: string) {
    return this.#map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.#map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#map.delete(key);
  }
  setItem(key: string, value: string) {
    this.#map.set(key, String(value));
  }
}
for (const name of ["localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    configurable: true,
  });
}

// Diff viewers measure monospace text while their modules initialize. jsdom's
// canvas method only emits a "not implemented" diagnostic, so provide the small
// deterministic surface the components need before test modules are imported.
HTMLCanvasElement.prototype.getContext = (() => ({
  font: "",
  measureText: (text: string) => ({ width: text.length * 7 }),
})) as unknown as HTMLCanvasElement["getContext"];
