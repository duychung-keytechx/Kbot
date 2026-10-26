//! Rust -> UI events. Names are mirrored in `src/lib/api.ts`.

use tauri::{AppHandle, Emitter, Manager};

use crate::claude::ClaudeStatus;
use crate::models::{Message, MessageEvent, RunEvent};
use crate::AppState;

pub const BOTS_CHANGED: &str = "kbot://bots";
pub const MESSAGE: &str = "kbot://message";
pub const RUN: &str = "kbot://run";
pub const CLAUDE: &str = "kbot://claude";
pub const CLEARED: &str = "kbot://cleared";
pub const OPEN_SETTINGS: &str = "kbot://open-settings";

/// Emits a message upsert plus the refreshed bot list (preview/time changed).
pub fn message(app: &AppHandle, bot_id: &str, message: Message) {
    message_only(app, bot_id, message);
    bots_changed(app);
}

/// Emits a message upsert alone; used for streamed text between saves.
pub fn message_only(app: &AppHandle, bot_id: &str, message: Message) {
    let _ = app.emit(MESSAGE, MessageEvent { bot_id: bot_id.to_string(), message });
}

pub fn bots_changed(app: &AppHandle) {
    let bots = app.state::<AppState>().store.lock().unwrap().bots();
    let _ = app.emit(BOTS_CHANGED, bots);
}

/// A bot's chat history was deleted; the payload is its id.
pub fn cleared(app: &AppHandle, bot_id: &str) {
    let _ = app.emit(CLEARED, bot_id);
}

pub fn run(app: &AppHandle, bot_id: &str, running: bool) {
    let _ = app.emit(RUN, RunEvent { bot_id: bot_id.to_string(), running });
}

pub fn claude_status(app: &AppHandle, status: &ClaudeStatus) {
    let _ = app.emit(CLAUDE, status);
}

/// Kbot > Settings… was chosen in the menu bar.
pub fn open_settings(app: &AppHandle) {
    let _ = app.emit(OPEN_SETTINGS, ());
}
