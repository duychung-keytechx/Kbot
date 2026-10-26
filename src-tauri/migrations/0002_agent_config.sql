-- Agent setup and runtime state. Existing bots start as 'pending', so they go
-- through onboarding the next time they are opened.
ALTER TABLE bots ADD COLUMN setup_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (setup_state IN ('pending', 'done', 'skipped'));
-- Current onboarding step as `setup::Step` JSON; NULL when not onboarding.
ALTER TABLE bots ADD COLUMN setup_step TEXT;
-- `AgentConfig` JSON (see src/models.rs), so new settings don't need a migration.
ALTER TABLE bots ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
-- Claude Code session the bot's chat continues (`claude --resume`).
ALTER TABLE bots ADD COLUMN claude_session_id TEXT;
-- Last daily job run, Unix epoch milliseconds.
ALTER TABLE bots ADD COLUMN last_run_at INTEGER;

-- App-wide settings (key/value), e.g. 'claude_path'.
CREATE TABLE app_settings (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL
);
