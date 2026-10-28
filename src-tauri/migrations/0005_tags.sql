-- Tags group bots in the sidebar. A tag is shared by every bot; `bot_tags`
-- records which bots carry it, in the order they were added.
CREATE TABLE tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color      TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE bot_tags (
    bot_id   TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (bot_id, tag_id)
);

CREATE INDEX bot_tags_tag ON bot_tags (tag_id);
