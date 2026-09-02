/**
 * The pull request page's one reading column.
 *
 * The header, the sub-tab strip, and the panes that hold prose — Conversation,
 * Commits, Checks — all sit in it, so they share a left edge. They used to
 * disagree: the header and the strip ran the full width of the pane while
 * Conversation and Commits centred themselves at 880 and Checks didn't centre at
 * all, so the title started in one place and the text under it in another.
 *
 * **Files changed is the exception**, and deliberately: a file list and a diff
 * are unreadable run narrow the way prose is unreadable run wide, so that pane
 * runs the full width of the page — no column, and no inset either, since its
 * rows are raised bands that read as a floating card the moment they stop short
 * of the edges (see `PrReviewPane`).
 *
 * A constant rather than four copies of `max-w-[880px]`, because "do these line
 * up" should not be a question you answer by grepping. The rules *between* the
 * bands still span the pane: a hairline is the page's, not the column's.
 */
export const PR_COLUMN = "mx-auto w-full max-w-[880px]";

/**
 * The avatar gutter a conversation comment wears: a 26px face plus the card
 * row's 10px gap.
 *
 * Blocks in the conversation that are not *somebody's* comment — the composer
 * you write in, the index of anchored feedback under it — reserve the same
 * offset without drawing a face, so every box on the page shares one left edge
 * instead of the comments being visibly narrower than everything around them.
 * The description keeps the full column on purpose: it is the proposal the
 * comments are about, not one of them.
 */
export const COMMENT_GUTTER = "ml-9";
