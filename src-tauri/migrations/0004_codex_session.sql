-- Codex keeps its own conversation thread per bot, next to the Claude session,
-- so switching providers in Settings doesn't lose either one.
ALTER TABLE bots ADD COLUMN codex_session_id TEXT;
