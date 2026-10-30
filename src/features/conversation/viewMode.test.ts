/** A tab's face is its own choice when it made one, else the default from
 *  Settings; an entry stored before the default existed (`true`, when only a
 *  conversation was stored) is still that tab's choice. Read through the store
 *  as it loads from storage, which is where an old entry meets the new reader. */
import { expect, test } from "vitest";

import { agentTabView } from "./viewMode";

const OLD = "an old conversation";
const TERMINAL = "a tab switched to its terminal";
const CONVERSATION = "a tab switched to its conversation";
const UNSET = "a tab never switched";

localStorage.setItem(
  "santree.agentTabView",
  JSON.stringify({ [OLD]: true, [TERMINAL]: "terminal", [CONVERSATION]: "conversation" }),
);

test.each([
  [OLD, "terminal", "conversation"],
  [TERMINAL, "conversation", "terminal"],
  [CONVERSATION, "terminal", "conversation"],
  [UNSET, "terminal", "terminal"],
  [UNSET, "conversation", "conversation"],
] as const)("%s, under the %s default, shows its %s", (tab, fallback, face) => {
  expect(agentTabView(tab, fallback)).toBe(face);
});
