-- A scheduled job posted something the user hasn't looked at yet: a dot in
-- the sidebar, counted in the Dock badge.
ALTER TABLE bots ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
