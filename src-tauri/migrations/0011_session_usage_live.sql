-- Live per-session token/context usage, captured from Claude's status-line
-- stdin (see crates/hook's `statusline` mode). This is Claude's OWN authoritative
-- `used_percentage` + token counts — distinct from usage.rs's transcript-derived
-- reconstruction, which diverges from what Claude actually reports. Written per
-- status-line render (per assistant turn, 300ms-debounced) and read by the app's
-- inline session status line. Upserted by session_id; realtime-pushed over the
-- same signal socket the session_state hooks use.
CREATE TABLE IF NOT EXISTS session_usage_live (
    session_id    TEXT PRIMARY KEY,
    -- Claude's pre-calculated context-window fill, 0..100 (RAW; the display 1.2x
    -- nudge is applied at render time, in both the terminal and GUI bars).
    used_pct      REAL    NOT NULL,
    -- Tokens currently in the context window (input + cache reads + writes).
    input_tokens  INTEGER NOT NULL,
    -- The model's context window size (200000, or 1000000 for extended-context).
    context_size  INTEGER NOT NULL,
    -- Model id (e.g. claude-opus-4-8) — the frontend maps it to a family label.
    model         TEXT    NOT NULL,
    -- Session cost so far, USD (Claude's own `cost.total_cost_usd`).
    cost_usd      REAL    NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
