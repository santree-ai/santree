/** The Discussion / Investigation tab bar, shown once an investigation starts. */
import { Tabs } from "../../components/primitives";
import { useApp } from "../../state/AppContext";
import type { DetailTab } from "./hooks";

const DETAIL_TABS: { value: DetailTab; label: string }[] = [
  // Discussion first; the Investigation tab only renders once a session is live.
  { value: "discussion", label: "Discussion" },
  { value: "investigate", label: "Investigation" },
];

export function DetailTabs({ tab, onTab }: { tab: DetailTab; onTab: (t: DetailTab) => void }) {
  const { accent } = useApp();
  return (
    <Tabs
      className="flex-none border-b border-hairline px-5"
      tabs={DETAIL_TABS}
      value={tab}
      onChange={onTab}
      variant="inset"
      accent={accent}
      tabClassName="py-2"
    />
  );
}
