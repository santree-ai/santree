/** The Settings tab: app-wide defaults and per-repo overrides.
 *
 * This file is just the shell — scope (app/repo) + section state, the sidebar
 * nav (flat items plus grouped sections like "Actions"), and a data-driven
 * dispatch to one section pane. Each pane lives in `sections/`; shared widgets
 * in `widgets.tsx`. */

import { useCanGoBack, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Repo } from "../../bindings";
import { RepoAvatar } from "../../components/chrome/RepoAvatar";
import { ViewChrome } from "../../components/chrome/ViewChrome";
import {
  AgentsIcon,
  BackArrowIcon,
  BoltIcon,
  ChevronDownIcon,
  ContrastIcon,
  DocsIcon,
  GearIcon,
  KeyIcon,
  LinearLogo,
  PencilIcon,
  PlayIcon,
  PlugIcon,
  PrIcon,
  TelescopeIcon,
} from "../../components/icons";
import { Dropdown, Tabs } from "../../components/primitives";
import { useRepos } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { alpha } from "../../theme/colors";
import { ReviewActionSection, TriageActionSection } from "./sections/Actions";
import { AgentsSection } from "./sections/Agents";
import { AppearanceSection } from "./sections/Appearance";
import { EnglishTutorSection } from "./sections/EnglishTutor";
import { EnvironmentSection } from "./sections/Environment";
import { GeneralSection } from "./sections/General";
import { IntegrationsSection } from "./sections/Integrations";
import { PromptsSection } from "./sections/Prompts";
import { RepoLinearSection } from "./sections/RepoLinear";
import { UsageSection } from "./sections/Usage";
import { WorkSection } from "./sections/Work";

type Scope = "app" | "repo";

/** A settings section: its sidebar entry plus the pane to render. */
interface SectionDef {
  key: string;
  label: string;
  icon: ReactNode;
  render: (repo: string) => ReactNode;
  /** Render edge-to-edge, filling the content area (no centered max-width
   *  column) — for panes that own their own multi-column layout, like Prompts. */
  fullBleed?: boolean;
  /** Visually separates shared infrastructure from the workflow group above it. */
  separatorBefore?: boolean;
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
const reviewEntry = (forRepo: boolean): SectionDef => ({
  key: "review",
  label: "Reviews",
  icon: <PrIcon size={ICON_SIZE} />,
  render: (repo) => <ReviewActionSection repo={forRepo ? repo : undefined} />,
});
const promptsEntry = (forRepo: boolean): SectionDef => ({
  key: "prompts",
  label: "Prompts",
  icon: <DocsIcon size={ICON_SIZE} />,
  fullBleed: true,
  separatorBefore: true,
  render: (repo) => <PromptsSection repo={repo} forRepo={forRepo} />,
});

const APP_NAV: NavNode[] = [
  {
    key: "general",
    label: "General",
    icon: <GearIcon size={ICON_SIZE} />,
    render: () => <GeneralSection />,
  },
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
    label: "Provider setup",
    icon: <AgentsIcon size={ICON_SIZE} />,
    render: () => <AgentsSection />,
  },
  {
    key: "english-tutor",
    label: "English tutor",
    icon: <PencilIcon size={ICON_SIZE} />,
    render: () => <EnglishTutorSection />,
  },
  {
    key: "environment",
    label: "Environment",
    icon: <KeyIcon size={ICON_SIZE} />,
    render: () => <EnvironmentSection />,
  },
  {
    key: "usage",
    label: "Usage",
    icon: <BoltIcon size={ICON_SIZE} />,
    render: () => <UsageSection />,
  },
  {
    group: "Workflow defaults",
    sections: [triageEntry(false), workEntry(false), reviewEntry(false)],
  },
  promptsEntry(false),
];

const REPO_NAV: NavNode[] = [
  {
    key: "linear",
    label: "Linear",
    icon: <LinearLogo size={ICON_SIZE} />,
    render: (repo) => <RepoLinearSection repo={repo} />,
  },
  {
    key: "environment",
    label: "Environment",
    icon: <KeyIcon size={ICON_SIZE} />,
    render: (repo) => <EnvironmentSection repo={repo} />,
  },
  {
    group: "Workflow defaults",
    sections: [triageEntry(true), workEntry(true), reviewEntry(true)],
  },
  promptsEntry(true),
];

/** The default section key for a scope (the first one in its nav). */
const defaultSection = (nodes: NavNode[]): string => flatten(nodes)[0].key;

/** Resolve a (possibly stale/deep-linked) section key for a scope's nav. The
 *  legacy `?section=actions` deep-link now lands on the Triage action. */
function resolveSection(nodes: NavNode[], key: string | undefined): SectionDef {
  const sections = flatten(nodes);
  // Legacy deep-links: `actions` → Triage; the former `issues`/`trees` → Work.
  const wanted =
    key === "actions"
      ? "triage"
      : key === "issues" || key === "trees"
        ? "work"
        : key === "updates"
          ? "general"
          : key;
  return sections.find((s) => s.key === wanted) ?? sections[0];
}

export function SettingsView() {
  const { activeRepo } = useApp();
  const { data: repos = [] } = useRepos();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();

  // Land on a deep-linked section (e.g. `/settings?section=actions`) when given.
  const { section: initialSection } = useSearch({ strict: false }) as { section?: string };
  const [scope, setScope] = useState<Scope>("app");
  const [section, setSection] = useState<string>(() => resolveSection(APP_NAV, initialSection).key);

  // Which repo we're *editing* under the Repo scope — independent of the app's
  // active repo, so you can tweak another project's settings from here without
  // switching what the rest of the app is pointed at. Defaults to (and falls
  // back to) the active repo whenever the current pick isn't a known repo.
  const [settingsRepo, setSettingsRepo] = useState(activeRepo);
  useEffect(() => {
    if (!settingsRepo || !repos.some((r) => r.name === settingsRepo)) setSettingsRepo(activeRepo);
  }, [activeRepo, repos, settingsRepo]);

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
    <div className="flex h-full items-center gap-2.5">
      <Tabs<Scope>
        variant="inset"
        className="h-full gap-0.5"
        tabClassName="h-full"
        tabs={[
          { value: "app", label: "User" },
          { value: "repo", label: "Repo" },
        ]}
        value={scope}
        onChange={switchScope}
      />
      {/* Under the Repo scope, pick *which* repo's settings to edit — separate
          from the app's active repo (changing it here doesn't re-point the app). */}
      {scope === "repo" && (
        <RepoScopePicker repos={repos} value={settingsRepo} onChange={setSettingsRepo} />
      )}
    </div>
  );

  const navButton = (s: SectionDef) => {
    const isActive = active.key === s.key;
    const style: CSSProperties = {
      color: isActive ? "var(--color-fg-bright)" : "var(--color-muted)",
    };
    return (
      <button
        type="button"
        key={s.key}
        onClick={() => setSection(s.key)}
        data-active={isActive}
        className="selection-row mb-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-[9px] text-left text-[12.5px]"
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
              <div
                key={node.key}
                className={node.separatorBefore ? "mt-3 border-t border-line pt-3" : undefined}
              >
                {navButton(node)}
              </div>
            ),
          )}
        </div>
      }
    >
      {active.fullBleed ? (
        <div className="flex min-h-0 flex-1 bg-app">{active.render(settingsRepo)}</div>
      ) : (
        <div className="flex-1 overflow-y-auto bg-app">
          <div className="settings-pane mx-auto w-full max-w-[720px] px-5 pt-6 pb-11 sm:px-[30px]">
            {active.render(settingsRepo)}
          </div>
        </div>
      )}
    </ViewChrome>
  );
}

/** The repo picker in the Repo-scope header — selects which repo's settings are
 *  being edited, without touching the app-wide active repo. */
function RepoScopePicker({
  repos,
  value,
  onChange,
}: {
  repos: Repo[];
  value: string;
  onChange: (repo: string) => void;
}) {
  const { accent } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      menuClassName="w-[260px] overflow-hidden p-1.5"
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          className="flex h-full min-w-[180px] cursor-pointer items-center gap-[7px] rounded-md border bg-input-alt px-[9px] transition-colors hover:border-line-strong"
          style={{ borderColor: open ? accent : "var(--color-line-3)" }}
        >
          <RepoAvatar repo={value} size={16} />
          <span className="min-w-0 flex-1 truncate text-left font-mono text-[12px] font-medium text-fg">
            {value}
          </span>
          <ChevronDownIcon size={12} className="flex-none text-muted-3" />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-[9px] pt-1.5 pb-[5px] font-mono text-[9px] tracking-[.07em] text-muted-4 uppercase">
            Repositories
          </div>
          {repos.map((r) => {
            const isActive = r.name === value;
            return (
              <button
                type="button"
                key={r.name}
                onClick={() => {
                  onChange(r.name);
                  close();
                }}
                className="flex w-full cursor-pointer items-center gap-[9px] rounded-md px-[9px] py-2 text-left hover:bg-hover-2"
                style={isActive ? { background: alpha(12, accent) } : undefined}
              >
                <RepoAvatar repo={r.name} size={18} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg">
                  {r.name}
                </span>
                {isActive && (
                  <span className="flex-none text-[12px]" style={{ color: accent }}>
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </>
      )}
    </Dropdown>
  );
}
