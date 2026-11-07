-- Agent teams: an orchestrator (the lead, a regular bot) plus member bots.
-- A bot is in at most one team (`bots.team_id`). `flow` is the custom run
-- order as JSON (see `models::Flow`), used when `mode` = 'flow'.
CREATE TABLE teams (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    purpose     TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL,
    lead_id     TEXT NOT NULL,
    mode        TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'flow')),
    flow        TEXT NOT NULL DEFAULT '{}',
    collapsed   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    preview     TEXT NOT NULL DEFAULT '',
    unread      INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE bots ADD COLUMN team_id TEXT REFERENCES teams (id) ON DELETE SET NULL;
-- What the member does in its team; the orchestrator routes tasks by it.
ALTER TABLE bots ADD COLUMN team_role TEXT NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN team_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX bots_team ON bots (team_id);

-- The team chat is stored with the messages, keyed by the team's id, so
-- `messages.bot_id` is now a chat id (a bot's or a team's) and can't keep its
-- foreign key. Triggers delete a chat's messages with its bot or team.
CREATE TABLE messages_new (
    id          TEXT PRIMARY KEY NOT NULL,
    bot_id      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    body        TEXT NOT NULL
);
INSERT INTO messages_new (id, bot_id, created_at, body) SELECT id, bot_id, created_at, body FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX messages_bot_id_created_at ON messages (bot_id, created_at);

CREATE TRIGGER bots_delete_messages AFTER DELETE ON bots
BEGIN
    DELETE FROM messages WHERE bot_id = OLD.id;
END;

CREATE TRIGGER teams_delete_messages AFTER DELETE ON teams
BEGIN
    DELETE FROM messages WHERE bot_id = OLD.id;
END;
