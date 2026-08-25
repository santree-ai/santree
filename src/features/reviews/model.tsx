/**
 * Reviews tab view-model: the org-scoped PR inbox plus the current selection.
 *
 * Mirrors `features/trees/model.tsx` — server data comes from the `useReviews`
 * query; this context only holds the ephemeral selection and exposes the inbox to
 * the sidebar and detail panel. A PR pill elsewhere in the app can deep-link here
 * by setting `reviewFocus` (the PR url) on AppContext, which we resolve to a
 * selection once the inbox is loaded.
 */
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
import { usePersistedState } from "../../lib/usePersistedState";
import { useApp, useAppUi } from "../../state/AppContext";
import type { Grouping, SortMode } from "./grouping";
import { ticketIdFor } from "./ticket";

/** Which file (and optionally line) the diff should scroll to and expand. */
export interface FileFocus {
  path: string;
  line: number | null;
  nonce: number;
}

interface ReviewsModel {
  repo: string;
  inbox: ReviewInbox | undefined;
  loading: boolean;
  /** Every PR across all categories, for selection lookup. */
  allPrs: ReviewPr[];
  /** How the sidebar buckets rows, and what orders them. Sidebar chrome, so both
   *  persist to localStorage rather than the settings table. */
  grouping: Grouping;
  setGrouping: (g: Grouping) => void;
  sort: SortMode;
  setSort: (s: SortMode) => void;
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
   *  the session on first open. Lives here because the ask comes from the rail's
   *  brief section and the tab it opens is in the other column: the same gap
   *  {@link ReviewsModel.fileFocus} crosses. */
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

/** Sidebar chrome, so localStorage rather than the settings table (see the
 *  persistence split in CLAUDE.md). */
const GROUPING_KEY = "santree-reviews-grouping";
const SORT_KEY = "santree-reviews-sort";

export function ReviewsProvider({ children }: { children: ReactNode }) {
  const { activeRepo: repo } = useApp();
  const { reviewFocus, consumeReviewFocus } = useAppUi();
  const { data: inbox, isLoading } = useReviews(repo);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showMergeQueue, setShowMergeQueue] = useState(false);
  const [infoCollapsed, setInfoCollapsed] = useState(false);
  const [infoWidth, setInfoWidth] = useState(400);

  // On compact windows the reading rail becomes an overlay instead of squeezing
  // the diff. Start it closed whenever the viewport crosses into that mode; the
  // header button and ⌘L still open it on demand without losing any information.
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const compact = window.matchMedia("(max-width: 1500px)");
    const collapse = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setInfoCollapsed(true);
    };
    collapse(compact);
    compact.addEventListener("change", collapse);
    return () => compact.removeEventListener("change", collapse);
  }, []);

  // Selecting a PR always returns to the PR detail view; opening the merge queue
  // swaps the pane without disturbing which PR is selected underneath.
  const setActive = useCallback((id: string | null) => {
    setActiveId(id);
    setShowMergeQueue(false);
  }, []);
  const openMergeQueue = useCallback(() => setShowMergeQueue(true), []);
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

  const [grouping, setGrouping] = usePersistedState<Grouping>(GROUPING_KEY, "category");
  const [sort, setSort] = usePersistedState<SortMode>(SORT_KEY, "waiting");

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

  // Resolve every PR's ticket in one batched Linear call. Sorted + deduped so the
  // query key is stable across refetches that return the same inbox in a different
  // order — otherwise every poll would look like a new key and refetch.
  const ticketIds = useMemo(
    () => [...new Set(allPrs.map(ticketIdFor).filter((id): id is string => !!id))].sort(),
    [allPrs],
  );
  // Category sections also use project + priority metadata, so one cached batch
  // enriches both the default inbox and the explicit project grouping.
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

  // A missing selection is intentional: the home surface summarizes the inbox.
  // Only clear an explicit selection that disappeared after a refresh or repo
  // switch; never replace it with an unrelated PR.
  useEffect(() => {
    if (activeId && !allPrs.some((p) => p.id === activeId)) {
      setActiveId(null);
    }
  }, [activeId, allPrs]);

  // Resolve a cross-view deep-link (PR pill → Reviews) to a selection.
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
      inbox,
      loading: isLoading,
      allPrs,
      grouping,
      setGrouping,
      sort,
      setSort,
      ticketFor,
      fileFocus,
      focusFile,
      aiReviewRequest,
      openAiReview,
      activeId,
      setActive,
      active: allPrs.find((p) => p.id === activeId) ?? null,
      showMergeQueue,
      openMergeQueue,
      infoCollapsed,
      toggleInfo,
      infoWidth,
      setInfoWidth,
    }),
    [
      repo,
      inbox,
      isLoading,
      allPrs,
      grouping,
      setGrouping,
      sort,
      setSort,
      ticketFor,
      fileFocus,
      focusFile,
      aiReviewRequest,
      openAiReview,
      activeId,
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
