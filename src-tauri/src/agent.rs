//! Agent runtime. Each run is a `claude -p` process (see `claude.rs`) driven
//! from its own async task; its output is streamed into the chat through
//! `kbot://message` upserts, so the window never blocks on the model.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, TimeZone};
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::claude::{self, ClaudeStatus, Event, Exit, RunSpec, Session, Tools};
use crate::events;
use crate::models::{AgentConfig, Bot, Message, MessageBody, PermissionStatus, Question, Schedule, Weekday};
use crate::runs::Ticket;
use crate::AppState;

pub enum Trigger {
    UserMessage(String),
    ComputerHandback,
    /// The bot's scheduled job; `manual` = "Run now" rather than the scheduler,
    /// `late` = when a missed one-time task was due ("today at 09:30").
    Job { manual: bool, late: Option<String> },
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

/// The `--model` a bot runs with: its own, else the default from Kbot > Settings….
pub fn model(app: &AppHandle, bot: &Bot) -> String {
    let default = || app.state::<AppState>().store.lock().unwrap().app_settings().default_model;
    bot.config.model.clone().unwrap_or_else(default)
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
    if let (Trigger::Job { manual, late }, Some(schedule)) = (&trigger, &bot.config.schedule) {
        let (job, at) = match (schedule.every_minutes, schedule.date.is_some()) {
            (Some(n), _) => (format!("Every {}", describe_every(n)), Local::now().format("%H:%M").to_string()),
            (None, true) => ("Scheduled task".to_string(), schedule.time.clone()),
            (None, false) => ("Daily job".to_string(), schedule.time.clone()),
        };
        let when = match (manual, late) {
            (true, _) => "Run now".to_string(),
            (false, Some(due)) => format!("Due {due}, running late"),
            (false, None) => at,
        };
        post(app, bot_id, MessageBody::System { text: format!("{job} \u{b7} {when}") });
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
        model: Some(model(app, &bot)),
        json_schema: None,
        cwd: workdir(app, bot_id),
    };
    let mut input = ticket.input.lock().await;
    let job = matches!(trigger, Trigger::Job { .. });
    loop {
        let mut reply = Reply::new(app, &bot, job);
        let exit = claude::run(&bin, &spec, ticket.cancel.clone(), Some(&mut *input), |e| reply.on_event(e)).await;
        reply.close();
        reply.expire_unanswered();
        let exit = exit?;
        // The saved session is gone (e.g. Claude Code's history was cleared): start over once.
        if reply.session_missing && matches!(spec.session, Session::Resume(_)) {
            state.store.lock().unwrap().set_session_id(bot_id, None)?;
            spec.session = new_session();
            continue;
        }
        let stopped = matches!(exit, Exit::Stopped);
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
        if reply.notify && !reply.text.is_empty() {
            notify(app, &bot.name, reply.text.chars().take(180).collect());
        }
        // A result or an error; the user knows about a run they stopped.
        if job && !stopped {
            mark_unread(app, bot_id);
        }
        return Ok(());
    }
}

fn notify(app: &AppHandle, title: &str, body: String) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("notification failed: {e}");
    }
}

/// Marks `bot_id` unread (sidebar dot, Dock badge) unless its chat is on screen.
fn mark_unread(app: &AppHandle, bot_id: &str) {
    let state = app.state::<AppState>();
    if state.viewing.lock().unwrap().as_deref() == Some(bot_id) {
        return;
    }
    let changed = state.store.lock().unwrap().set_unread(bot_id, true);
    match changed {
        Ok(true) => events::bots_changed(app),
        Ok(false) => {}
        Err(e) => eprintln!("marking {bot_id} unread failed: {e}"),
    }
}

/// Turns stream events into chat messages for one run.
struct Reply<'a> {
    app: &'a AppHandle,
    bot_id: &'a str,
    bot_name: &'a str,
    /// A scheduled job, which marks the bot unread when it needs the user.
    job: bool,
    /// A scheduled job that should notify the user (result, or waiting for an answer).
    notify: bool,
    /// Permission cards posted during this run.
    asked: Vec<String>,
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
    fn new(app: &'a AppHandle, bot: &'a Bot, job: bool) -> Self {
        Self {
            app,
            bot_id: &bot.id,
            bot_name: &bot.name,
            job,
            notify: job &&bot.config.schedule.as_ref().is_some_and(|s| s.notify),
            asked: Vec::new(),
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
            // Its question card follows as a permission request.
            Event::ToolUse { name, .. } if name == "AskUserQuestion" => self.close(),
            Event::ToolUse { name, input } => {
                self.close();
                self.system(activity(&name, &input));
            }
            Event::PermissionRequest { request_id, tool, input } => {
                self.close();
                if self.job {
                    mark_unread(self.app, self.bot_id);
                }
                if self.notify {
                    let body = match tool.as_str() {
                        "AskUserQuestion" => "has a question for you.".to_string(),
                        _ => format!("wants to use {tool}."),
                    };
                    notify(self.app, self.bot_name, format!("{} {body}", self.bot_name));
                }
                if let Some(message) = post(self.app, self.bot_id, permission_card(request_id, tool, input)) {
                    self.asked.push(message.id);
                }
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

    /// Marks permission cards of this run that were never answered as expired.
    fn expire_unanswered(&mut self) {
        for id in self.asked.drain(..) {
            let result = self.app.state::<AppState>().store.lock().unwrap().update_message(self.bot_id, &id, |m| {
                if let MessageBody::Permission { status, .. } = &mut m.body
                    && *status == PermissionStatus::Pending
                {
                    *status = PermissionStatus::Expired;
                }
            });
            match result {
                Ok(message) => events::message_only(self.app, self.bot_id, message),
                Err(e) => eprintln!("expiring permission failed: {e}"),
            }
        }
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

/// The chat card for a tool Claude Code asks about (see `MessageBody::Permission`).
fn permission_card(request_id: String, tool: String, input: Value) -> MessageBody {
    let arg = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let detail = match tool.as_str() {
        "Bash" => arg("command"),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => arg("file_path"),
        "WebFetch" => arg("url"),
        "WebSearch" => arg("query"),
        "AskUserQuestion" => String::new(),
        _ => serde_json::to_string_pretty(&input).unwrap_or_default(),
    };
    let summary = match arg("description") {
        d if !d.is_empty() => d,
        _ => match tool.as_str() {
            "Bash" => "Run a shell command".into(),
            "Read" => "Read a file".into(),
            "Write" => "Create or replace a file".into(),
            "Edit" | "MultiEdit" | "NotebookEdit" => "Change a file".into(),
            "WebFetch" => "Open a web page".into(),
            "WebSearch" => "Search the web".into(),
            _ => String::new(),
        },
    };
    let questions = input
        .get("questions")
        .and_then(|q| serde_json::from_value::<Vec<Question>>(q.clone()).ok())
        .unwrap_or_default();
    MessageBody::Permission {
        request_id,
        tool,
        summary,
        detail,
        input,
        questions,
        status: PermissionStatus::Pending,
        answers: Default::default(),
    }
}

/// One-line description of a tool call, shown in the chat.
fn activity(tool: &str, input: &Value) -> String {
    let arg = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or_default();
    let file = || {
        let path = arg("file_path");
        path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
    };
    match tool {
        "Read" => format!("Reading {}\u{2026}", file()),
        "Write" => format!("Writing {}\u{2026}", file()),
        "Edit" => format!("Editing {}\u{2026}", file()),
        "Bash" => match arg("description") {
            "" => format!("Running {}\u{2026}", arg("command").lines().next().unwrap_or_default()),
            description => format!("{description}\u{2026}"),
        },
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

/// Tools the bot may use: all of Claude Code's, run without asking (see
/// `claude::PERMISSION_MODE`). Only web access can be turned off.
pub fn tools(config: &AgentConfig) -> Tools {
    match config.web_access {
        true => Tools::AllExcept(Vec::new()),
        false => Tools::AllExcept(vec!["WebSearch", "WebFetch"]),
    }
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
        let task = schedule.task.trim();
        let days = describe_days(&schedule.days);
        s += &match schedule.every_minutes {
            None if schedule.date.is_some() => format!(
                "\n# Scheduled task\n\n{when} at {time} local time you run this task by yourself and post the result in this chat:\n\n{task}\n\nThe user may ask follow-up questions about a result.\n",
                when = capitalize(&describe_date(schedule).unwrap_or_default()),
                time = schedule.time,
            ),
            None => format!(
                "\n# Daily job\n\nEvery day ({days}) at {time} local time you run this task by yourself and post the result in this chat:\n\n{task}\n\nThe user may ask follow-up questions about a result.\n",
                time = schedule.time,
            ),
            Some(n) => format!(
                "\n# Scheduled job\n\nEvery {every} ({days}) you run this task by yourself and post the result in this chat:\n\n{task}\n\n\
                 Runs come often: if nothing changed or needs the user's attention since the last run, say so in one short line. \
                 The user may ask follow-up questions about a result.\n",
                every = describe_every(n),
            ),
        };
    }
    s += "\n# Access\n\n";
    s += "You can use all of your tools without asking: run shell commands, and read, create and change files anywhere on this computer. \
          Your working directory is your own; save things you make there unless the user says where. \
          Don't delete or overwrite the user's files unless they ask you to.\n";
    if !config.workspace_folders.is_empty() {
        s += "The user gave you these folders to work with:\n";
        for folder in &config.workspace_folders {
            s += &format!("- {folder}\n");
        }
    }
    if config.web_access {
        s += "You can search the web (WebSearch) and read pages (WebFetch). Cite the pages you used.\n";
    } else {
        s += "You cannot access the web. Don't try to reach it another way, such as with shell commands.\n";
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
        Trigger::Job { late, .. } => {
            let task = config.schedule.as_ref().map(|s| s.task.trim()).unwrap_or_default();
            let task = if task.is_empty() { config.description.trim() } else { task };
            let job = match config.schedule.as_ref().map(|s| (s.every_minutes, s.date.is_some())) {
                Some((None, true)) => "scheduled task",
                Some((Some(_), _)) => "scheduled job",
                _ => "daily job",
            };
            match late {
                Some(due) => format!("Your {job} was due {due} and is running late. Do it now and post the result.\n\n{task}"),
                None => format!("It's time for your {job}. Do it now and post the result.\n\n{task}"),
            }
        }
    };
    format!("{time}\n\n{body}")
}

/// "15 min", "1 hour", "2 hours" or "90 min".
pub fn describe_every(minutes: u32) -> String {
    match minutes / 60 {
        1 if minutes == 60 => "1 hour".into(),
        h if minutes % 60 == 0 => format!("{h} hours"),
        _ => format!("{minutes} min"),
    }
}

/// "once on Fri, Oct 30, 2026" or "monthly on the 30th"; `None` unless it's a task on a date.
pub fn describe_date(schedule: &Schedule) -> Option<String> {
    let date = schedule.parsed_date()?;
    Some(match schedule.monthly {
        true => format!("monthly on the {}", ordinal(chrono::Datelike::day(&date))),
        false => format!("once on {}", date.format("%a, %b %-d, %Y")),
    })
}

/// "1st", "2nd", "11th", "23rd".
pub fn ordinal(n: u32) -> String {
    let suffix = match (n % 10, n % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
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
            editing: false,
            unread: false,
        }
    }

    #[test]
    fn permission_cards_show_the_command_or_questions() {
        let card = permission_card("r1".into(), "Bash".into(), serde_json::json!({"command": "rm -rf build"}));
        let MessageBody::Permission { summary, detail, questions, status, .. } = card else { panic!() };
        assert_eq!((summary.as_str(), detail.as_str()), ("Run a shell command", "rm -rf build"));
        assert!(questions.is_empty());
        assert_eq!(status, PermissionStatus::Pending);

        let input = serde_json::json!({"questions": [{"question": "Coffee or tea?", "header": "Drink",
            "options": [{"label": "Coffee", "description": "Hot"}, {"label": "Tea", "description": ""}], "multiSelect": false}]});
        let MessageBody::Permission { detail, questions, .. } = permission_card("r2".into(), "AskUserQuestion".into(), input)
        else {
            panic!()
        };
        assert_eq!(detail, "");
        assert_eq!(questions.len(), 1);
        assert_eq!(questions[0].question, "Coffee or tea?");
        assert_eq!(questions[0].options[1].label, "Tea");
    }

    #[test]
    fn tools_follow_config() {
        let mut config = AgentConfig::default();
        assert_eq!(tools(&config), Tools::AllExcept(vec!["WebSearch", "WebFetch"]));
        config.web_access = true;
        assert_eq!(tools(&config), Tools::AllExcept(Vec::new()));
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
        let interval = system_prompt(&bot(AgentConfig {
            schedule: Some(Schedule { every_minutes: Some(15), task: "Check the build".into(), ..Schedule::default() }),
            ..AgentConfig::default()
        }));
        assert!(interval.contains("Every 15 min (every day) you run this task"));
        assert!(interval.contains("Check the build"));
        let dated = |monthly| {
            system_prompt(&bot(AgentConfig {
                schedule: Some(Schedule { monthly, task: "Pay rent".into(), ..Schedule::on_date(chrono::NaiveDate::from_ymd_opt(2026, 11, 1).unwrap()) }),
                ..AgentConfig::default()
            }))
        };
        assert!(dated(false).contains("Once on Sun, Nov 1, 2026 at 08:00 local time you run this task"));
        assert!(dated(true).contains("Monthly on the 1st at 08:00 local time you run this task"));
    }

    #[test]
    fn prompt_carries_time_and_task() {
        let now = FixedOffset::east_opt(7 * 3600).unwrap().with_ymd_and_hms(2026, 10, 26, 8, 0, 0).unwrap();
        let config = AgentConfig {
            schedule: Some(Schedule { task: "Brief me".into(), ..Schedule::default() }),
            ..AgentConfig::default()
        };
        let p = prompt(&Trigger::Job { manual: false, late: None }, &config, now);
        assert!(p.starts_with("[Monday, October 26, 2026, 08:00 (UTC+07:00)]"));
        assert!(p.contains("It's time for your daily job"));
        assert!(p.ends_with("Brief me"));
        let late = Trigger::Job { manual: false, late: Some("yesterday at 09:30".into()) };
        assert!(prompt(&late, &config, now).contains("Your daily job was due yesterday at 09:30 and is running late."));
        assert!(prompt(&Trigger::UserMessage("hi".into()), &config, now).ends_with("\n\nhi"));
    }

    #[test]
    fn days_and_activity_labels() {
        assert_eq!(describe_days(&Weekday::ALL), "every day");
        assert_eq!(describe_days(&[Weekday::Mon, Weekday::Fri]), "Mon, Fri");
        let every: Vec<_> = [15, 60, 90, 120].map(describe_every).into();
        assert_eq!(every, ["15 min", "1 hour", "90 min", "2 hours"]);
        let nth: Vec<_> = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal).into();
        assert_eq!(nth, ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
        let read = serde_json::json!({"file_path": "/Users/me/notes/todo.md"});
        assert_eq!(activity("Read", &read), "Reading todo.md\u{2026}");
        let fetch = serde_json::json!({"url": "https://news.ycombinator.com/item?id=1"});
        assert_eq!(activity("WebFetch", &fetch), "Opening news.ycombinator.com\u{2026}");
        let ls = serde_json::json!({"command": "ls -l ~/notes\necho done"});
        assert_eq!(activity("Bash", &ls), "Running ls -l ~/notes\u{2026}");
        let ls = serde_json::json!({"command": "ls -l", "description": "List files with sizes"});
        assert_eq!(activity("Bash", &ls), "List files with sizes\u{2026}");
    }
}
