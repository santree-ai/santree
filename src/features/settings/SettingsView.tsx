/** The Settings tab: app-wide defaults and per-repo overrides.
 *
 * This file is just the shell — scope (app/repo) + section state, the sidebar
 * nav (flat items plus grouped sections like "Actions"), and a data-driven
 * dispatch to one section pane. Each pane lives in `sections/`; shared widgets
 * in `widgets.tsx`. */

import { useCanGoBack, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { RepoAvatar } from "../../components/chrome/RepoAvatar";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import {
  AgentsIcon,
  BackArrowIcon,
  ContrastIcon,
  LinearLogo,
  PlayIcon,
  PlugIcon,
  TelescopeIcon,
} from "../../components/icons";
import { Tabs } from "../../components/primitives";
import { useApp } from "../../state/AppContext";
import { alpha } from "../../theme/colors";
import { TriageActionSection } from "./sections/Actions";
import { AgentsSection } from "./sections/Agents";
import { AppearanceSection } from "./sections/Appearance";
import { IntegrationsSection } from "./sections/Integrations";
import { RepoLinearSection } from "./sections/RepoLinear";
import { WorkSection } from "./sections/Work";

type Scope = "app" | "repo";

/** A settings section: its sidebar entry plus the pane to render. */
interface SectionDef {
  key: string;
  label: string;
  icon: ReactNode;
  render: (repo: string) => ReactNode;
}

/** A labelled group of sections, rendered under a header in the sidebar. */
interface NavGroup {
  group: string;
  sections: SectionDef[];
}

type NavNode = SectionDef | NavGroup;

const isGroup = (n: NavNode): n is NavGroup => "group" in n;
/** All sections, flattened out of any groups, for lookup by key. */
const flatten = (nodes: NavNode[]): SectionDef[] =>
  nodes.flatMap((n) => (isGroup(n) ? n.sections : [n]));

const ICON_SIZE = 15;

// The "Actions" group entries, shared between scopes. App scope passes no repo
// (so each pane shows its app-level defaults); repo scope passes the repo (so
// the panes render the per-repo override form).
const triageEntry = (forRepo: boolean): SectionDef => ({
  key: "triage",
  label: "Triage",
  icon: <TelescopeIcon size={ICON_SIZE} />,
  render: (repo) => <TriageActionSection repo={forRepo ? repo : undefined} />,
});
const workEntry = (forRepo: boolean): SectionDef => ({
  key: "work",
  label: "Work",
  icon: <PlayIcon size={ICON_SIZE} />,
  render: (repo) => <WorkSection repo={repo} forRepo={forRepo} />,
});

const APP_NAV: NavNode[] = [
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
    group: "Actions",
    sections: [triageEntry(false), workEntry(false)],
  },
];

const REPO_NAV: NavNode[] = [
  {
    key: "linear",
    label: "Linear",
    icon: <LinearLogo size={ICON_SIZE} />,
    render: (repo) => <RepoLinearSection repo={repo} />,
  },
  { group: "Actions", sections: [triageEntry(true), workEntry(true)] },
];

/** The default section key for a scope (the first one in its nav). */
const defaultSection = (nodes: NavNode[]): string => flatten(nodes)[0].key;

/** Resolve a (possibly stale/deep-linked) section key for a scope's nav. The
 *  legacy `?section=actions` deep-link now lands on the Triage action. */
function resolveSection(nodes: NavNode[], key: string | undefined): SectionDef {
  const sections = flatten(nodes);
  // Legacy deep-links: `actions` → Triage; the former `issues`/`trees` → Work.
  const wanted = key === "actions" ? "triage" : key === "issues" || key === "trees" ? "work" : key;
  return sections.find((s) => s.key === wanted) ?? sections[0];
}

export function SettingsView() {
  const { activeRepo } = useApp();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();

  // Land on a deep-linked section (e.g. `/settings?section=actions`) when given.
  const { section: initialSection } = useSearch({ strict: false }) as { section?: string };
  const [scope, setScope] = useState<Scope>("app");
  const [section, setSection] = useState<string>(() => resolveSection(APP_NAV, initialSection).key);

  const goBack = () => (canGoBack ? router.history.back() : navigate({ to: "/" }));
  const switchScope = (next: Scope) => {
    setScope(next);
    setSection(defaultSection(next === "app" ? APP_NAV : REPO_NAV));
  };

  const nav = scope === "app" ? APP_NAV : REPO_NAV;
  const active = resolveSection(nav, section);

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

  const navButton = (s: SectionDef) => {
    const isActive = active.key === s.key;
    const style: CSSProperties = isActive
      ? {
          background: alpha(15),
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
  };

  return (
    <ViewChrome
      leftCell={backCell}
      rightCell={scopeTabs}
      showRepoSelector={false}
      sidebar={
        <div className="p-2">
          {nav.map((node) =>
            isGroup(node) ? (
              <div key={node.group} className="mt-3 first:mt-0">
                <div className="mb-1 px-3 font-mono text-[10px] tracking-[.07em] text-muted-4 uppercase">
                  {node.group}
                </div>
                {node.sections.map(navButton)}
              </div>
            ) : (
              navButton(node)
            ),
          )}
        </div>
      }
    >
      <div className="flex-1 overflow-y-auto bg-app">
        <div className="max-w-[660px] px-[30px] pt-[26px] pb-11">{active.render(activeRepo)}</div>
      </div>
    </ViewChrome>
  );
}
