//! UI -> Rust commands, called from `src/lib/api.ts` via `invoke()`.

use tauri::{AppHandle, State};

use crate::agent::{self, Trigger};
use crate::claude::{self, ClaudeStatus};
use crate::events;
use crate::models::{
    AgentConfig, AppSettings, Avatar, Bot, BotIcon, Control, Message, MessageBody, PermissionAnswer, PermissionStatus, SetupAnswer,
    SetupState,
};
use crate::setup;
use crate::AppState;

type CmdResult<T> = Result<T, String>;

const BUSY: &str = "Wait for the current reply to finish, or stop it.";

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
        setup_state: SetupState::Pending,
        config: AgentConfig::default(),
        last_run_at: None,
        editing: false,
        unread: false,
    };
    state.store.lock().unwrap().insert_bot(bot.clone())?;
    events::bots_changed(&app);
    setup::ensure(&app, &bot.id)?;
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
    let bot = state.store.lock().unwrap().bot(&bot_id)?;
    let setup_command = text.eq_ignore_ascii_case(setup::COMMAND);
    if setup_command && state.runs.running().contains(&bot_id) {
        return Err(BUSY.into());
    }
    let in_setup = bot.setup_state == SetupState::Pending || bot.editing;
    // Claim the bot before saving the message, so a refused send leaves no trace.
    let ticket = match in_setup || setup_command {
        true => None,
        false => Some(state.runs.start(&app, &bot_id).ok_or(BUSY)?),
    };
    let message = state
        .store
        .lock()
        .unwrap()
        .push_message(&bot_id, Message::new(MessageBody::User { text: text.clone() }))?;
    events::message(&app, &bot_id, message.clone());
    match ticket {
        Some(ticket) => agent::spawn(app, ticket, Trigger::UserMessage(text)),
        None if setup_command => setup::command(&app, &bot_id)?,
        None => setup::answer_text(&app, &bot_id, text)?,
    }
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
    let ticket = match control {
        Control::Agent => Some(state.runs.start(&app, &bot_id).ok_or(BUSY)?),
        Control::User => None,
    };
    let message = state.store.lock().unwrap().update_message(&bot_id, &message_id, |m| {
        if let MessageBody::Computer { control: c, .. } = &mut m.body {
            *c = control;
        }
    })?;
    events::message(&app, &bot_id, message.clone());
    if let Some(ticket) = ticket {
        agent::spawn(app, ticket, Trigger::ComputerHandback);
    }
    Ok(message)
}

/// Answers a `Permission` card: lets the waiting Claude Code use the tool,
/// refuses it, or gives it the picked options of an `AskUserQuestion`.
#[tauri::command]
pub fn answer_permission(
    app: AppHandle,
    state: State<AppState>,
    bot_id: String,
    message_id: String,
    answer: PermissionAnswer,
) -> CmdResult<Message> {
    let mut store = state.store.lock().unwrap();
    let message = store.messages(&bot_id).into_iter().find(|m| m.id == message_id).ok_or("Message not found.")?;
    let MessageBody::Permission { request_id, input, status: PermissionStatus::Pending, .. } = message.body else {
        return Err("This was already answered.".into());
    };
    let (decision, status, picked) = match answer {
        PermissionAnswer::Allow => (Ok(input), PermissionStatus::Approved, None),
        PermissionAnswer::Deny => (Err("The user denied this.".to_string()), PermissionStatus::Denied, None),
        PermissionAnswer::Answers { answers } => {
            let mut input = input;
            if let Some(fields) = input.as_object_mut() {
                fields.insert("answers".into(), serde_json::json!(answers));
            }
            (Ok(input), PermissionStatus::Answered, Some(answers))
        }
    };
    // The run that asked is gone (stopped, or the app restarted).
    let sent = state.runs.send(&bot_id, claude::permission_reply(&request_id, decision));
    let message = store.update_message(&bot_id, &message_id, |m| {
        if let MessageBody::Permission { status: s, answers, .. } = &mut m.body {
            *s = if sent { status } else { PermissionStatus::Expired };
            if let (true, Some(picked)) = (sent, picked) {
                *answers = picked;
            }
        }
    })?;
    drop(store);
    events::message_only(&app, &bot_id, message.clone());
    match sent {
        true => Ok(message),
        false => Err("This request expired: the run already ended.".into()),
    }
}

/// Whether Claude Code is installed and signed in; `refresh` skips the cache ("Check again").
#[tauri::command]
pub async fn claude_status(app: AppHandle, refresh: bool) -> ClaudeStatus {
    claude::status(&app, refresh).await
}

/// Bots with a reply, job or setup step in progress.
#[tauri::command]
pub fn running_bots(state: State<AppState>) -> Vec<String> {
    state.runs.running()
}

#[tauri::command]
pub fn cancel_run(state: State<AppState>, bot_id: String) -> bool {
    state.runs.cancel(&bot_id)
}

/// Called when a bot's chat opens: starts or resumes its onboarding.
#[tauri::command]
pub fn ensure_setup(app: AppHandle, bot_id: String) -> CmdResult<()> {
    setup::ensure(&app, &bot_id)
}

/// An onboarding card was answered.
#[tauri::command]
pub fn answer_setup(app: AppHandle, bot_id: String, message_id: String, answer: SetupAnswer) -> CmdResult<Message> {
    setup::answer_card(&app, &bot_id, &message_id, answer)
}

#[tauri::command]
pub fn skip_setup(app: AppHandle, state: State<AppState>, bot_id: String) -> CmdResult<()> {
    state.runs.cancel(&bot_id);
    setup::skip(&app, &bot_id)
}

/// "Edit" in a bot's menu: the same as typing `/setup`, without the message.
#[tauri::command]
pub fn start_setup(app: AppHandle, state: State<AppState>, bot_id: String) -> CmdResult<()> {
    if state.runs.running().contains(&bot_id) {
        return Err(BUSY.into());
    }
    setup::command(&app, &bot_id)
}

/// "Exit setup" while changing a set-up bot with `/setup`.
#[tauri::command]
pub fn exit_setup(app: AppHandle, bot_id: String) -> CmdResult<()> {
    setup::exit_edit(&app, &bot_id)
}

#[tauri::command]
pub fn redo_setup(app: AppHandle, state: State<AppState>, bot_id: String) -> CmdResult<()> {
    if state.runs.running().contains(&bot_id) {
        return Err(BUSY.into());
    }
    state.store.lock().unwrap().set_session_id(&bot_id, None)?;
    setup::restart(&app, &bot_id)
}

/// "Delete Chat" in the sidebar menu: removes the bot, its history and its
/// working directory.
#[tauri::command]
pub fn delete_bot(app: AppHandle, state: State<AppState>, bot_id: String) -> CmdResult<()> {
    if state.runs.running().contains(&bot_id) {
        return Err(BUSY.into());
    }
    state.store.lock().unwrap().delete_bot(&bot_id)?;
    let workdir = agent::workdir(&app, &bot_id);
    let _ = std::fs::remove_dir_all(&workdir);
    // Its transcripts in Claude Code's own folder, in the background since
    // starting the CLI takes a moment.
    let purge_app = app.clone();
    tauri::async_runtime::spawn(async move { claude::purge(&purge_app, &workdir).await });
    events::bots_changed(&app);
    Ok(())
}

/// "Clear History" in the sidebar menu. A bot still being set up starts
/// its setup over, since the setup cards were part of the history; a
/// `/setup` change in progress is dropped.
#[tauri::command]
pub fn clear_chat(app: AppHandle, state: State<AppState>, bot_id: String) -> CmdResult<()> {
    if state.runs.running().contains(&bot_id) {
        return Err(BUSY.into());
    }
    let pending = {
        let mut store = state.store.lock().unwrap();
        store.clear_messages(&bot_id)?;
        let bot = store.bot(&bot_id)?;
        if bot.editing {
            store.set_setup(&bot_id, SetupState::Done, None)?;
        }
        bot.setup_state == SetupState::Pending
    };
    events::cleared(&app, &bot_id);
    if pending {
        setup::restart(&app, &bot_id)?;
    }
    events::bots_changed(&app);
    Ok(())
}

/// Saves the Settings panel.
#[tauri::command]
pub fn update_bot_config(app: AppHandle, state: State<AppState>, bot_id: String, config: AgentConfig) -> CmdResult<Bot> {
    let mut config = config;
    config.workspace_folders = setup::dedupe(config.workspace_folders);
    config.model = config.model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    if let Some(schedule) = &config.schedule {
        schedule.validate()?;
    }
    let bot = {
        let store = state.store.lock().unwrap();
        let old = store.bot(&bot_id)?;
        if let Some(schedule) = &config.schedule {
            crate::scheduler::check_date(schedule, old.config.schedule.as_ref(), chrono::Local::now())?;
        }
        if old.config != config {
            store.set_config(&bot_id, &config)?;
            // A resumed session keeps its first system prompt, so the new
            // config only takes effect in a new session.
            store.set_session_id(&bot_id, None)?;
        }
        store.bot(&bot_id)?
    };
    events::bots_changed(&app);
    Ok(bot)
}

/// "Run now" in Settings.
#[tauri::command]
pub fn run_now(app: AppHandle, state: State<AppState>, bot_id: String) -> CmdResult<()> {
    let bot = state.store.lock().unwrap().bot(&bot_id)?;
    if bot.config.schedule.is_none() {
        return Err("This bot has no scheduled job.".into());
    }
    let ticket = state.runs.start(&app, &bot_id).ok_or(BUSY)?;
    state.store.lock().unwrap().set_last_run_at(&bot_id, chrono::Local::now().timestamp_millis())?;
    agent::spawn(app, ticket, Trigger::Job { manual: true, late: None });
    Ok(())
}

/// The chat on screen while the window is focused, `None` otherwise. That
/// bot is marked read, and its job results don't mark it unread.
#[tauri::command]
pub fn set_viewing(app: AppHandle, state: State<AppState>, bot_id: Option<String>) -> CmdResult<()> {
    *state.viewing.lock().unwrap() = bot_id.clone();
    if let Some(bot_id) = bot_id {
        let changed = state.store.lock().unwrap().set_unread(&bot_id, false)?;
        if changed {
            events::bots_changed(&app);
        }
    }
    Ok(())
}

/// Kbot > Settings….
#[tauri::command]
pub fn get_app_settings(state: State<AppState>) -> AppSettings {
    state.store.lock().unwrap().app_settings()
}

#[tauri::command]
pub fn update_app_settings(state: State<AppState>, settings: AppSettings) -> CmdResult<AppSettings> {
    let default_model = settings.default_model.trim();
    if default_model.is_empty() {
        return Err("Choose a model".into());
    }
    let store = state.store.lock().unwrap();
    store.set_app_settings(&AppSettings { default_model: default_model.to_string() })?;
    Ok(store.app_settings())
}
