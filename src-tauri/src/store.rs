//! Local persistence: a SQLite database (`kbot.db`) in the OS app-data
//! directory. The schema is created and upgraded by `migrate::run` on open.

use std::fs;
use std::path::PathBuf;

use rusqlite::types::Type;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::migrate;
use crate::models::{AgentConfig, AppSettings, Avatar, Bot, DEFAULT_MODEL, Message, MessageBody, SetupState};
use crate::setup::Step;

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

fn from_json<T: DeserializeOwned>(row: &Row, column: &str) -> rusqlite::Result<T> {
    let text: String = row.get(column)?;
    serde_json::from_str(&text).map_err(|e| {
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
    let setup_state: SetupState = from_text(row, "setup_state")?;
    Ok(Bot {
        id: row.get("id")?,
        name: row.get("name")?,
        avatar,
        pinned: row.get("pinned")?,
        updated_at: row.get("updated_at")?,
        preview: row.get("preview")?,
        setup_state,
        config: from_json(row, "config")?,
        last_run_at: row.get("last_run_at")?,
        editing: setup_state == SetupState::Done && row.get::<_, Option<String>>("setup_step")?.is_some(),
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
        self.query_bots("SELECT * FROM bots ORDER BY pinned DESC, created_at DESC, rowid DESC")
    }

    /// Set-up bots with a scheduled job, for the scheduler.
    pub fn scheduled_bots(&self) -> Vec<Bot> {
        self.query_bots(
            "SELECT * FROM bots
             WHERE setup_state != 'pending' AND json_extract(config, '$.schedule') IS NOT NULL",
        )
    }

    fn query_bots(&self, sql: &str) -> Vec<Bot> {
        let query = || -> rusqlite::Result<Vec<Bot>> {
            self.conn.prepare_cached(sql)?.query_map([], bot_from_row)?.collect()
        };
        query().unwrap_or_else(|e| {
            eprintln!("list bots failed: {e}");
            Vec::new()
        })
    }

    pub fn bot(&self, bot_id: &str) -> Result<Bot, String> {
        self.conn
            .query_row("SELECT * FROM bots WHERE id = ?1", [bot_id], bot_from_row)
            .optional()
            .map_err(err)?
            .ok_or_else(|| format!("unknown bot {bot_id}"))
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
                "INSERT INTO bots (id, name, kind, icon, shape, color, pinned, created_at, updated_at, preview,
                                   setup_state, config, last_run_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10, ?11, ?12)",
                params![
                    bot.id,
                    bot.name,
                    kind,
                    icon,
                    shape,
                    color,
                    bot.pinned,
                    bot.updated_at,
                    bot.preview,
                    to_text(&bot.setup_state),
                    serde_json::to_string(&bot.config).map_err(err)?,
                    bot.last_run_at,
                ],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Appends a message and refreshes the bot's sidebar preview/time.
    pub fn push_message(&mut self, bot_id: &str, message: Message) -> Result<Message, String> {
        let tx = self.conn.transaction().map_err(err)?;
        let preview = match &message.body {
            MessageBody::User { text } | MessageBody::Agent { text } => Some(text.clone()),
            MessageBody::Permission { questions, .. } if !questions.is_empty() => Some(questions[0].question.clone()),
            MessageBody::Permission { tool, .. } => Some(format!("Wants to use {tool}. Approve?")),
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
        // A streamed agent reply grows after it was pushed; keep the preview in step.
        if let MessageBody::Agent { text } = &message.body {
            tx.execute("UPDATE bots SET preview = ?2 WHERE id = ?1", params![bot_id, text]).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok(message)
    }

    /// Deletes a bot's chat history and forgets its Claude session, so the
    /// next reply starts fresh. Config and setup state are kept.
    pub fn clear_messages(&mut self, bot_id: &str) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(err)?;
        let updated = tx
            .execute("UPDATE bots SET preview = '', claude_session_id = NULL WHERE id = ?1", params![bot_id])
            .map_err(err)?;
        if updated == 0 {
            return Err(format!("unknown bot {bot_id}"));
        }
        tx.execute("DELETE FROM messages WHERE bot_id = ?1", params![bot_id]).map_err(err)?;
        tx.commit().map_err(err)
    }

    /// Deletes a bot; its messages go with it (`ON DELETE CASCADE`).
    pub fn delete_bot(&mut self, bot_id: &str) -> Result<(), String> {
        match self.conn.execute("DELETE FROM bots WHERE id = ?1", params![bot_id]).map_err(err)? {
            0 => Err(format!("unknown bot {bot_id}")),
            _ => Ok(()),
        }
    }

    /// Runs `UPDATE bots SET <assignments> WHERE id = ?1` and fails on an unknown bot.
    fn update_bot(&self, bot_id: &str, assignments: &str, values: &[&dyn rusqlite::ToSql]) -> Result<(), String> {
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&bot_id];
        params.extend_from_slice(values);
        let sql = format!("UPDATE bots SET {assignments} WHERE id = ?1");
        match self.conn.execute(&sql, params.as_slice()).map_err(err)? {
            0 => Err(format!("unknown bot {bot_id}")),
            _ => Ok(()),
        }
    }

    pub fn set_config(&self, bot_id: &str, config: &AgentConfig) -> Result<(), String> {
        let json = serde_json::to_string(config).map_err(err)?;
        self.update_bot(bot_id, "config = ?2", &[&json])
    }

    pub fn setup_step(&self, bot_id: &str) -> Result<Option<Step>, String> {
        let text: Option<String> = self
            .conn
            .query_row("SELECT setup_step FROM bots WHERE id = ?1", [bot_id], |r| r.get(0))
            .map_err(err)?;
        text.map(|t| serde_json::from_str(&t).map_err(err)).transpose()
    }

    /// Moves onboarding to `step` (`None` = not onboarding) and sets the setup state.
    pub fn set_setup(&self, bot_id: &str, state: SetupState, step: Option<&Step>) -> Result<(), String> {
        let step = step.map(serde_json::to_string).transpose().map_err(err)?;
        self.update_bot(bot_id, "setup_state = ?2, setup_step = ?3", &[&to_text(&state), &step])
    }

    pub fn session_id(&self, bot_id: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row("SELECT claude_session_id FROM bots WHERE id = ?1", [bot_id], |r| r.get(0))
            .map_err(err)
    }

    /// `None` makes the next run start a fresh Claude session.
    pub fn set_session_id(&self, bot_id: &str, session_id: Option<&str>) -> Result<(), String> {
        self.update_bot(bot_id, "claude_session_id = ?2", &[&session_id])
    }

    pub fn set_last_run_at(&self, bot_id: &str, ms: i64) -> Result<(), String> {
        self.update_bot(bot_id, "last_run_at = ?2", &[&ms])
    }

    pub fn app_setting(&self, key: &str) -> Option<String> {
        self.conn
            .query_row("SELECT value FROM app_settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()
            .unwrap_or_else(|e| {
                eprintln!("read app setting {key} failed: {e}");
                None
            })
    }

    pub fn set_app_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn app_settings(&self) -> AppSettings {
        AppSettings { default_model: self.app_setting("default_model").unwrap_or_else(|| DEFAULT_MODEL.into()) }
    }

    pub fn set_app_settings(&self, settings: &AppSettings) -> Result<(), String> {
        self.set_app_setting("default_model", &settings.default_model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{BotIcon, Control, Schedule};

    fn bot(id: &str, updated_at: i64) -> Bot {
        Bot {
            id: id.into(),
            name: format!("Bot {id}"),
            avatar: Avatar::Icon { icon: BotIcon::Happy, color: "#ff8800".into() },
            pinned: false,
            updated_at,
            preview: String::new(),
            setup_state: SetupState::Pending,
            config: AgentConfig::default(),
            last_run_at: None,
            editing: false,
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
    fn app_settings_default_to_sonnet_and_save() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.app_settings().default_model, DEFAULT_MODEL);
        store.set_app_settings(&AppSettings { default_model: "opus".into() }).unwrap();
        store.set_app_settings(&AppSettings { default_model: "claude-opus-5-5".into() }).unwrap();
        assert_eq!(store.app_settings().default_model, "claude-opus-5-5");
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

    #[test]
    fn clear_messages_keeps_the_bot_and_other_chats() {
        let mut store = Store::open_in_memory().unwrap();
        store.insert_bot(bot("a", 1)).unwrap();
        store.insert_bot(bot("b", 2)).unwrap();
        for id in ["a", "b"] {
            store.push_message(id, Message::new(MessageBody::User { text: "hi".into() })).unwrap();
        }
        store.set_session_id("a", Some("s1")).unwrap();

        store.clear_messages("a").unwrap();
        assert!(store.messages("a").is_empty());
        assert_eq!(store.messages("b").len(), 1);
        assert_eq!(store.bot("a").unwrap().preview, "");
        assert_eq!(store.session_id("a").unwrap(), None);
        assert!(store.clear_messages("missing").is_err());
    }

    #[test]
    fn scheduled_bots_are_set_up_with_a_daily_job() {
        let mut store = Store::open_in_memory().unwrap();
        let job = AgentConfig { schedule: Some(Schedule::default()), ..AgentConfig::default() };
        for (id, state, config) in [
            ("job", SetupState::Done, job.clone()),
            ("skipped", SetupState::Skipped, job.clone()),
            ("pending", SetupState::Pending, job),
            ("chat", SetupState::Done, AgentConfig::default()),
        ] {
            store.insert_bot(bot(id, 1)).unwrap();
            store.set_config(id, &config).unwrap();
            store.set_setup(id, state, None).unwrap();
        }
        let mut ids: Vec<_> = store.scheduled_bots().into_iter().map(|b| b.id).collect();
        ids.sort();
        assert_eq!(ids, ["job", "skipped"]);
    }

    #[test]
    fn delete_bot_removes_its_messages() {
        let mut store = Store::open_in_memory().unwrap();
        store.insert_bot(bot("a", 1)).unwrap();
        store.insert_bot(bot("b", 2)).unwrap();
        for id in ["a", "b"] {
            store.push_message(id, Message::new(MessageBody::User { text: "hi".into() })).unwrap();
        }

        store.delete_bot("a").unwrap();
        assert_eq!(store.bots().iter().map(|b| b.id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert!(store.messages("a").is_empty());
        assert_eq!(store.messages("b").len(), 1);
        assert!(store.delete_bot("a").is_err());
    }

    #[test]
    fn migration_0002_keeps_old_bots_and_marks_them_pending() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
        )
        .unwrap();
        let first = &migrate::MIGRATIONS[0];
        conn.execute_batch(first.sql).unwrap();
        conn.execute(
            "INSERT INTO schema_migrations VALUES (?1, ?2, 0)",
            params![first.version, first.name],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO bots (id, name, kind, icon, color, created_at, updated_at, preview)
             VALUES ('old', 'Old', 'icon', 'happy', '#000', 1, 1, 'hi')",
            [],
        )
        .unwrap();

        let store = Store::init(conn).unwrap();
        let old = store.bot("old").unwrap();
        assert_eq!(old.setup_state, SetupState::Pending);
        assert_eq!(old.config, AgentConfig::default());
        assert_eq!(old.preview, "hi");
        assert_eq!(store.session_id("old").unwrap(), None);
        assert_eq!(store.setup_step("old").unwrap(), None);
    }

    #[test]
    fn config_setup_and_session_round_trip() {
        let mut store = Store::open_in_memory().unwrap();
        store.insert_bot(bot("a", 1)).unwrap();
        let config = AgentConfig {
            description: "AI news brief".into(),
            schedule: Some(Schedule { task: "Brief me".into(), ..Schedule::default() }),
            workspace_folders: vec!["/Users/me/notes".into()],
            web_access: true,
            ..AgentConfig::default()
        };
        store.set_config("a", &config).unwrap();
        store.set_setup("a", SetupState::Pending, Some(&Step::Web)).unwrap();
        store.set_session_id("a", Some("s1")).unwrap();
        store.set_last_run_at("a", 42).unwrap();

        let a = store.bot("a").unwrap();
        assert_eq!(a.config, config);
        assert_eq!(a.last_run_at, Some(42));
        assert_eq!(store.setup_step("a").unwrap(), Some(Step::Web));
        assert_eq!(store.session_id("a").unwrap().as_deref(), Some("s1"));

        store.set_setup("a", SetupState::Done, None).unwrap();
        assert_eq!(store.bot("a").unwrap().setup_state, SetupState::Done);
        assert_eq!(store.setup_step("a").unwrap(), None);
        assert!(!a.editing && !store.bot("a").unwrap().editing, "onboarding isn't editing");
        store.set_setup("a", SetupState::Done, Some(&Step::Edit { draft: config.clone() })).unwrap();
        assert!(store.bot("a").unwrap().editing);
        assert!(store.set_config("missing", &config).is_err());
    }
}
