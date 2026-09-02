/**
 * `@tauri-apps/api/core`, with the fixture world seated in front of `invoke`.
 *
 * Vite aliases the package here in fixture mode (see `vite.config.ts`), so the
 * generated bindings — and anything else importing the package — get this
 * module. Everything but `invoke` is the real thing, re-exported from the real
 * file; `invoke` answers the commands the fixture world owns and forwards the
 * rest, so settings, prompts and the real PTY manager keep working underneath.
 *
 * Tauri defines its own `window.__TAURI_INTERNALS__.invoke` as a read-only
 * property, which is why this sits at the import rather than on the global.
 */

import type { InvokeArgs, InvokeOptions } from "../../../node_modules/@tauri-apps/api/core.js";
import { invoke as realInvoke } from "../../../node_modules/@tauri-apps/api/core.js";
import { type Args, buildHandlers } from "./handlers";

export * from "../../../node_modules/@tauri-apps/api/core.js";

const handlers = buildHandlers((cmd, args, options) =>
  realInvoke(cmd, args as InvokeArgs, options as InvokeOptions | undefined),
);

export async function invoke<T>(
  cmd: string,
  args: InvokeArgs = {},
  options?: InvokeOptions,
): Promise<T> {
  const handler = handlers[cmd];
  if (!handler) return realInvoke<T>(cmd, args, options);
  return (await handler(args as Args)) as T;
}
