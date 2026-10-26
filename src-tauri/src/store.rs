//! Local persistence: a SQLite database (`kbot.db`) in the OS app-data
//! directory. The schema is created and upgraded by `migrate::run` on open.

use std::fs;
use std::path::PathBuf;

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::migrate;
use crate::models::{Avatar, Bot, Message, MessageBody};

pub struct Store {
    conn: Connection,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Lowercase serde name of a unit enum variant, e.g. `BotIcon::Happy` -> "happy".
fn to_text<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        other => panic!("expected a string-serialized enum, got {other:?}"),
    }
}

fn from_text<T: DeserializeOwned>(row: &Row, column: &str) -> rusqlite::Result<T> {
    let text: String = row.get(column)?;
    serde_json::from_value(serde_json::Value::String(text)).map_err(|e| {
        let idx = row.as_ref().column_index(column).unwrap_or_default();
        rusqlite::Error::FromSqlConversionFailure(idx, Type::Text, Box::new(e))
    })
}

fn bot_from_row(row: &Row) -> rusqlite::Result<Bot> {
    let color: String = row.get("color")?;
    let avatar = match row.get::<_, String>("kind")?.as_str() {
        "icon" => Avatar::Icon { icon: from_text(row, "icon")?, color },
        _ => Avatar::Shape { shape: from_text(row, "shape")?, color },
    };
    Ok(Bot {
        id: row.get("id")?,
        name: row.get("name")?,
        avatar,
        pinned: row.get("pinned")?,
        updated_at: row.get("updated_at")?,
        preview: row.get("preview")?,
    })
}

fn message_from_row(row: &Row) -> rusqlite::Result<Message> {
    let body: String = row.get("body")?;
    Ok(Message {
        id: row.get("id")?,
        created_at: row.get("created_at")?,
        body: serde_json::from_str(&body).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(e))
        })?,
    })
}

impl Store {
    /// Opens (creating on first run) `dir/kbot.db` and applies pending migrations.
    pub fn open(dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&dir).map_err(err)?;
        Self::init(Connection::open(dir.join("kbot.db")).map_err(err)?)
    }

    #[cfg(test)]
    fn open_in_memory() -> Result<Self, String> {
        Self::init(Connection::open_in_memory().map_err(err)?)
    }

    fn init(mut conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(err)?;
        migrate::run(&mut conn).map_err(|e| format!("database migration failed: {e}"))?;
        Ok(Self { conn })
    }

    /// Pinned bots first, then newest first.
    pub fn bots(&self) -> Vec<Bot> {
        let query = || -> rusqlite::Result<Vec<Bot>> {
            self.conn
                .prepare_cached("SELECT * FROM bots ORDER BY pinned DESC, created_at DESC, rowid DESC")?
                .query_map([], bot_from_row)?
                .collect()
        };
        query().unwrap_or_else(|e| {
            eprintln!("list bots failed: {e}");
            Vec::new()
        })
    }

    pub fn messages(&self, bot_id: &str) -> Vec<Message> {
        let query = || -> rusqlite::Result<Vec<Message>> {
            self.conn
                .prepare_cached(
                    "SELECT id, created_at, body FROM messages
                     WHERE bot_id = ?1 ORDER BY created_at, rowid",
                )?
                .query_map([bot_id], message_from_row)?
                .collect()
        };
        query().unwrap_or_else(|e| {
            eprintln!("list messages failed: {e}");
            Vec::new()
        })
    }

    pub fn insert_bot(&mut self, bot: Bot) -> Result<(), String> {
        let (kind, icon, shape, color) = match &bot.avatar {
            Avatar::Icon { icon, color } => ("icon", Some(to_text(icon)), None, color),
            Avatar::Shape { shape, color } => ("shape", None, Some(to_text(shape)), color),
        };
        self.conn
            .execute(
                "INSERT INTO bots (id, name, kind, icon, shape, color, pinned, created_at, updated_at, preview)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
                params![bot.id, bot.name, kind, icon, shape, color, bot.pinned, bot.updated_at, bot.preview],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Appends a message and refreshes the bot's sidebar preview/time.
    pub fn push_message(&mut self, bot_id: &str, message: Message) -> Result<Message, String> {
        let tx = self.conn.transaction().map_err(err)?;
        let preview = match &message.body {
            MessageBody::User { text } | MessageBody::Agent { text } => Some(text.as_str()),
            _ => None,
        };
        let updated = tx
            .execute(
                "UPDATE bots SET updated_at = ?2, preview = COALESCE(?3, preview) WHERE id = ?1",
                params![bot_id, message.created_at, preview],
            )
            .map_err(err)?;
        if updated == 0 {
            return Err(format!("unknown bot {bot_id}"));
        }
        tx.execute(
            "INSERT INTO messages (id, bot_id, created_at, body) VALUES (?1, ?2, ?3, ?4)",
            params![message.id, bot_id, message.created_at, serde_json::to_string(&message.body).map_err(err)?],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(message)
    }

    pub fn update_message(
        &mut self,
        bot_id: &str,
        message_id: &str,
        f: impl FnOnce(&mut Message),
    ) -> Result<Message, String> {
        let tx = self.conn.transaction().map_err(err)?;
        let mut message = tx
            .query_row(
                "SELECT id, created_at, body FROM messages WHERE id = ?1 AND bot_id = ?2",
                params![message_id, bot_id],
                message_from_row,
            )
            .optional()
            .map_err(err)?
            .ok_or_else(|| format!("unknown message {message_id}"))?;
        f(&mut message);
        tx.execute(
            "UPDATE messages SET body = ?2 WHERE id = ?1",
            params![message_id, serde_json::to_string(&message.body).map_err(err)?],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{BotIcon, Control};

    fn bot(id: &str, updated_at: i64) -> Bot {
        Bot {
            id: id.into(),
            name: format!("Bot {id}"),
            avatar: Avatar::Icon { icon: BotIcon::Happy, color: "#ff8800".into() },
            pinned: false,
            updated_at,
            preview: String::new(),
        }
    }

    #[test]
    fn bots_round_trip_newest_first() {
        let mut store = Store::open_in_memory().unwrap();
        store.insert_bot(bot("a", 1)).unwrap();
        store.insert_bot(bot("b", 2)).unwrap();
        let bots = store.bots();
        assert_eq!(bots.iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert!(matches!(
            &bots[1].avatar,
            Avatar::Icon { icon: BotIcon::Happy, color } if color == "#ff8800"
        ));
    }

    #[test]
    fn first_run_creates_db_and_reopen_keeps_bots() {
        let dir = std::env::temp_dir().join(format!("kbot-test-{}", uuid::Uuid::new_v4()));
        Store::open(dir.clone()).unwrap().insert_bot(bot("a", 1)).unwrap();
        let store = Store::open(dir.clone()).unwrap();
        assert_eq!(store.bots().len(), 1);
        let applied: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(applied, migrate::MIGRATIONS.len() as i64);
        drop(store);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn messages_update_preview_and_control() {
        let mut store = Store::open_in_memory().unwrap();
        store.insert_bot(bot("a", 1)).unwrap();
        store
            .push_message("a", Message::new(MessageBody::User { text: "hi".into() }))
            .unwrap();
        let card = store
            .push_message(
                "a",
                Message::new(MessageBody::Computer { prompt: "log in".into(), control: Control::User }),
            )
            .unwrap();
        assert_eq!(store.bots()[0].preview, "hi");

        store
            .update_message("a", &card.id, |m| {
                if let MessageBody::Computer { control, .. } = &mut m.body {
                    *control = Control::Agent;
                }
            })
            .unwrap();
        let messages = store.messages("a");
        assert_eq!(messages.len(), 2);
        assert!(matches!(messages[1].body, MessageBody::Computer { control: Control::Agent, .. }));
        assert!(store.push_message("missing", Message::new(MessageBody::System { text: "x".into() })).is_err());
    }
}
