//! UI -> Rust commands, called from `src/lib/api.ts` via `invoke()`.

use tauri::{AppHandle, State};

use crate::agent::{self, Trigger};
use crate::events;
use crate::models::{Avatar, Bot, BotIcon, Control, Message, MessageBody};
use crate::AppState;

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub fn list_bots(state: State<AppState>) -> Vec<Bot> {
    state.store.lock().unwrap().bots()
}

#[tauri::command]
pub fn get_messages(state: State<AppState>, bot_id: String) -> Vec<Message> {
    state.store.lock().unwrap().messages(&bot_id)
}

#[tauri::command]
pub fn create_bot(
    app: AppHandle,
    state: State<AppState>,
    name: String,
    icon: BotIcon,
    color: String,
) -> CmdResult<Bot> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Bot name is required".into());
    }
    let bot = Bot {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        avatar: Avatar::Icon { icon, color },
        pinned: false,
        updated_at: chrono::Utc::now().timestamp_millis(),
        preview: String::new(),
    };
    state.store.lock().unwrap().insert_bot(bot.clone())?;
    events::bots_changed(&app);
    Ok(bot)
}

#[tauri::command]
pub fn send_message(
    app: AppHandle,
    state: State<AppState>,
    bot_id: String,
    text: String,
) -> CmdResult<Message> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Message is empty".into());
    }
    let message = state
        .store
        .lock()
        .unwrap()
        .push_message(&bot_id, Message::new(MessageBody::User { text: text.clone() }))?;
    events::message(&app, &bot_id, message.clone());
    agent::spawn(app, bot_id, Trigger::UserMessage(text));
    Ok(message)
}

/// "Take over" / "I'm done" on a Computer card.
#[tauri::command]
pub fn set_computer_control(
    app: AppHandle,
    state: State<AppState>,
    bot_id: String,
    message_id: String,
    control: Control,
) -> CmdResult<Message> {
    let message = state.store.lock().unwrap().update_message(&bot_id, &message_id, |m| {
        if let MessageBody::Computer { control: c, .. } = &mut m.body {
            *c = control;
        }
    })?;
    events::message(&app, &bot_id, message.clone());
    if control == Control::Agent {
        agent::spawn(app, bot_id, Trigger::ComputerHandback);
    }
    Ok(message)
}
