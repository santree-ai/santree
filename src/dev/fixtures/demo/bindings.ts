/**
 * `src/bindings.ts` as the app sees it in demo mode: the generated module,
 * with the demo world's commands laid over the real `commands` object.
 *
 * The Vite plugin in `vite.config.ts` resolves every app import of the
 * bindings here; imports from inside `demo/` keep the real file, which is how
 * this module (and the handlers) reach it without a cycle. Overrides are typed
 * against the generated `commands`, so a command whose signature changes in
 * Rust fails `tsc` here instead of drifting at runtime. Anything the demo does
 * not override is the real command, talking to the real backend.
 */
import * as real from "../../../bindings";
import { buildDemoCommands } from "./handlers";

export * from "../../../bindings";

// A local export shadows the star export of the same name (ES module rule), so
// this is the `commands` every app module receives.
export const commands: typeof real.commands = {
  ...real.commands,
  ...buildDemoCommands(real.commands),
};
