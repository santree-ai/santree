/**
 * Settings → Experimental: the features santree ships turned off. A switch here
 * is enforced wherever its feature reaches, not only by the page it shows:
 *
 * - Daedalus: its Settings page, the sidebar section and every way to add or
 *   open a Daedalus project. Off, the backend doesn't link to the Daedalus
 *   agent at all; turning it on links at once, and nothing stored is lost in
 *   between.
 * - English tutor: its Settings page. Off, no Claude session santree starts
 *   gets the tutor, whatever its own switch says (`english_tutor::enabled`).
 * - Conversation view: a Claude tab's second face, through
 *   `useConversationOffer`. Off, every Claude tab is its terminal; the face
 *   each tab was switched to is kept for when it comes back on. The default
 *   face lives here, under its switch.
 */
import { MessageSquareIcon, TerminalIcon } from "../../../components/icons";
import { Segmented } from "../../../components/primitives";
import {
  CLAUDE_TAB_FACE_KEY,
  useExperimental,
  useSetExperimental,
  useSetSetting,
} from "../../../lib/queries";
import {
  type AgentTabView,
  useDefaultAgentTabView,
  VIEW_SHORTCUT,
} from "../../conversation/viewMode";
import { Heading, ToggleRow } from "../widgets";

export function ExperimentalSection() {
  const daedalus = useExperimental("Daedalus");
  const englishTutor = useExperimental("EnglishTutor");
  const conversation = useExperimental("Conversation");
  const { mutate: setExperimental } = useSetExperimental();

  return (
    <>
      <Heading
        title="Experimental"
        subtitle="Features santree is still building. Each one stays off until you turn it on here."
      />
      <div className="rounded-xl border border-line-2 bg-raised px-4 py-0.5">
        <ToggleRow
          label="Daedalus"
          hint="Shows the projects on your home server and connects to the Daedalus agent on this Mac. Off, santree doesn't connect, and your Daedalus projects stay registered."
          on={daedalus}
          onChange={(on) => setExperimental({ feature: "Daedalus", on })}
        />
        <ToggleRow
          label="English tutor"
          hint="Shows the English tutor settings. Off, Claude sessions santree starts get no tutor, even with Correct my English on. Running sessions keep what they started with."
          on={englishTutor}
          onChange={(on) => setExperimental({ feature: "EnglishTutor", on })}
        />
        <ToggleRow
          label="Conversation view"
          hint={`An interactive view of a Claude tab: its session drawn as a conversation you can message, and answer Claude's permission prompts, questions and plans from, while Claude Code keeps running in the terminal. A Conversation | Terminal switch above each Claude tab (or ${VIEW_SHORTCUT}) moves between them. Off, Claude tabs show only the terminal.`}
          on={conversation}
          onChange={(on) => setExperimental({ feature: "Conversation", on })}
        />
        {conversation && <TabFaceRow />}
      </div>
    </>
  );
}

/** Which face a Claude tab with no choice of its own opens on. ToggleRow's
 *  layout, with the two faces in place of its switch. */
function TabFaceRow() {
  const tabFace = useDefaultAgentTabView();
  const { mutate: setSetting } = useSetSetting();
  return (
    <div className="flex items-center gap-[13px] border-t border-line py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-fg-3">Claude tabs open in</div>
        <div className="mt-[3px] text-[11.5px] leading-[1.5] text-muted-3">
          {VIEW_SHORTCUT} switches one tab, and a tab you switched keeps its choice.
        </div>
      </div>
      <Segmented<AgentTabView>
        ariaLabel="Claude tabs open in"
        className="w-[224px] flex-none"
        value={tabFace}
        onChange={(value) => setSetting({ scope: "app", key: CLAUDE_TAB_FACE_KEY, value })}
        options={[
          { value: "terminal", label: "Terminal", icon: <TerminalIcon size={12} /> },
          {
            value: "conversation",
            label: "Conversation",
            icon: <MessageSquareIcon size={12} />,
          },
        ]}
      />
    </div>
  );
}
