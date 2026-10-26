//! Agent runtime. Each reply runs as its own async task and reports back to
//! the UI through events, so the window never blocks on the model.
//!
//! This is a stub: plug the LLM client, tool calls (Gmail, CRM, LinkedIn...)
//! and computer-use loop in here. To stream tokens, emit `kbot://message`
//! repeatedly with the same message id while the text grows.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::events;
use crate::models::{Message, MessageBody};
use crate::AppState;

pub enum Trigger {
    UserMessage(String),
    ComputerHandback,
}

pub fn spawn(app: AppHandle, bot_id: String, trigger: Trigger) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(700)).await;
        let text = match trigger {
            Trigger::UserMessage(text) => format!(
                "On it: \u{201c}{text}\u{201d}. (Stub reply from src-tauri/src/agent.rs, wire your model here.)"
            ),
            Trigger::ComputerHandback => {
                "Thanks, I've got it from here. Looking through your accounts now.".to_string()
            }
        };
        let state = app.state::<AppState>();
        let result = state
            .store
            .lock()
            .unwrap()
            .push_message(&bot_id, Message::new(MessageBody::Agent { text }));
        match result {
            Ok(message) => events::message(&app, &bot_id, message),
            Err(err) => eprintln!("agent reply failed: {err}"),
        }
    });
}
