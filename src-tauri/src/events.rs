//! Rust -> UI events. Names are mirrored in `src/lib/api.ts`.

use tauri::{AppHandle, Emitter, Manager};

use crate::models::{Message, MessageEvent};
use crate::AppState;

pub const BOTS_CHANGED: &str = "kbot://bots";
pub const MESSAGE: &str = "kbot://message";

/// Emits a message upsert plus the refreshed bot list (preview/time changed).
pub fn message(app: &AppHandle, bot_id: &str, message: Message) {
    let _ = app.emit(MESSAGE, MessageEvent { bot_id: bot_id.to_string(), message });
    bots_changed(app);
}

pub fn bots_changed(app: &AppHandle) {
    let bots = app.state::<AppState>().store.lock().unwrap().bots();
    let _ = app.emit(BOTS_CHANGED, bots);
}
