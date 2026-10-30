-- What the Conversation view draws from the hooks beyond a state: the dialog
-- Claude is showing, the header's mode and effort, the status line's output
-- style and vim mode, and the reply as it streams. santree-hook writes all of
-- it, so additive only: an older hook binary still writes its rows without
-- these columns, and the app tells a dialog recorded with the row from one an
-- older write left behind by `pending_at_ms` (it equals `updated_at_ms` only on
-- the write that stored it).

-- The latest `prompt_id`, `permission_mode` and `effort.level` a payload carried.
ALTER TABLE session_state ADD COLUMN prompt_id TEXT;
ALTER TABLE session_state ADD COLUMN permission_mode TEXT;
ALTER TABLE session_state ADD COLUMN effort_level TEXT;

-- The dialog on record for a `permission` / `waiting` row, from its own hook
-- (`PermissionRequest`, `Elicitation`). Written with the row, and replaced by
-- any write that takes the row out of that dialog. `pending_kind` NULL = none.
ALTER TABLE session_state ADD COLUMN pending_kind TEXT;
ALTER TABLE session_state ADD COLUMN pending_tool TEXT;
-- JSON text, valid JSON always: long strings inside are cut to fit the cap,
-- and `pending_truncated` says so.
ALTER TABLE session_state ADD COLUMN pending_input TEXT;
ALTER TABLE session_state ADD COLUMN pending_suggestions TEXT;
ALTER TABLE session_state ADD COLUMN pending_mcp_server TEXT;
ALTER TABLE session_state ADD COLUMN pending_agent_id TEXT;
ALTER TABLE session_state ADD COLUMN pending_agent_type TEXT;
ALTER TABLE session_state ADD COLUMN pending_mode TEXT;
ALTER TABLE session_state ADD COLUMN pending_prompt_id TEXT;
ALTER TABLE session_state ADD COLUMN pending_truncated INTEGER;
ALTER TABLE session_state ADD COLUMN pending_at_ms INTEGER;
-- The dialog was recorded while an earlier one was still open (parallel tool
-- calls, a subagent asking beside the main thread): Claude shows one at a time,
-- and the one on screen may be the other.
ALTER TABLE session_state ADD COLUMN pending_stacked INTEGER;
-- A permission dialog's tool call, as the hooks that report it finished name
-- it: a SHA-256 over its thread, tool and whole input (hex).
ALTER TABLE session_state ADD COLUMN pending_call TEXT;
-- What has been seen of the dialog since, epoch ms, each set once and never
-- moving `updated_at_ms`: the start of the first status-line render after it
-- was recorded (Claude renders none while a dialog is open), and when its own
-- call finished.
ALTER TABLE session_state ADD COLUMN pending_rendered_at_ms INTEGER;
ALTER TABLE session_state ADD COLUMN pending_resolved_at_ms INTEGER;

-- From the status line: `output_style.name` and `vim.mode` (present only with
-- vim mode on).
ALTER TABLE session_usage_live ADD COLUMN output_style TEXT;
ALTER TABLE session_usage_live ADD COLUMN vim_mode TEXT;

-- The reply Claude is drawing, from `MessageDisplay` (registered only while
-- Settings → Experimental → Conversation view is on). One row per line batch:
-- the hooks are async, so a message's batches can land out of order (observed),
-- and the reader joins them by `idx`. Only the newest message of a session is
-- kept, its text capped by dropping its oldest batches.
CREATE TABLE session_live_text (
    session_id TEXT    NOT NULL,
    message_id TEXT    NOT NULL,
    idx        INTEGER NOT NULL,
    turn_id    TEXT,
    prompt_id  TEXT,
    delta      TEXT    NOT NULL,
    final      INTEGER NOT NULL DEFAULT 0,
    -- The batch alone was over the cap and only its tail is kept.
    cut        INTEGER NOT NULL DEFAULT 0,
    -- When the hook that wrote it began, epoch ms.
    fired_ms   INTEGER NOT NULL,
    PRIMARY KEY (session_id, message_id, idx)
);
