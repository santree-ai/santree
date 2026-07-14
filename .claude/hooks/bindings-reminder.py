#!/usr/bin/env python3
"""PostToolUse hook: after an Edit/Write to a file that feeds the generated
Rust->TS bridge, remind the session that src/bindings.ts is now stale.

Bindings are NOT auto-regenerated during a session; drift is silent locally
and only caught by CI (`git diff --exit-code src/bindings.ts`). This fires
the reminder at the moment of the edit instead.
"""

import json
import sys

# Files whose changes can alter the generated bindings: command signatures,
# command registration, and the specta::Type domain shapes.
TARGETS = (
    "src-tauri/src/commands.rs",
    "src-tauri/src/lib.rs",
    "crates/core/src/domain.rs",
)


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    path = (payload.get("tool_input") or {}).get("file_path") or ""
    if not path.endswith(TARGETS):
        return
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": (
                        f"{path} feeds the generated TS bridge, so src/bindings.ts "
                        "may now be stale. Before finishing, run `pnpm gen:bindings` "
                        "and commit the regenerated bindings.ts alongside this change "
                        "(CI fails on drift). Never hand-edit bindings.ts."
                    ),
                }
            }
        )
    )


if __name__ == "__main__":
    main()
