-- Bots shown in the sidebar. `kind` = 'icon' (robot icon) or 'shape' (older bots).
CREATE TABLE bots (
    id          TEXT PRIMARY KEY NOT NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('icon', 'shape')),
    icon        TEXT,
    shape       TEXT,
    color       TEXT NOT NULL,
    pinned      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    preview     TEXT NOT NULL DEFAULT '',
    CHECK ((kind = 'icon' AND icon IS NOT NULL) OR (kind = 'shape' AND shape IS NOT NULL))
);

-- Conversation messages. `body` is the serialized `MessageBody` JSON
-- (see src/models.rs), so new message types don't need a migration.
CREATE TABLE messages (
    id          TEXT PRIMARY KEY NOT NULL,
    bot_id      TEXT NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    body        TEXT NOT NULL
);

CREATE INDEX messages_bot_id_created_at ON messages (bot_id, created_at);
