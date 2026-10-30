/** A live Claude tab's two faces over one area: its terminal — `children`, the
 *  host the terminal layer draws the pane over — and its conversation, an
 *  opaque cover above it.
 *
 *  The conversation mounts the first time it is shown and then stays mounted,
 *  hidden and inert under the terminal, so a switch is a class change: back on
 *  the conversation, its scroll, the cards opened and the draft are as they
 *  were. Mounted afresh on every switch, a long conversation (the forty turns
 *  the journal draws at most) took some 50 ms before layout to come back —
 *  scrolled to the end, everything opened folded again. While hidden it reads
 *  nothing. The terminal stays as it is either way: running, at its size, and
 *  painted (the layer keeps a pane without a host where it was, inert). */
import { type ReactNode, useState } from "react";

import { ConversationView, type LiveTab } from "./ConversationView";
import type { AgentFace } from "./viewMode";

export function ConversationFace({
  face,
  live,
  onResume,
  children,
}: {
  /** The tab's faces (`useConversationFace`). One that stops being offered —
   *  Settings → Experimental's switch turned off — lets its conversation go. */
  face: AgentFace;
  live: LiveTab;
  /** The surface's Resume for a lost pane (as its terminal's notice has). */
  onResume?: () => void;
  children: ReactNode;
}) {
  const { shown, offered } = face;
  const [kept, setKept] = useState(shown);
  if (shown && !kept) setKept(true);
  if (!offered && kept) setKept(false);
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {children}
      {kept && (
        <div
          data-conversation-face={shown ? "shown" : "hidden"}
          className={`absolute inset-0 flex flex-col ${shown ? "" : "invisible"}`}
          inert={!shown}
        >
          <ConversationView
            target={{ kind: "tab", repo: live.repo, termKey: live.termKey }}
            live={live}
            shown={shown}
            onResume={onResume}
          />
        </div>
      )}
    </div>
  );
}
