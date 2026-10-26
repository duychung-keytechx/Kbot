//! Agent runtime. Each run is a `claude -p` process (see `claude.rs`) driven
//! from its own async task; its output is streamed into the chat through
//! `kbot://message` upserts, so the window never blocks on the model.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, TimeZone};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::claude::{self, ClaudeStatus, Event, Exit, RunSpec, Session};
use crate::events;
use crate::models::{AgentConfig, Bot, Message, MessageBody, Weekday};
use crate::runs::Ticket;
use crate::AppState;

pub enum Trigger {
    UserMessage(String),
    ComputerHandback,
    /// The bot's daily job; `manual` = "Run now" rather than the scheduler.
    DailyJob { manual: bool },
}

/// Appends a message to a bot's chat and tells the UI.
pub fn post(app: &AppHandle, bot_id: &str, body: MessageBody) -> Option<Message> {
    let result = app.state::<AppState>().store.lock().unwrap().push_message(bot_id, Message::new(body));
    match result {
        Ok(message) => {
            events::message(app, bot_id, message.clone());
            Some(message)
        }
        Err(err) => {
            eprintln!("posting to {bot_id} failed: {err}");
            None
        }
    }
}

/// Empty working directory of a bot's Claude process.
pub fn workdir(app: &AppHandle, bot_id: &str) -> PathBuf {
    app.state::<AppState>().data_dir.join("agents").join(bot_id)
}

/// The `claude` binary, once Claude Code is installed and signed in with a subscription.
pub async fn ready_binary(app: &AppHandle) -> Result<PathBuf, String> {
    match claude::status(app, false).await {
        ClaudeStatus::Ready { .. } => app
            .state::<AppState>()
            .claude
            .binary()
            .ok_or_else(|| "Claude Code could not be found.".into()),
        ClaudeStatus::NotInstalled => Err("Claude Code isn't installed. Follow the Connect Claude steps.".into()),
        ClaudeStatus::LoggedOut => Err("Claude Code isn't signed in. Follow the Connect Claude steps.".into()),
        ClaudeStatus::NotSubscription { auth_method } => Err(format!(
            "Claude Code is signed in with {auth_method}, not a Claude subscription. Follow the Connect Claude steps."
        )),
    }
}

/// Starts a run for `ticket.bot_id` in the background.
pub fn spawn(app: AppHandle, ticket: Ticket, trigger: Trigger) {
    tauri::async_runtime::spawn(async move {
        if let Err(err) = run(&app, &ticket, trigger).await {
            post(&app, &ticket.bot_id, MessageBody::System { text: err });
        }
        drop(ticket);
    });
}

async fn run(app: &AppHandle, ticket: &Ticket, trigger: Trigger) -> Result<(), String> {
    let bot_id = ticket.bot_id.as_str();
    let state = app.state::<AppState>();
    let bot = state.store.lock().unwrap().bot(bot_id)?;
    if let Trigger::DailyJob { manual } = trigger {
        let when = match (&bot.config.schedule, manual) {
            (Some(schedule), false) => schedule.time.clone(),
            _ => "Run now".into(),
        };
        post(app, bot_id, MessageBody::System { text: format!("Daily job \u{b7} {when}") });
    }
    let bin = ready_binary(app).await?;

    let new_session = || Session::New(uuid::Uuid::new_v4().to_string());
    let session = match state.store.lock().unwrap().session_id(bot_id)? {
        Some(id) => Session::Resume(id),
        None => new_session(),
    };
    let mut spec = RunSpec {
        prompt: prompt(&trigger, &bot.config, Local::now()),
        system_prompt: system_prompt(&bot),
        session,
        tools: tools(&bot.config),
        add_dirs: bot.config.workspace_folders.clone(),
        model: bot.config.model.clone(),
        json_schema: None,
        cwd: workdir(app, bot_id),
    };
    loop {
        let mut reply = Reply::new(app, bot_id);
        let exit = claude::run(&bin, &spec, ticket.cancel.clone(), |e| reply.on_event(e)).await;
        reply.close();
        let exit = exit?;
        // The saved session is gone (e.g. Claude Code's history was cleared): start over once.
        if reply.session_missing && matches!(spec.session, Session::Resume(_)) {
            state.store.lock().unwrap().set_session_id(bot_id, None)?;
            spec.session = new_session();
            continue;
        }
        match exit {
            Exit::Stopped if !reply.failed => {
                post(app, bot_id, MessageBody::System { text: "Stopped".into() });
            }
            Exit::Finished { success: false, stderr } if !reply.got_result => {
                reply.failed = true;
                let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("no output");
                post(app, bot_id, MessageBody::System { text: format!("Claude Code stopped unexpectedly: {detail}") });
            }
            _ => {}
        }
        if reply.failed {
            // Maybe signed out or switched to an API key: re-check so the UI can react.
            state.claude.invalidate();
            claude::status(app, true).await;
        }
        let notify = bot.config.schedule.as_ref().is_some_and(|s| s.notify);
        if matches!(trigger, Trigger::DailyJob { .. }) && notify && !reply.text.is_empty() {
            let body: String = reply.text.chars().take(180).collect();
            if let Err(e) = app.notification().builder().title(&bot.name).body(body).show() {
                eprintln!("notification failed: {e}");
            }
        }
        return Ok(());
    }
}

/// Turns stream events into chat messages for one run.
struct Reply<'a> {
    app: &'a AppHandle,
    bot_id: &'a str,
    /// The agent bubble text is streaming into.
    current: Option<Message>,
    /// `current` has deltas that aren't saved to the database yet.
    dirty: bool,
    last_emit: Instant,
    /// Last complete agent text, for notifications.
    text: String,
    got_result: bool,
    session_missing: bool,
    rate_limited: bool,
    failed: bool,
}

impl<'a> Reply<'a> {
    fn new(app: &'a AppHandle, bot_id: &'a str) -> Self {
        Self {
            app,
            bot_id,
            current: None,
            dirty: false,
            last_emit: Instant::now(),
            text: String::new(),
            got_result: false,
            session_missing: false,
            rate_limited: false,
            failed: false,
        }
    }

    fn system(&self, text: String) {
        post(self.app, self.bot_id, MessageBody::System { text });
    }

    /// Returns `false` to stop the run.
    fn on_event(&mut self, event: Event) -> bool {
        match event {
            Event::Init { session_id, api_key_source } => {
                if api_key_source != "none" {
                    self.failed = true;
                    self.system(claude::not_subscription_error(&api_key_source));
                    return false;
                }
                let store = self.app.state::<AppState>();
                if let Err(e) = store.store.lock().unwrap().set_session_id(self.bot_id, Some(&session_id)) {
                    eprintln!("saving session failed: {e}");
                }
            }
            Event::TextStart => self.close(),
            Event::TextDelta(delta) => match &mut self.current {
                Some(message) => {
                    if let MessageBody::Agent { text } = &mut message.body {
                        text.push_str(&delta);
                    }
                    self.dirty = true;
                    if self.last_emit.elapsed() > Duration::from_millis(50) {
                        events::message_only(self.app, self.bot_id, message.clone());
                        self.last_emit = Instant::now();
                    }
                }
                None => self.current = post(self.app, self.bot_id, MessageBody::Agent { text: delta }),
            },
            Event::Text(text) => {
                self.set_current_text(text.clone());
                self.text = text;
                self.current = None;
            }
            Event::ToolUse { name, input } => {
                self.close();
                self.system(activity(&name, &input));
            }
            Event::RateLimited { resets_at } => {
                self.rate_limited = true;
                let when = resets_at
                    .and_then(|s| Local.timestamp_opt(s, 0).single())
                    .map(|t| format!(" It resets at {}.", t.format("%H:%M")))
                    .unwrap_or_default();
                self.system(format!("Claude usage limit reached.{when}"));
            }
            Event::Result { is_error, text, errors, .. } => {
                self.got_result = true;
                if is_error {
                    self.failed = true;
                    if errors.iter().any(|e| e.starts_with("No conversation found")) {
                        self.session_missing = true;
                    } else if !self.rate_limited {
                        let detail = text.filter(|t| !t.is_empty()).unwrap_or_else(|| errors.join("; "));
                        self.system(format!("Claude couldn't finish: {detail}"));
                    }
                }
            }
        }
        true
    }

    /// Saves `text` into the streaming bubble, or posts it if there is none.
    fn set_current_text(&mut self, text: String) {
        match self.current.take() {
            Some(message) => {
                let result = self.app.state::<AppState>().store.lock().unwrap().update_message(
                    self.bot_id,
                    &message.id,
                    |m| m.body = MessageBody::Agent { text },
                );
                match result {
                    Ok(message) => events::message(self.app, self.bot_id, message),
                    Err(e) => eprintln!("saving reply failed: {e}"),
                }
            }
            None => {
                post(self.app, self.bot_id, MessageBody::Agent { text });
            }
        }
        self.dirty = false;
    }

    /// Ends the current bubble, saving any streamed text that wasn't saved yet.
    fn close(&mut self) {
        if self.dirty
            && let Some(MessageBody::Agent { text }) = self.current.as_ref().map(|m| m.body.clone())
        {
            self.set_current_text(text);
        }
        self.current = None;
        self.dirty = false;
    }
}

/// One-line description of a tool call, shown in the chat.
fn activity(tool: &str, input: &Value) -> String {
    let arg = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_default();
    match tool {
        "Read" => {
            let path = arg("file_path");
            let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
            format!("Reading {name}\u{2026}")
        }
        "Glob" => format!("Looking for files matching {}\u{2026}", arg("pattern")),
        "Grep" => format!("Searching files for \u{201c}{}\u{201d}\u{2026}", arg("pattern")),
        "WebSearch" => format!("Searching the web for \u{201c}{}\u{201d}\u{2026}", arg("query")),
        "WebFetch" => {
            let url = arg("url");
            let host = url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or(url);
            format!("Opening {host}\u{2026}")
        }
        other => format!("Using {other}\u{2026}"),
    }
}

/// Tools the bot may use. Read-only by design: no Bash, Edit or Write.
pub fn tools(config: &AgentConfig) -> Vec<&'static str> {
    let mut tools = Vec::new();
    if !config.workspace_folders.is_empty() {
        tools.extend(["Read", "Glob", "Grep"]);
    }
    if config.web_access {
        tools.extend(["WebSearch", "WebFetch"]);
    }
    tools
}

/// The bot's system prompt. Claude Code keeps a session's first system
/// prompt on `--resume`, so changing the config must start a new session
/// (see `commands::update_bot_config`), and anything that changes per turn,
/// like the time, goes into the prompt instead.
pub fn system_prompt(bot: &Bot) -> String {
    let config = &bot.config;
    let mut s = format!(
        "You are {name}, a personal agent the user built in Kbot, a desktop app. You talk with the user in a chat window.\n\n",
        name = bot.name
    );
    s += "# Instructions\n\n";
    match (config.instructions.trim(), config.description.trim()) {
        ("", "") => s += "No specific instructions yet. Be a helpful assistant.\n",
        ("", description) => s += &format!("{description}\n"),
        (instructions, _) => s += &format!("{instructions}\n"),
    }
    if let Some(schedule) = &config.schedule {
        s += &format!(
            "\n# Daily job\n\nEvery day ({days}) at {time} local time you run this task by yourself and post the result in this chat:\n\n{task}\n\nThe user may ask follow-up questions about a result.\n",
            days = describe_days(&schedule.days),
            time = schedule.time,
            task = schedule.task.trim(),
        );
    }
    s += "\n# Access\n\n";
    if config.workspace_folders.is_empty() {
        s += "You have no access to the user's files.\n";
    } else {
        s += "You can read (never change) these folders with the Read, Glob and Grep tools:\n";
        for folder in &config.workspace_folders {
            s += &format!("- {folder}\n");
        }
    }
    if config.web_access {
        s += "You can search the web (WebSearch) and read pages (WebFetch). Cite the pages you used.\n";
    } else {
        s += "You cannot access the web.\n";
    }
    s += "\n# Style\n\n\
          - Reply in the language the user writes in.\n\
          - Replies appear in a plain-text chat bubble: write short paragraphs and simple lists, no Markdown headings or tables.\n\
          - Each message starts with the current local time in brackets. Use it for anything date-related; don't repeat it.\n";
    s
}

/// The text sent to Claude for one turn.
pub fn prompt<Tz: TimeZone>(trigger: &Trigger, config: &AgentConfig, now: DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let time = format!("[{}]", now.format("%A, %B %-d, %Y, %H:%M (UTC%:z)"));
    let body = match trigger {
        Trigger::UserMessage(text) => text.clone(),
        Trigger::ComputerHandback => "I'm done. You have control again.".into(),
        Trigger::DailyJob { .. } => {
            let task = config.schedule.as_ref().map(|s| s.task.trim()).unwrap_or_default();
            let task = if task.is_empty() { config.description.trim() } else { task };
            format!("It's time for your daily job. Do it now and post the result.\n\n{task}")
        }
    };
    format!("{time}\n\n{body}")
}

/// "every day", "weekdays" or "Mon, Wed, Fri".
pub fn describe_days(days: &[Weekday]) -> String {
    let has = |d: &Weekday| days.contains(d);
    if Weekday::ALL.iter().all(has) {
        return "every day".into();
    }
    if Weekday::ALL[..5].iter().all(has) && !Weekday::ALL[5..].iter().any(has) {
        return "weekdays".into();
    }
    Weekday::ALL
        .iter()
        .filter(|d| has(d))
        .map(|d| {
            let s = serde_json::to_value(d).unwrap();
            let s = s.as_str().unwrap_or_default();
            s[..1].to_uppercase() + &s[1..]
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Avatar, BotIcon, Schedule, SetupState};
    use chrono::FixedOffset;

    fn bot(config: AgentConfig) -> Bot {
        Bot {
            id: "b".into(),
            name: "Morning Bot".into(),
            avatar: Avatar::Icon { icon: BotIcon::Happy, color: "#000".into() },
            pinned: false,
            updated_at: 0,
            preview: String::new(),
            setup_state: SetupState::Done,
            config,
            last_run_at: None,
        }
    }

    #[test]
    fn tools_follow_config() {
        let mut config = AgentConfig::default();
        assert!(tools(&config).is_empty());
        config.workspace_folders.push("/notes".into());
        assert_eq!(tools(&config), ["Read", "Glob", "Grep"]);
        config.web_access = true;
        config.workspace_folders.clear();
        assert_eq!(tools(&config), ["WebSearch", "WebFetch"]);
    }

    #[test]
    fn system_prompt_includes_config() {
        let prompt = system_prompt(&bot(AgentConfig {
            instructions: "Summarize AI news.".into(),
            schedule: Some(Schedule {
                task: "Brief me".into(),
                days: Weekday::ALL[..5].to_vec(),
                ..Schedule::default()
            }),
            workspace_folders: vec!["/Users/me/notes".into()],
            ..AgentConfig::default()
        }));
        assert!(prompt.starts_with("You are Morning Bot"));
        assert!(prompt.contains("Summarize AI news."));
        assert!(prompt.contains("Every day (weekdays) at 08:00"));
        assert!(prompt.contains("- /Users/me/notes"));
        assert!(prompt.contains("You cannot access the web."));
        assert!(system_prompt(&bot(AgentConfig::default())).contains("No specific instructions yet"));
    }

    #[test]
    fn prompt_carries_time_and_task() {
        let now = FixedOffset::east_opt(7 * 3600).unwrap().with_ymd_and_hms(2026, 10, 26, 8, 0, 0).unwrap();
        let config = AgentConfig {
            schedule: Some(Schedule { task: "Brief me".into(), ..Schedule::default() }),
            ..AgentConfig::default()
        };
        let p = prompt(&Trigger::DailyJob { manual: false }, &config, now);
        assert!(p.starts_with("[Monday, October 26, 2026, 08:00 (UTC+07:00)]"));
        assert!(p.ends_with("Brief me"));
        assert!(prompt(&Trigger::UserMessage("hi".into()), &config, now).ends_with("\n\nhi"));
    }

    #[test]
    fn days_and_activity_labels() {
        assert_eq!(describe_days(&Weekday::ALL), "every day");
        assert_eq!(describe_days(&[Weekday::Mon, Weekday::Fri]), "Mon, Fri");
        let read = serde_json::json!({"file_path": "/Users/me/notes/todo.md"});
        assert_eq!(activity("Read", &read), "Reading todo.md\u{2026}");
        let fetch = serde_json::json!({"url": "https://news.ycombinator.com/item?id=1"});
        assert_eq!(activity("WebFetch", &fetch), "Opening news.ycombinator.com\u{2026}");
    }
}
