import "@testing-library/jest-dom/vitest";

// Node ≥22 ships a global `localStorage` that is inert without
// `--localstorage-file` — every method is `undefined` — and it shadows jsdom's
// Storage in the vitest environment. Components that persist UI state through
// localStorage (sidebar collapse, active repo, …) need a working store, so
// replace the stub with a minimal in-memory one (fresh per test file).
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
Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});
