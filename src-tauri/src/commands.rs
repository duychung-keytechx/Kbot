//! UI -> Rust commands, called from `src/lib/api.ts` via `invoke()`.

use std::collections::HashMap;

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::agent::{self, Trigger};
use crate::claude::{self, ClaudeStatus};
use crate::codex::{self, CodexModels, CodexStatus};
use crate::events;
use crate::models::{
    AgentConfig, AppSettings, Avatar, Bot, BotImage, Control, Flow, Message, MessageBody, PermissionAnswer, PermissionStatus,
    PlanEdit, SetupAnswer, SetupState, Tag, TaskAction, Team, TeamMode,
};
use crate::setup;
use crate::store::Store;
use crate::teams::{self, Signal};
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
    image: BotImage,
) -> CmdResult<Bot> {
    let bot = Bot {
        id: uuid::Uuid::new_v4().to_string(),
        name: Bot::clean_name(&name)?,
        avatar: Avatar::Image { image },
        pinned: false,
        updated_at: chrono::Utc::now().timestamp_millis(),
        preview: String::new(),
        setup_state: SetupState::Pending,
        config: AgentConfig::default(),
        last_run_at: None,
        editing: false,
        unread: false,
        tags: Vec::new(),
        team_id: None,
        team_role: String::new(),
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
    // A team member working on a task: the text goes into that task.
    if let Some(team_id) = bot.team_id.as_deref().filter(|t| state.teams.working(t, &bot_id))
        && !in_setup
        && !setup_command
    {
        let message = state
            .store
            .lock()
            .unwrap()
            .push_message(&bot_id, Message::new(MessageBody::User { text: text.clone() }))?;
        events::message(&app, &bot_id, message.clone());
        state.teams.send(team_id, Signal::StepIn { member_id: bot_id.clone(), text });
        return Ok(message);
    }
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

/// Whether the Codex CLI is installed and signed in (or set up with its own
/// model provider); `refresh` skips the cache.
#[tauri::command]
pub async fn codex_status(app: AppHandle, refresh: bool) -> CodexStatus {
    codex::status(&app, refresh).await
}

/// The Codex models to offer in Kbot > Settings….
#[tauri::command]
pub async fn codex_models() -> CodexModels {
    tauri::async_runtime::spawn_blocking(codex::models).await.unwrap_or(CodexModels { configured: None, models: Vec::new() })
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
    state.store.lock().unwrap().forget_sessions(&bot_id)?;
    setup::restart(&app, &bot_id)
}

/// "Delete Chat" in the sidebar menu: removes the bot, its history and its
/// working directory.
#[tauri::command]
pub fn delete_bot(app: AppHandle, state: State<AppState>, bot_id: String) -> CmdResult<()> {
    if state.runs.running().contains(&bot_id) {
        return Err(BUSY.into());
    }
    {
        let mut store = state.store.lock().unwrap();
        leave_team(&store, &state, &bot_id)?;
        store.delete_bot(&bot_id)?;
    }
    let workdir = agent::workdir(&app, &bot_id);
    let _ = std::fs::remove_dir_all(&workdir);
    // Its transcripts in Claude Code's own folder, in the background since
    // starting the CLI takes a moment.
    let purge_app = app.clone();
    tauri::async_runtime::spawn(async move { claude::purge(&purge_app, &workdir).await });
    events::bots_changed(&app);
    events::teams_changed(&app);
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
    // A team chat (the id is the team's).
    if state.store.lock().unwrap().team(&bot_id).is_ok() {
        state.store.lock().unwrap().clear_messages(&bot_id)?;
        events::cleared(&app, &bot_id);
        events::teams_changed(&app);
        return Ok(());
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
    let clean = |model: Option<String>| model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    config.model = clean(config.model);
    config.codex_model = clean(config.codex_model);
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
            store.forget_sessions(&bot_id)?;
        }
        store.bot(&bot_id)?
    };
    events::bots_changed(&app);
    Ok(bot)
}

/// "Edit" in a bot's menu.
#[tauri::command]
pub fn rename_bot(app: AppHandle, state: State<AppState>, bot_id: String, name: String) -> CmdResult<Bot> {
    let name = Bot::clean_name(&name)?;
    let bot = {
        let store = state.store.lock().unwrap();
        if store.bot(&bot_id)?.name != name {
            store.set_name(&bot_id, &name)?;
            // The system prompt names the bot; see `update_bot_config`.
            store.forget_sessions(&bot_id)?;
        }
        store.bot(&bot_id)?
    };
    events::bots_changed(&app);
    Ok(bot)
}

#[tauri::command]
pub fn list_tags(state: State<AppState>) -> Vec<Tag> {
    state.store.lock().unwrap().tags()
}

/// "+ New tag", or Enter in a bot's tag field (with `bot_id`, which also gets the tag).
#[tauri::command]
pub fn create_tag(app: AppHandle, state: State<AppState>, name: String, bot_id: Option<String>) -> CmdResult<Tag> {
    let name = Tag::clean_name(&name)?;
    let (tag, tags) = {
        let store = state.store.lock().unwrap();
        let tag = store.insert_tag(&name)?;
        if let Some(bot_id) = &bot_id {
            store.set_bot_tag(bot_id, &tag.id, true)?;
        }
        (tag, store.tags())
    };
    events::tags_changed(&app, tags);
    if bot_id.is_some() {
        events::bots_changed(&app);
    }
    Ok(tag)
}

#[tauri::command]
pub fn rename_tag(app: AppHandle, state: State<AppState>, tag_id: String, name: String) -> CmdResult<()> {
    let name = Tag::clean_name(&name)?;
    let tags = {
        let store = state.store.lock().unwrap();
        store.rename_tag(&tag_id, &name)?;
        store.tags()
    };
    events::tags_changed(&app, tags);
    Ok(())
}

#[tauri::command]
pub fn set_tag_color(app: AppHandle, state: State<AppState>, tag_id: String, color: String) -> CmdResult<()> {
    let tags = {
        let store = state.store.lock().unwrap();
        store.set_tag_color(&tag_id, &color)?;
        store.tags()
    };
    events::tags_changed(&app, tags);
    Ok(())
}

/// "Delete tag…": takes it off every bot too.
#[tauri::command]
pub fn delete_tag(app: AppHandle, state: State<AppState>, tag_id: String) -> CmdResult<()> {
    let tags = {
        let store = state.store.lock().unwrap();
        store.delete_tag(&tag_id)?;
        store.tags()
    };
    events::tags_changed(&app, tags);
    events::bots_changed(&app);
    Ok(())
}

/// Checks or unchecks a tag for a bot.
#[tauri::command]
pub fn set_bot_tag(app: AppHandle, state: State<AppState>, bot_id: String, tag_id: String, on: bool) -> CmdResult<()> {
    if state.store.lock().unwrap().set_bot_tag(&bot_id, &tag_id, on)? {
        events::bots_changed(&app);
    }
    Ok(())
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
        let (bot, team) = {
            let store = state.store.lock().unwrap();
            (store.set_unread(&bot_id, false)?, store.set_team_unread(&bot_id, false)?)
        };
        if bot {
            events::bots_changed(&app);
        }
        if team {
            events::teams_changed(&app);
        }
    }
    Ok(())
}

/// Kbot > Settings….
#[tauri::command]
pub fn get_app_settings(state: State<AppState>) -> AppSettings {
    state.store.lock().unwrap().app_settings()
}

/// Saves Kbot > Settings… and tells every window (the provider decides
/// which Connect screen and model field show).
#[tauri::command]
pub fn update_app_settings(app: AppHandle, state: State<AppState>, settings: AppSettings) -> CmdResult<AppSettings> {
    let default_model = settings.default_model.trim().to_string();
    if default_model.is_empty() {
        return Err("Choose a model".into());
    }
    let codex_model = settings.codex_model.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    let saved = {
        let store = state.store.lock().unwrap();
        store.set_app_settings(&AppSettings { default_model, codex_model, ..settings })?;
        store.app_settings()
    };
    events::settings_changed(&app, &saved);
    Ok(saved)
}

// Teams

/// A bot made for a team: the orchestrator, or a member added from the
/// team. It skips onboarding; its description is what it does in the team.
fn team_bot(name: &str, image: BotImage, description: &str, instructions: &str) -> CmdResult<Bot> {
    Ok(Bot {
        id: uuid::Uuid::new_v4().to_string(),
        name: Bot::clean_name(name)?,
        avatar: Avatar::Image { image },
        pinned: false,
        updated_at: chrono::Utc::now().timestamp_millis(),
        preview: String::new(),
        setup_state: SetupState::Skipped,
        config: AgentConfig {
            description: description.trim().to_string(),
            instructions: instructions.trim().to_string(),
            web_access: true,
            ..AgentConfig::default()
        },
        last_run_at: None,
        editing: false,
        unread: false,
        tags: Vec::new(),
        team_id: None,
        team_role: String::new(),
    })
}

/// Takes `bot_id` out of its team, if any, and out of that team's flow. An
/// orchestrator can't leave, and nobody leaves a team that's working.
fn leave_team(store: &Store, state: &AppState, bot_id: &str) -> CmdResult<()> {
    let Some(team_id) = store.bot(bot_id)?.team_id else { return Ok(()) };
    let team = store.team(&team_id)?;
    if team.lead_id == bot_id {
        return Err(format!("This bot is {}'s orchestrator. Make another member the orchestrator first.", team.name));
    }
    if state.teams.is_live(&team_id) {
        return Err(teams::BUSY.into());
    }
    let members: Vec<String> = team.members.into_iter().filter(|m| m != bot_id).collect();
    store.set_team_flow(&team_id, team.mode, &team.flow.normalized(&members))?;
    store.set_bot_team(bot_id, None)
}

/// Puts `bot_id` in `team_id` (moving it from another team).
fn join_team(store: &Store, state: &AppState, team_id: &str, bot_id: &str, role: Option<&str>) -> CmdResult<()> {
    if store.bot(bot_id)?.team_id.as_deref() != Some(team_id) {
        leave_team(store, state, bot_id)?;
        store.set_bot_team(bot_id, Some(team_id))?;
    }
    if let Some(role) = role {
        store.set_team_role(bot_id, role.trim())?;
    }
    Ok(())
}

fn team_of(store: &Store, team_id: &str) -> CmdResult<Team> {
    store.team(team_id)
}

/// Emits bots and teams and returns the team as the UI shows it.
fn team_changed(app: &AppHandle, team_id: &str) -> CmdResult<Team> {
    events::bots_changed(app);
    events::teams_changed(app);
    teams::list(app).into_iter().find(|t| t.id == team_id).ok_or_else(|| format!("unknown team {team_id}"))
}

#[tauri::command]
pub fn list_teams(app: AppHandle) -> Vec<Team> {
    teams::list(&app)
}

/// A member in the "Create team" wizard: an existing bot, or a new agent.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMember {
    /// What the wizard's flow nodes call it (`FlowNode::member_id`).
    pub key: String,
    #[serde(default)]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub image: Option<BotImage>,
    #[serde(default)]
    pub role: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTeam {
    pub name: String,
    pub purpose: String,
    pub color: String,
    pub lead_name: String,
    pub lead_image: BotImage,
    pub instructions: String,
    pub mode: TeamMode,
    pub members: Vec<NewMember>,
    /// Members are named by `NewMember::key` here.
    #[serde(default)]
    pub flow: Flow,
}

/// "Create team" at the end of the wizard.
#[tauri::command]
pub fn create_team(app: AppHandle, state: State<AppState>, team: NewTeam) -> CmdResult<Team> {
    let name = Team::clean_name(&team.name)?;
    Tag::check_color(&team.color)?;
    let lead = team_bot(&team.lead_name, team.lead_image, &team.purpose, &team.instructions)?;
    let team_id = uuid::Uuid::new_v4().to_string();
    {
        let mut store = state.store.lock().unwrap();
        // Check the existing bots before changing anything.
        for member in &team.members {
            if let Some(bot_id) = &member.bot_id {
                let bot = store.bot(bot_id)?;
                if let Some(other) = bot.team_id.as_deref().map(|t| store.team(t)).transpose()? {
                    if other.lead_id == bot.id {
                        return Err(format!("{} is {}'s orchestrator and can't move.", bot.name, other.name));
                    }
                    if state.teams.is_live(&other.id) {
                        return Err(format!("{} is working in {}. Wait for it to finish.", bot.name, other.name));
                    }
                }
            } else {
                Bot::clean_name(&member.name)?;
            }
        }
        store.insert_bot(lead.clone())?;
        store.insert_team(&Team {
            id: team_id.clone(),
            name,
            purpose: team.purpose.trim().to_string(),
            color: team.color.clone(),
            lead_id: lead.id.clone(),
            mode: team.mode,
            flow: Flow::default(),
            collapsed: false,
            updated_at: chrono::Utc::now().timestamp_millis(),
            preview: String::new(),
            unread: false,
            members: Vec::new(),
            activity: None,
        })?;
        let mut ids: HashMap<String, String> = HashMap::new();
        for member in &team.members {
            let bot_id = match &member.bot_id {
                Some(bot_id) => {
                    let role = Some(member.role.as_str()).filter(|r| !r.trim().is_empty());
                    join_team(&store, &state, &team_id, bot_id, role)?;
                    bot_id.clone()
                }
                None => {
                    let image = member.image.unwrap_or(BotImage::Bot01);
                    let bot = team_bot(&member.name, image, &member.role, "")?;
                    store.insert_bot(bot.clone())?;
                    join_team(&store, &state, &team_id, &bot.id, Some(&member.role))?;
                    bot.id
                }
            };
            ids.insert(member.key.clone(), bot_id);
        }
        let mut flow = team.flow;
        for node in &mut flow.nodes {
            node.member_id = ids.get(&node.member_id).cloned().unwrap_or_default();
        }
        let members: Vec<String> = ids.into_values().collect();
        store.set_team_flow(&team_id, team.mode, &flow.normalized(&members))?;
    }
    team_changed(&app, &team_id)
}

/// "Team settings": the Team Info and Flow tabs. The orchestrator's name
/// and instructions are its own bot's (`rename_bot`, `update_bot_config`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamInfo {
    pub name: String,
    pub purpose: String,
    pub color: String,
    pub mode: TeamMode,
    pub flow: Flow,
}

#[tauri::command]
pub fn update_team(app: AppHandle, state: State<AppState>, team_id: String, info: TeamInfo) -> CmdResult<Team> {
    let name = Team::clean_name(&info.name)?;
    Tag::check_color(&info.color)?;
    {
        let store = state.store.lock().unwrap();
        let team = team_of(&store, &team_id)?;
        let flow = info.flow.normalized(&team.members);
        store.set_team_info(&Team { name, purpose: info.purpose.trim().to_string(), color: info.color, mode: info.mode, flow, ..team })?;
    }
    team_changed(&app, &team_id)
}

/// The team row's chevron in the sidebar.
#[tauri::command]
pub fn set_team_collapsed(app: AppHandle, state: State<AppState>, team_id: String, collapsed: bool) -> CmdResult<()> {
    state.store.lock().unwrap().set_team_collapsed(&team_id, collapsed)?;
    events::teams_changed(&app);
    Ok(())
}

/// "Add existing bot" and "Move to team ›".
#[tauri::command]
pub fn add_team_member(
    app: AppHandle,
    state: State<AppState>,
    team_id: String,
    bot_id: String,
    role: Option<String>,
) -> CmdResult<Team> {
    {
        let store = state.store.lock().unwrap();
        team_of(&store, &team_id)?;
        join_team(&store, &state, &team_id, &bot_id, role.as_deref())?;
    }
    team_changed(&app, &team_id)
}

/// "Create new agent" in a team: a new bot that joins it as a member.
#[tauri::command]
pub fn create_team_member(
    app: AppHandle,
    state: State<AppState>,
    team_id: String,
    name: String,
    image: BotImage,
    role: String,
) -> CmdResult<Bot> {
    let bot = team_bot(&name, image, &role, "")?;
    let bot = {
        let mut store = state.store.lock().unwrap();
        team_of(&store, &team_id)?;
        store.insert_bot(bot.clone())?;
        join_team(&store, &state, &team_id, &bot.id, Some(&role))?;
        store.bot(&bot.id)?
    };
    team_changed(&app, &team_id)?;
    Ok(bot)
}

/// "Role in the team".
#[tauri::command]
pub fn set_member_role(app: AppHandle, state: State<AppState>, bot_id: String, role: String) -> CmdResult<()> {
    state.store.lock().unwrap().set_team_role(&bot_id, role.trim())?;
    events::bots_changed(&app);
    Ok(())
}

/// "Remove from team": the bot stays, as a bot of its own.
#[tauri::command]
pub fn remove_team_member(app: AppHandle, state: State<AppState>, team_id: String, bot_id: String) -> CmdResult<Team> {
    {
        let store = state.store.lock().unwrap();
        if store.bot(&bot_id)?.team_id.as_deref() != Some(team_id.as_str()) {
            return Err("This bot isn't in the team.".into());
        }
        leave_team(&store, &state, &bot_id)?;
    }
    team_changed(&app, &team_id)
}

/// "Make orchestrator": the member leads the team; the old orchestrator
/// stays on as a member.
#[tauri::command]
pub fn make_lead(app: AppHandle, state: State<AppState>, team_id: String, bot_id: String) -> CmdResult<Team> {
    if state.teams.is_live(&team_id) {
        return Err(teams::BUSY.into());
    }
    {
        let store = state.store.lock().unwrap();
        let team = team_of(&store, &team_id)?;
        if !team.members.contains(&bot_id) {
            return Err("Only a member of the team can be its orchestrator.".into());
        }
        let members: Vec<String> =
            team.members.iter().filter(|m| **m != bot_id).cloned().chain([team.lead_id.clone()]).collect();
        store.set_team_lead(&team_id, &bot_id)?;
        store.set_team_flow(&team_id, team.mode, &team.flow.normalized(&members))?;
    }
    team_changed(&app, &team_id)
}

/// "Disband team": every bot becomes a bot of its own again, and the team
/// chat moves to the orchestrator's chat.
#[tauri::command]
pub fn disband_team(app: AppHandle, state: State<AppState>, team_id: String) -> CmdResult<()> {
    if state.teams.is_live(&team_id) || state.runs.running().contains(&team_id) {
        return Err(teams::BUSY.into());
    }
    let team = {
        let mut store = state.store.lock().unwrap();
        let team = team_of(&store, &team_id)?;
        store.delete_team(&team_id, &team.lead_id)?;
        team
    };
    agent::post(&app, &team.lead_id, MessageBody::System { text: format!("{} was disbanded. Its chat is above.", team.name) });
    events::cleared(&app, &team_id);
    events::bots_changed(&app);
    events::teams_changed(&app);
    Ok(())
}

/// A message in a team chat: a request for the orchestrator, or with
/// `member_id` (an @mention) a question for one member.
#[tauri::command]
pub fn send_team_message(
    app: AppHandle,
    state: State<AppState>,
    team_id: String,
    text: String,
    member_id: Option<String>,
) -> CmdResult<Message> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Message is empty".into());
    }
    let team = state.store.lock().unwrap().team(&team_id)?;
    let push = |chat: &str, text: String| -> CmdResult<Message> {
        let message = state.store.lock().unwrap().push_message(chat, Message::new(MessageBody::User { text }))?;
        events::message_only(&app, chat, message.clone());
        Ok(message)
    };
    let Some(member_id) = member_id else {
        // Claim the team before saving the message, so a refused send leaves no trace.
        let ticket = state.runs.start(&app, &team_id).ok_or(teams::BUSY)?;
        let message = push(&team_id, text.clone())?;
        events::teams_changed(&app);
        teams::spawn(app.clone(), ticket, text);
        return Ok(message);
    };
    if !team.members.contains(&member_id) {
        return Err("That bot isn't a member of this team.".into());
    }
    let member = state.store.lock().unwrap().bot(&member_id)?;
    let ask = teams::strip_mention(&text, &member.name);
    if state.teams.working(&team_id, &member_id) {
        let message = push(&team_id, text)?;
        push(&member_id, ask.clone())?;
        events::bots_changed(&app);
        state.teams.send(&team_id, Signal::StepIn { member_id, text: ask });
        teams::post(&app, &team_id, MessageBody::System { text: format!("{} will use this in its current task", member.name) });
        return Ok(message);
    }
    let member_ticket = state
        .runs
        .start(&app, &member_id)
        .ok_or_else(|| format!("{} is busy. Wait for it to finish, or stop it.", member.name))?;
    let team_ticket = state.runs.start(&app, &team_id);
    let message = push(&team_id, text)?;
    push(&member_id, ask.clone())?;
    events::bots_changed(&app);
    events::teams_changed(&app);
    teams::spawn_direct(app.clone(), team_id, member_ticket, team_ticket, ask);
    Ok(message)
}

const NOT_RUNNING: &str = "The team isn't working on anything right now.";

/// "Pause team" / "Resume" on the Plan card.
#[tauri::command]
pub fn pause_team(state: State<AppState>, team_id: String, paused: bool) -> CmdResult<()> {
    state.teams.send(&team_id, Signal::Pause(paused)).then_some(()).ok_or(NOT_RUNNING.into())
}

/// "Edit plan" on the Plan card.
#[tauri::command]
pub fn edit_team_plan(state: State<AppState>, team_id: String, edits: Vec<PlanEdit>) -> CmdResult<()> {
    state.teams.send(&team_id, Signal::Edit(edits)).then_some(()).ok_or(NOT_RUNNING.into())
}

/// Retry, Skip or Stop on a task that failed.
#[tauri::command]
pub fn answer_team_task(state: State<AppState>, team_id: String, task_id: String, action: TaskAction) -> CmdResult<()> {
    state.teams.send(&team_id, Signal::Answer { task_id, action }).then_some(()).ok_or(NOT_RUNNING.into())
}
