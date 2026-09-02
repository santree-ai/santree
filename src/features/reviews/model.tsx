/**
 * Reviews tab view-model: the registry-wide PR inbox plus the current selection.
 *
 * Mirrors `features/trees/model.tsx` — server data comes from the `useReviews`
 * query; this context only holds the ephemeral selection and exposes the inbox to
 * the detail panel. A PR pill elsewhere in the app, and every row of the app
 * sidebar's Reviews sections, deep-links here by setting `reviewFocus` (the PR
 * url) on AppContext, which we resolve to a selection once the inbox is loaded.
 *
 * **The scope comes from the route** (`?project=`), and is applied once, here.
 * The sidebar's Reviews section is the way into this view, so the common case is
 * one project — and putting the narrowing in the URL rather than in view state is
 * what lets a reload land back on the same inbox. Unscoped is still a real state:
 * a PR from a repo you never cloned belongs to no project, and the command
 * palette's Reviews entry is deliberately the everything view.
 *
 * **Which pane is showing comes from the route too** — `?pr=` for a pull request,
 * `?queue=` for the merge queue. Both are asked for from the sidebar, which is
 * outside this provider and cannot set view state; holding either here left a rail
 * row that opened nothing on a reload.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { ReviewInbox, ReviewPr, TicketRef } from "../../bindings";
import { usePrTickets, useReviews } from "../../lib/queries";
import { targetOwnsKey } from "../../lib/useKeyboardShortcuts";
import { useApp, useAppUi } from "../../state/AppContext";
import { inboxOfProject } from "./grouping";
import { ticketIdFor } from "./ticket";

/** Which file (and optionally line) the diff should scroll to and expand. */
export interface FileFocus {
  path: string;
  line: number | null;
  nonce: number;
}

interface ReviewsModel {
  /** The santree project every repo-scoped read here keys off: the scope when
   *  there is one, else whatever project the rest of the app is pointed at. */
  repo: string;
  /** The registered project the route scoped this view to, or `null` for every
   *  project. What decides whether the repo-scoped merge queue has a repo to be
   *  about. */
  scope: string | null;
  inbox: ReviewInbox | undefined;
  loading: boolean;
  /** Every PR across all categories, for selection lookup. */
  allPrs: ReviewPr[];
  /** The Linear ticket behind a PR, when it has one and Linear knows it — the
   *  project grouping's input. */
  ticketFor: (pr: ReviewPr) => TicketRef | undefined;
  /** A jump request from the review brief into the diff. `nonce` (not just the
   *  path) so clicking the same entry twice re-scrolls rather than being a no-op
   *  the second time. */
  fileFocus: FileFocus | null;
  focusFile: (path: string, line?: number | null) => void;
  /** Bumped by {@link ReviewsModel.openAiReview}. A nonce rather than a boolean so
   *  asking twice re-opens the tab instead of being a silent no-op. */
  aiReviewRequest: number;
  /** "Review this PR with AI" — opens the main panel's AI review tab, launching
   *  the session on first open. Lives here because the ask comes from the info
   *  rail's brief section and the tab it opens is in the other column: the same
   *  gap {@link ReviewsModel.fileFocus} crosses. */
  openAiReview: () => void;
  activeId: string | null;
  setActive: (id: string | null) => void;
  /** The currently selected PR, or null. */
  active: ReviewPr | null;
  /** When true, the detail pane shows the repo's merge queue instead of a PR. */
  showMergeQueue: boolean;
  openMergeQueue: () => void;
  /** The full-height right info rail (PR description + conversation). Collapsed
   *  state + width are view-local; ⌘L (and the header button) toggle it. */
  infoCollapsed: boolean;
  toggleInfo: () => void;
  infoWidth: number;
  setInfoWidth: (w: number) => void;
}

const ReviewsContext = createContext<ReviewsModel | null>(null);

export function ReviewsProvider({ children }: { children: ReactNode }) {
  const { activeRepo } = useApp();
  const { reviewFocus, consumeReviewFocus } = useAppUi();
  // `strict: false` because this provider is also rendered in tests, where there
  // is no matched route to read a typed search off.
  const {
    project,
    pr: openPrUrl,
    queue,
  } = useSearch({ strict: false }) as {
    project?: string;
    pr?: string;
    queue?: true;
  };
  const navigate = useNavigate();
  const scope = project ?? null;
  // The scoped project is a registry name, so it is a valid `repo` for every
  // repo-scoped read below — and a truer one than the active project, which a
  // reload restores independently of the URL.
  const repo = scope ?? activeRepo;
  const { data: allProjects, isLoading } = useReviews();
  const inbox = useMemo(
    () => (scope && allProjects ? inboxOfProject(allProjects, scope) : allProjects),
    [allProjects, scope],
  );
  const [infoCollapsed, setInfoCollapsed] = useState(false);
  const [infoWidth, setInfoWidth] = useState(400);

  const toggleInfo = useCallback(() => setInfoCollapsed((c) => !c), []);

  // ⌘L toggles the info rail (mirrors the Trees file panel). Owned here so no
  // shallow consumer component is needed just to register the shortcut.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (targetOwnsKey(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyL") {
        e.preventDefault();
        setInfoCollapsed((c) => !c);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const allPrs = useMemo(() => {
    if (!inbox) return [];
    const seen = new Set<string>();
    return [...inbox.mine, ...inbox.requested, ...inbox.teams.flatMap((team) => team.prs)].filter(
      (pr) => {
        if (seen.has(pr.id)) return false;
        seen.add(pr.id);
        return true;
      },
    );
  }, [inbox]);

  // The selection, read straight off the route — no second copy to keep in step
  // with it. A PR that leaves the inbox simply stops resolving, and the view
  // falls back to its landing surface without anything having to notice.
  const active = allPrs.find((p) => p.url === openPrUrl) ?? null;
  const activeId = active?.id ?? null;
  const showMergeQueue = !!queue;

  // The selection is written to the route rather than held here, so the sidebar
  // can light up the row you are on (see the route's own comment). `replace`
  // because picking through an inbox is browsing, not a trail of stops you would
  // want to walk back one PR at a time.
  //
  // A PR and the merge queue are two states of one pane, so each of the two
  // writers below clears the other. Leaving `?queue=` set behind a selected PR
  // would put the queue back the next time the url was read, over the PR the
  // sidebar is lighting up.
  const setActive = useCallback(
    (id: string | null) => {
      const url = id ? (allPrs.find((p) => p.id === id)?.url ?? null) : null;
      void navigate({
        to: "/reviews",
        search: (prev: { project?: string }) => ({
          ...prev,
          pr: url ?? undefined,
          queue: undefined,
        }),
        replace: true,
      });
    },
    [allPrs, navigate],
  );

  const openMergeQueue = useCallback(() => {
    void navigate({
      to: "/reviews",
      search: (prev: { project?: string }) => ({ ...prev, queue: true as const, pr: undefined }),
      replace: true,
    });
  }, [navigate]);

  // Resolve every PR's ticket in one batched Linear call. Sorted + deduped so the
  // query key is stable across refetches that return the same inbox in a different
  // order — otherwise every poll would look like a new key and refetch.
  const ticketIds = useMemo(
    () => [...new Set(allPrs.map(ticketIdFor).filter((id): id is string => !!id))].sort(),
    [allPrs],
  );
  // The landing surface and the PR's own info rail both read project + priority
  // metadata off this one cached batch.
  const { data: tickets } = usePrTickets(repo, ticketIds);
  const ticketsById = useMemo(
    () => new Map((tickets ?? []).map((t) => [t.identifier, t])),
    [tickets],
  );
  const ticketFor = useCallback(
    (pr: ReviewPr) => {
      const id = ticketIdFor(pr);
      return id ? ticketsById.get(id) : undefined;
    },
    [ticketsById],
  );

  const [fileFocus, setFileFocus] = useState<FileFocus | null>(null);
  const focusFile = useCallback((path: string, line: number | null = null) => {
    setFileFocus((prev) => ({ path, line, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  // A focus belongs to *one* PR's diff; carrying it across a selection change
  // would scroll the next PR to a path that may not even be in it. Reset during
  // render (React's adjust-state-on-prop-change pattern) rather than in an effect,
  // so the diff never sees the previous PR's focus for a frame.
  const [aiReviewRequest, setAiReviewRequest] = useState(0);
  const openAiReview = useCallback(() => setAiReviewRequest((n) => n + 1), []);
  const [focusOwner, setFocusOwner] = useState(activeId);
  if (focusOwner !== activeId) {
    setFocusOwner(activeId);
    setFileFocus(null);
    // Same reason: a pending ask must not open the *next* PR's review tab and
    // spend a checkout on a PR the user only clicked past.
    setAiReviewRequest(0);
  }

  // Resolve a cross-view deep-link (a PR pill elsewhere in the app) into the
  // route, which is where the selection lives. Nothing to reconcile afterwards:
  // a PR that disappears from the inbox stops resolving and the view falls back
  // to its landing surface on its own.
  useEffect(() => {
    if (!reviewFocus) return;
    const match = allPrs.find((p) => p.url === reviewFocus);
    if (match) {
      setActive(match.id);
      consumeReviewFocus();
    }
  }, [reviewFocus, allPrs, consumeReviewFocus, setActive]);

  const value = useMemo<ReviewsModel>(
    () => ({
      repo,
      scope,
      inbox,
      loading: isLoading,
      allPrs,
      ticketFor,
      fileFocus,
      focusFile,
      aiReviewRequest,
      openAiReview,
      activeId,
      setActive,
      active,
      showMergeQueue,
      openMergeQueue,
      infoCollapsed,
      toggleInfo,
      infoWidth,
      setInfoWidth,
    }),
    [
      repo,
      scope,
      inbox,
      isLoading,
      allPrs,
      ticketFor,
      fileFocus,
      focusFile,
      aiReviewRequest,
      openAiReview,
      activeId,
      active,
      setActive,
      showMergeQueue,
      openMergeQueue,
      infoCollapsed,
      toggleInfo,
      infoWidth,
    ],
  );

  return <ReviewsContext.Provider value={value}>{children}</ReviewsContext.Provider>;
}

export function useReviewsModel(): ReviewsModel {
  const ctx = useContext(ReviewsContext);
  if (!ctx) throw new Error("useReviewsModel must be used within <ReviewsProvider>");
  return ctx;
}
