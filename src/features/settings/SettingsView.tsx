/** The Settings tab: app-wide defaults and per-repo overrides.
 *
 * This file is just the shell — scope (app/repo) + section state, the sidebar
 * nav, and a data-driven dispatch to one section pane. Each pane lives in
 * `sections/`; shared widgets in `widgets.tsx`. */

import { useCanGoBack, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { RepoAvatar } from "../../components/chrome/RepoAvatar";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import {
  AgentsIcon,
  BackArrowIcon,
  BoltIcon,
  ContrastIcon,
  LinearLogo,
  PlugIcon,
} from "../../components/icons";
import { Tabs } from "../../components/primitives";
import { useApp } from "../../state/AppContext";
import { ActionsSection } from "./sections/Actions";
import { AgentsSection } from "./sections/Agents";
import { AppearanceSection } from "./sections/Appearance";
import { IntegrationsSection } from "./sections/Integrations";
import { RepoLinearSection } from "./sections/RepoLinear";

type Scope = "app" | "repo";

/** A settings section: its sidebar entry plus the pane to render. */
interface SectionDef {
  key: string;
  label: string;
  icon: ReactNode;
  render: (repo: string) => ReactNode;
}

const ICON_SIZE = 15;
const APP_SECTIONS: SectionDef[] = [
  {
    key: "integrations",
    label: "Integrations",
    icon: <PlugIcon size={ICON_SIZE} />,
    render: () => <IntegrationsSection />,
  },
  {
    key: "appearance",
    label: "Appearance",
    icon: <ContrastIcon size={ICON_SIZE} />,
    render: () => <AppearanceSection />,
  },
  {
    key: "agents",
    label: "Agents",
    icon: <AgentsIcon size={ICON_SIZE} />,
    render: () => <AgentsSection />,
  },
  {
    key: "actions",
    label: "Actions",
    icon: <BoltIcon size={ICON_SIZE} />,
    render: () => <ActionsSection />,
  },
];
const REPO_SECTIONS: SectionDef[] = [
  {
    key: "linear",
    label: "Linear",
    icon: <LinearLogo size={ICON_SIZE} />,
    render: (repo) => <RepoLinearSection repo={repo} />,
  },
  {
    key: "actions",
    label: "Actions",
    icon: <BoltIcon size={ICON_SIZE} />,
    render: (repo) => <ActionsSection repo={repo} />,
  },
];

export function SettingsView() {
  const { activeRepo } = useApp();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();

  // Land on a deep-linked section (e.g. `/settings?section=actions`) when given.
  const { section: initialSection } = useSearch({ strict: false }) as { section?: string };
  const [scope, setScope] = useState<Scope>("app");
  const [section, setSection] = useState<string>(initialSection ?? "integrations");

  const goBack = () => (canGoBack ? router.history.back() : navigate({ to: "/" }));
  const switchScope = (next: Scope) => {
    setScope(next);
    setSection(next === "app" ? "integrations" : "linear");
  };

  const sections = scope === "app" ? APP_SECTIONS : REPO_SECTIONS;
  // `section` comes from an unvalidated URL param, so fall back to the first
  // section for unknown deep-links instead of rendering a blank pane.
  const active = sections.find((s) => s.key === section) ?? sections[0];

  const backCell = (
    <div className="flex items-center pl-1">
      <button
        type="button"
        onClick={goBack}
        className="flex cursor-pointer items-center gap-2 rounded-md py-1 pr-2.5 pl-1.5 text-muted-2 transition-colors hover:bg-hover hover:text-fg-2"
      >
        <BackArrowIcon size={17} />
        <span className="text-[13px] font-semibold">Settings</span>
      </button>
    </div>
  );

  const scopeTabs = (
    <Tabs<Scope>
      variant="inset"
      className="h-full gap-0.5"
      tabClassName="h-full"
      tabs={[
        { value: "app", label: "App defaults" },
        {
          value: "repo",
          label: activeRepo,
          icon: <RepoAvatar repo={activeRepo} size={15} />,
        },
      ]}
      value={scope}
      onChange={switchScope}
    />
  );

  return (
    <ViewChrome
      leftCell={backCell}
      rightCell={scopeTabs}
      showRepoSelector={false}
      sidebar={
        <div className="p-2">
          {sections.map((s) => {
            const isActive = active.key === s.key;
            const style: CSSProperties = isActive
              ? {
                  background: "color-mix(in srgb, var(--accent) 15%, transparent)",
                  color: "var(--color-fg-bright)",
                  boxShadow: "inset 2px 0 0 var(--accent)",
                }
              : { background: "transparent", color: "var(--color-muted)" };
            return (
              <button
                type="button"
                key={s.key}
                onClick={() => setSection(s.key)}
                className="mb-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-[9px] text-left text-[12.5px] hover:bg-hover"
                style={style}
              >
                <span className="flex-none opacity-90">{s.icon}</span>
                {s.label}
              </button>
            );
          })}
        </div>
      }
    >
      <div className="flex-1 overflow-y-auto bg-app">
        <div className="max-w-[660px] px-[30px] pt-[26px] pb-11">{active.render(activeRepo)}</div>
      </div>
    </ViewChrome>
  );
}
