/** The Settings page: app-wide defaults and per-repo overrides.
 *
 * Settings takes the whole window — the route root swaps the app shell out for
 * it — so it draws its own frame: a left column with the way back to the app,
 * the app/repo scope switch and the section nav (flat items plus headed groups
 * like "Integrations", "Agents" and "Workflow defaults"), and a content column
 * with the one section pane. Each pane lives in `sections/`; shared widgets in
 * `widgets.tsx`. */

import { useCanGoBack, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Repo } from "../../bindings";
import { RepoAvatar } from "../../components/chrome/RepoAvatar";
import {
  AgentIcon,
  BackArrowIcon,
  BoltIcon,
  ChevronDownIcon,
  DocsIcon,
  GearIcon,
  GitHubLogo,
  KeyIcon,
  LinearLogo,
  PencilIcon,
  PlayIcon,
  PrIcon,
  TelescopeIcon,
  TerminalIcon,
} from "../../components/icons";
import { Dropdown, Tabs } from "../../components/primitives";
import { TRAFFIC_LIGHTS_INSET } from "../../components/shell/Sidebar";
import { useRepos } from "../../lib/queries";
import { useApp } from "../../state/AppContext";
import { alpha } from "../../theme/colors";
import { ReviewActionSection, TriageActionSection } from "./sections/Actions";
import { ClaudeAgentSection, CodexAgentSection } from "./sections/Agents";
import { EnglishTutorSection } from "./sections/EnglishTutor";
import { EnvironmentSection } from "./sections/Environment";
import { GeneralSection } from "./sections/General";
import { GitHubSection } from "./sections/GitHub";
import { LinearSection } from "./sections/Linear";
import { PromptsSection } from "./sections/Prompts";
import { RepoLinearSection } from "./sections/RepoLinear";
import { TerminalSection } from "./sections/Terminal";
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
/** DOM id tying a group's heading to the list of items it labels. */
const groupHeadingId = (group: string): string =>
  `settings-nav-${group.toLowerCase().replace(/\s+/g, "-")}`;
/** All sections, flattened out of any groups, for lookup by key. */
const flatten = (nodes: NavNode[]): SectionDef[] =>
  nodes.flatMap((n) => (isGroup(n) ? n.sections : [n]));

const ICON_SIZE = 15;

/** Width of the page's left column. Fixed: this nav is a short list of
 *  fixed-length labels. */
const NAV_WIDTH = 264;

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
  // One item per connected service, and one per agent harness: each provider is
  // its own destination, so the pane it opens is only ever about that provider.
  {
    group: "Integrations",
    sections: [
      {
        key: "linear",
        label: "Linear",
        icon: <LinearLogo size={ICON_SIZE} />,
        render: () => <LinearSection />,
      },
      {
        key: "github",
        label: "GitHub",
        icon: <GitHubLogo size={ICON_SIZE} />,
        render: () => <GitHubSection />,
      },
    ],
  },
  {
    group: "Agents",
    sections: [
      {
        key: "agent-claude",
        label: "Claude Code",
        icon: <AgentIcon kind="Claude" size={ICON_SIZE} />,
        render: () => <ClaudeAgentSection />,
      },
      {
        key: "agent-codex",
        label: "Codex",
        icon: <AgentIcon kind="Codex" size={ICON_SIZE} />,
        render: () => <CodexAgentSection />,
      },
    ],
  },
  // Top-level beside those two groups, not inside Agents: it reports on every
  // provider at once, and on the API services alongside them.
  {
    key: "usage",
    label: "Usage",
    icon: <BoltIcon size={ICON_SIZE} />,
    render: () => <UsageSection />,
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
    key: "terminal",
    label: "Terminal",
    icon: <TerminalIcon size={ICON_SIZE} />,
    render: () => <TerminalSection />,
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

/** Section keys that no longer exist, mapped to where their content lives now.
 *  `integrations` and `agents` were single panes before each provider got its own
 *  item; the status bar's usage panel still links to both, so they land on the
 *  first item of the group that replaced them. */
const LEGACY_SECTIONS: Record<string, string> = {
  actions: "triage",
  appearance: "general",
  issues: "work",
  trees: "work",
  updates: "general",
  integrations: "linear",
  agents: "agent-claude",
};

/** Resolve a (possibly stale/deep-linked) section key for a scope's nav. */
function resolveSection(nodes: NavNode[], key: string | undefined): SectionDef {
  const sections = flatten(nodes);
  const wanted = (key && LEGACY_SECTIONS[key]) ?? key;
  return sections.find((s) => s.key === wanted) ?? sections[0];
}

export function SettingsView() {
  const { data: repos = [] } = useRepos();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const navigate = useNavigate();

  // Land on a deep-linked section (e.g. `/settings?section=actions`) when given.
  const { section: initialSection } = useSearch({ strict: false }) as { section?: string };
  const [scope, setScope] = useState<Scope>("app");
  const [section, setSection] = useState<string>(() => resolveSection(APP_NAV, initialSection).key);

  // Which repo we're *editing* under the Repo scope. Its own state, with its own
  // picker: Settings is a page, reached from anywhere, and "whose settings am I
  // editing" was never the same question as "what am I looking at". It falls
  // back to the first registered project whenever the current pick isn't a known
  // repo (removed from the registry, or nothing picked yet).
  const [settingsRepo, setSettingsRepo] = useState("");
  useEffect(() => {
    if (settingsRepo && repos.some((r) => r.name === settingsRepo)) return;
    setSettingsRepo(repos[0]?.name ?? "");
  }, [repos, settingsRepo]);

  const goBack = () => (canGoBack ? router.history.back() : navigate({ to: "/" }));
  const switchScope = (next: Scope) => {
    setScope(next);
    setSection(defaultSection(next === "app" ? APP_NAV : REPO_NAV));
  };

  const nav = scope === "app" ? APP_NAV : REPO_NAV;
  const active = resolveSection(nav, section);

  const back = (
    <button
      type="button"
      onClick={goBack}
      className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] font-medium text-muted-2 transition-colors hover:bg-hover hover:text-fg-2"
    >
      <BackArrowIcon size={15} />
      Back to app
    </button>
  );

  // The scope switch and, under Repo, the picker for *which* repo's settings are
  // being edited — separate from the app's active repo (changing it here doesn't
  // re-point the app). Stacked, not side by side: a repo name is as long as it is,
  // and beside the tabs the pair overflowed the column and spilled onto the pane.
  const scopeTabs = (
    <>
      <div className="flex h-8 items-center">
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
      </div>
      {scope === "repo" && (
        <RepoScopePicker repos={repos} value={settingsRepo} onChange={setSettingsRepo} />
      )}
    </>
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
        aria-current={isActive ? "page" : undefined}
        className="selection-row mb-0.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-[9px] text-left text-[12.5px]"
        style={style}
      >
        <span className="flex-none opacity-90">{s.icon}</span>
        {s.label}
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      {/* Left column. Its top strip is the window's drag region and reserves
          the traffic-light inset, the same way the shell's sidebar does. */}
      <div
        className="flex flex-none flex-col border-r border-line bg-panel"
        style={{ width: NAV_WIDTH }}
      >
        <div
          data-tauri-drag-region
          className="flex h-[38px] flex-none items-center pr-2"
          style={{ paddingLeft: TRAFFIC_LIGHTS_INSET }}
        />
        <div className="flex flex-none flex-col gap-2 border-b border-line px-2.5 pb-3">
          {back}
          {scopeTabs}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Real headings, not styled text: the groups are how this list is
              structured, so a screen reader has to be able to walk it that way. */}
          <nav aria-label="Settings sections" className="p-2">
            {nav.map((node) =>
              isGroup(node) ? (
                <section
                  key={node.group}
                  aria-labelledby={groupHeadingId(node.group)}
                  className="mt-3 first:mt-0"
                >
                  <h2
                    id={groupHeadingId(node.group)}
                    className="mb-1 px-3 font-mono text-[10px] tracking-[.07em] text-muted-4 uppercase"
                  >
                    {node.group}
                  </h2>
                  {node.sections.map(navButton)}
                </section>
              ) : (
                <div
                  key={node.key}
                  className={node.separatorBefore ? "mt-3 border-t border-line pt-3" : undefined}
                >
                  {navButton(node)}
                </div>
              ),
            )}
          </nav>
        </div>
      </div>

      {/* Content column: a drag strip at the top keeps the window draggable
          across its whole width, then the one section pane. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
        <div data-tauri-drag-region className="h-[38px] flex-none" />
        {active.fullBleed ? (
          <div className="flex min-h-0 min-w-0 flex-1">{active.render(settingsRepo)}</div>
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {/* Centered, deliberately — `mx-auto` has been tried both ways. The
                max-width caps line length; without the centering the column hugs
                the nav and leaves the whole remaining width empty to its right,
                which reads worse on a wide window than symmetric margins do.
                (What actually looked broken here was the repo picker overflowing
                the 264px nav and spilling into this margin; that is fixed at the
                picker, not by moving the pane.) */}
            <div className="mx-auto w-full max-w-[720px] px-5 pt-2 pb-11 sm:px-[30px]">
              {active.render(settingsRepo)}
            </div>
          </div>
        )}
      </div>
    </div>
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
      // Matches the trigger: NAV_WIDTH less the column's px-2.5, so the menu
      // lands over the nav rather than poking into the pane beside it.
      menuClassName="w-[244px] overflow-hidden p-1.5"
      trigger={(toggle) => (
        <button
          type="button"
          onClick={toggle}
          className="flex h-8 w-full cursor-pointer items-center gap-[7px] rounded-md border bg-input-alt px-[9px] transition-colors hover:border-line-strong"
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
