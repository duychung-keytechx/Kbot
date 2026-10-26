//! Onboarding: a new bot asks the user what it should do, in the chat.
//!
//! Fixed steps (kind, schedule, web, folders) are answered with cards, so
//! nothing is parsed from free text. Claude is only used to ask a few
//! clarifying questions about the description and to turn it into
//! instructions. The current step is saved in `bots.setup_step`, so a setup
//! interrupted by quitting the app resumes where it left off.
//!
//! Typing `/setup` starts over a bot that isn't set up yet. A set-up bot
//! instead shows its current setup and takes changes in plain words: Claude
//! applies them to the config and the user saves the result. The bot stays
//! `done` meanwhile, with `Step::Edit` in `setup_step`.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::agent::{self, post};
use crate::claude;
use crate::events;
use crate::models::{AgentConfig, Bot, Message, MessageBody, Schedule, SetupAnswer, SetupState, Weekday};
use crate::runs::Ticket;
use crate::AppState;

pub const CHAT: &str = "Chat with me";
pub const DAILY: &str = "Run a daily job";
pub const INTERVAL: &str = "Run on an interval";
pub const ON_DATE: &str = "Schedule a task";
pub const YES: &str = "Yes";
pub const NO: &str = "No";
/// Typed in the chat to set a bot up, or to change its setup.
pub const COMMAND: &str = "/setup";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "step", rename_all = "camelCase")]
pub enum Step {
    Kind,
    Description,
    Schedule,
    Web,
    Workspace,
    /// Waiting for Claude; no answers accepted.
    Generating { what: Generate },
    /// Asking Claude's clarifying questions one by one.
    Clarify { questions: Vec<String>, answers: Vec<String> },
    Review,
    /// `/setup` on a set-up bot: waiting for a change request, or for the
    /// user to save `draft`, the config with the changes so far, and `name`,
    /// the bot's new name if the changes rename it.
    Edit {
        draft: AgentConfig,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Generate {
    Questions,
    Review { clarifications: Vec<(String, String)> },
    /// Apply the user's `request` to `draft` and `name` (as in `Step::Edit`).
    Edit {
        request: String,
        draft: AgentConfig,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
}

impl Step {
    /// The bot's setup state while at this step: changing a set-up bot keeps it `done`.
    fn state(&self) -> SetupState {
        match self {
            Step::Edit { .. } | Step::Generating { what: Generate::Edit { .. } } => SetupState::Done,
            _ => SetupState::Pending,
        }
    }
}

/// What the user gave for the current step.
pub enum Input {
    Text(String),
    Card(SetupAnswer),
}

#[derive(Debug, PartialEq)]
pub enum Next {
    Ask(Step),
    Generate(Generate),
    Done,
}

/// Applies an answer to `config` and says where onboarding goes next.
/// Pure, so the whole flow can be unit tested.
pub fn apply(step: &Step, input: Input, config: &mut AgentConfig) -> Result<Next, String> {
    use SetupAnswer as A;
    let next = match (step, input) {
        (Step::Kind, Input::Card(A::Choice { option })) => {
            let previous = config.schedule.take();
            config.schedule = match option.as_str() {
                CHAT => None,
                DAILY => Some(previous.filter(|s| s.every_minutes.is_none() && s.date.is_none()).unwrap_or_default()),
                INTERVAL => Some(previous.filter(|s| s.every_minutes.is_some()).unwrap_or_else(Schedule::interval)),
                ON_DATE => Some(previous.filter(|s| s.date.is_some()).unwrap_or_else(|| {
                    let today = chrono::Local::now().date_naive();
                    Schedule::on_date(today.succ_opt().unwrap_or(today))
                })),
                _ => return Err(format!("unknown option {option}")),
            };
            Next::Ask(Step::Description)
        }
        (Step::Description, Input::Text(text)) => {
            config.description = text;
            Next::Ask(if config.schedule.is_some() { Step::Schedule } else { Step::Web })
        }
        (Step::Schedule, Input::Card(A::Schedule { time, days, every_minutes, date, monthly, notify })) => {
            let previous = config.schedule.clone().unwrap_or_default();
            // An interval job keeps a valid time, used if it becomes a daily job.
            let time = if every_minutes.is_some() && !valid_time(&time) { previous.time } else { time };
            let days = Weekday::ALL.into_iter().filter(|d| days.contains(d)).collect();
            let monthly = monthly && date.is_some();
            let schedule = Schedule { time, days, every_minutes, date, monthly, task: previous.task, notify };
            schedule.validate()?;
            crate::scheduler::check_date(&schedule, None, chrono::Local::now())?;
            config.schedule = Some(schedule);
            Next::Ask(Step::Web)
        }
        (Step::Web, Input::Card(A::Choice { option })) => {
            config.web_access = match option.as_str() {
                YES => true,
                NO => false,
                _ => return Err(format!("unknown option {option}")),
            };
            Next::Ask(Step::Workspace)
        }
        (Step::Workspace, Input::Card(A::Folders { folders })) => {
            config.workspace_folders = dedupe(folders);
            Next::Generate(Generate::Questions)
        }
        (Step::Clarify { questions, answers }, Input::Text(text)) => {
            let mut answers = answers.clone();
            answers.push(text);
            if answers.len() < questions.len() {
                Next::Ask(Step::Clarify { questions: questions.clone(), answers })
            } else {
                Next::Generate(Generate::Review { clarifications: questions.iter().cloned().zip(answers).collect() })
            }
        }
        (Step::Review, Input::Card(A::Review { instructions, task })) => {
            config.instructions = instructions.trim().to_string();
            if let (Some(schedule), Some(task)) = (&mut config.schedule, task) {
                schedule.task = task.trim().to_string();
            }
            Next::Done
        }
        (Step::Edit { draft, name }, Input::Text(request)) => {
            Next::Generate(Generate::Edit { request, draft: draft.clone(), name: name.clone() })
        }
        (Step::Edit { draft, .. }, Input::Card(A::Review { instructions, task })) => {
            *config = draft.clone();
            return apply(&Step::Review, Input::Card(A::Review { instructions, task }), config);
        }
        (Step::Generating { .. }, Input::Text(_)) => return Err("One moment, I'm still thinking.".into()),
        (_, Input::Text(_)) => return Err("Please answer with the card above, or skip setup.".into()),
        (_, Input::Card(_)) => return Err("This question was already answered.".into()),
    };
    Ok(next)
}

/// "HH:MM", 24-hour.
pub fn valid_time(time: &str) -> bool {
    chrono::NaiveTime::parse_from_str(time, "%H:%M").is_ok() && time.len() == 5
}

pub fn dedupe(folders: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in folders.into_iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()) {
        if !out.contains(&f) {
            out.push(f);
        }
    }
    out
}

/// Whether a card message belongs to `step`, i.e. can still be answered.
fn card_matches(step: &Step, body: &MessageBody) -> bool {
    match (step, body) {
        (Step::Kind, MessageBody::SetupChoice { step, .. }) => step == "kind",
        (Step::Web, MessageBody::SetupChoice { step, .. }) => step == "web",
        (Step::Schedule, MessageBody::SetupSchedule { .. }) => true,
        (Step::Workspace, MessageBody::SetupFolders { .. }) => true,
        (Step::Review, MessageBody::SetupReview { previous: None, .. }) => true,
        (Step::Edit { .. }, MessageBody::SetupReview { previous: Some(_), .. }) => true,
        _ => false,
    }
}

/// Locks an answered card and records the answer on it.
fn mark_answered(body: &mut MessageBody, answer: &SetupAnswer) {
    match (body, answer) {
        (MessageBody::SetupChoice { selected, .. }, SetupAnswer::Choice { option }) => *selected = Some(option.clone()),
        (
            MessageBody::SetupSchedule { time, days, every_minutes, date, monthly, notify, submitted },
            SetupAnswer::Schedule { time: t, days: d, every_minutes: e, date: dt, monthly: m, notify: n },
        ) => {
            (*time, *days, *every_minutes, *notify, *submitted) = (t.clone(), d.clone(), *e, *n, true);
            (*date, *monthly) = (dt.clone(), *m && dt.is_some());
        }
        (MessageBody::SetupFolders { folders, submitted }, SetupAnswer::Folders { folders: f }) => {
            (*folders, *submitted) = (dedupe(f.clone()), true);
        }
        (MessageBody::SetupReview { config, confirmed, .. }, SetupAnswer::Review { instructions, task }) => {
            config.instructions = instructions.trim().to_string();
            if let (Some(schedule), Some(task)) = (&mut config.schedule, task) {
                schedule.task = task.trim().to_string();
            }
            *confirmed = true;
        }
        _ => {}
    }
}

fn store_op<T>(app: &AppHandle, f: impl FnOnce(&mut crate::store::Store) -> Result<T, String>) -> Result<T, String> {
    f(&mut app.state::<AppState>().store.lock().unwrap())
}

/// Starts onboarding if the bot needs it and hasn't started; resumes a step
/// that was waiting for Claude when the app quit. Idempotent.
pub fn ensure(app: &AppHandle, bot_id: &str) -> Result<(), String> {
    let (bot, step) = store_op(app, |s| Ok((s.bot(bot_id)?, s.setup_step(bot_id)?)))?;
    if bot.setup_state != SetupState::Pending && !bot.editing {
        return Ok(());
    }
    match step {
        None => enter(app, &bot, Step::Kind),
        Some(Step::Generating { what }) => {
            // Already generating if the bot is busy; otherwise the app quit mid-way.
            if let Some(ticket) = app.state::<AppState>().runs.start(app, bot_id) {
                generate(app.clone(), ticket, what);
            }
            Ok(())
        }
        Some(_) => Ok(()),
    }
}

/// Restarts onboarding from the first step ("Redo setup").
pub fn restart(app: &AppHandle, bot_id: &str) -> Result<(), String> {
    discard_changes(app, bot_id)?;
    store_op(app, |s| s.set_setup(bot_id, SetupState::Pending, None))?;
    events::bots_changed(app);
    ensure(app, bot_id)
}

pub fn skip(app: &AppHandle, bot_id: &str) -> Result<(), String> {
    store_op(app, |s| {
        s.set_setup(bot_id, SetupState::Skipped, None)?;
        s.set_session_id(bot_id, None)
    })?;
    post(app, bot_id, MessageBody::System { text: format!("Setup skipped. Type {COMMAND} any time to set me up.") });
    events::bots_changed(app);
    Ok(())
}

/// `/setup` typed in the chat. A bot that isn't set up starts its setup
/// over; a set-up bot shows its current setup and waits for changes.
pub fn command(app: &AppHandle, bot_id: &str) -> Result<(), String> {
    let bot = store_op(app, |s| s.bot(bot_id))?;
    if bot.setup_state != SetupState::Done {
        return restart(app, bot_id);
    }
    discard_changes(app, bot_id)?;
    enter(app, &bot, Step::Edit { draft: bot.config.clone(), name: None })?;
    post(app, bot_id, MessageBody::SetupCurrent { config: bot.config });
    Ok(())
}

/// "Exit setup": leaves `/setup` without saving the change under review.
pub fn exit_edit(app: &AppHandle, bot_id: &str) -> Result<(), String> {
    let (bot, step) = store_op(app, |s| Ok((s.bot(bot_id)?, s.setup_step(bot_id)?)))?;
    if !bot.editing {
        return Ok(());
    }
    if matches!(step, Some(Step::Generating { .. })) {
        app.state::<AppState>().runs.cancel(bot_id);
    }
    discard_changes(app, bot_id)?;
    store_op(app, |s| s.set_setup(bot_id, SetupState::Done, None))?;
    post(app, bot_id, MessageBody::System { text: "Setup closed. Nothing changed.".into() });
    events::bots_changed(app);
    Ok(())
}

/// Locks `/setup` changes that are still waiting to be saved.
fn discard_changes(app: &AppHandle, bot_id: &str) -> Result<(), String> {
    let open = store_op(app, |s| Ok(s.messages(bot_id)))?.into_iter().filter(|m| {
        matches!(m.body, MessageBody::SetupReview { previous: Some(_), confirmed: false, discarded: false, .. })
    });
    for message in open {
        let card = store_op(app, |s| {
            s.update_message(bot_id, &message.id, |m| {
                if let MessageBody::SetupReview { discarded, .. } = &mut m.body {
                    *discarded = true;
                }
            })
        })?;
        events::message(app, bot_id, card);
    }
    Ok(())
}

/// A message typed while onboarding.
pub fn answer_text(app: &AppHandle, bot_id: &str, text: String) -> Result<(), String> {
    advance(app, bot_id, Input::Text(text))
}

/// A card answered while onboarding. Returns the updated card.
pub fn answer_card(app: &AppHandle, bot_id: &str, message_id: &str, answer: SetupAnswer) -> Result<Message, String> {
    let step = store_op(app, |s| s.setup_step(bot_id))?.ok_or("Setup is not running.")?;
    let card = store_op(app, |s| {
        s.messages(bot_id).into_iter().find(|m| m.id == message_id).ok_or_else(|| format!("unknown message {message_id}"))
    })?;
    let answered = match &card.body {
        MessageBody::SetupChoice { selected, .. } => selected.is_some(),
        MessageBody::SetupSchedule { submitted, .. } | MessageBody::SetupFolders { submitted, .. } => *submitted,
        MessageBody::SetupReview { confirmed, discarded, .. } => *confirmed || *discarded,
        _ => true,
    };
    if answered || !card_matches(&step, &card.body) {
        return Err("This question was already answered.".into());
    }
    // Validate before locking the card, so a bad answer leaves it editable.
    let mut config = store_op(app, |s| s.bot(bot_id))?.config;
    apply(&step, Input::Card(answer.clone()), &mut config)?;
    let card = store_op(app, |s| s.update_message(bot_id, message_id, |m| mark_answered(&mut m.body, &answer)))?;
    events::message(app, bot_id, card.clone());
    advance(app, bot_id, Input::Card(answer))?;
    Ok(card)
}

fn advance(app: &AppHandle, bot_id: &str, input: Input) -> Result<(), String> {
    let (mut bot, step) = store_op(app, |s| Ok((s.bot(bot_id)?, s.setup_step(bot_id)?)))?;
    let step = step.ok_or("Setup is not running.")?;
    let next = match apply(&step, input, &mut bot.config) {
        Ok(next) => next,
        // A typed message that doesn't fit: answer in the chat instead of failing the send.
        Err(hint) => {
            post(app, bot_id, MessageBody::Agent { text: hint });
            return Ok(());
        }
    };
    store_op(app, |s| s.set_config(bot_id, &bot.config))?;
    match next {
        Next::Ask(step) => enter(app, &bot, step),
        Next::Generate(what) => {
            if matches!(what, Generate::Edit { .. }) {
                // A new request replaces the change being reviewed.
                discard_changes(app, bot_id)?;
            }
            let generating = Step::Generating { what: what.clone() };
            store_op(app, |s| s.set_setup(bot_id, generating.state(), Some(&generating)))?;
            let Some(ticket) = app.state::<AppState>().runs.start(app, bot_id) else {
                return Err("I'm still busy, try again in a moment.".into());
            };
            generate(app.clone(), ticket, what);
            Ok(())
        }
        Next::Done => {
            if let Step::Edit { name: Some(name), .. } = &step {
                store_op(app, |s| s.set_name(bot_id, name))?;
                bot.name = name.clone();
            }
            finish(app, &bot, matches!(step, Step::Edit { .. }))
        }
    }
}

/// Saves `step` and posts what the bot says or shows for it.
fn enter(app: &AppHandle, bot: &Bot, step: Step) -> Result<(), String> {
    store_op(app, |s| s.set_setup(&bot.id, step.state(), Some(&step)))?;
    let config = &bot.config;
    let body = match &step {
        Step::Kind => MessageBody::SetupChoice {
            step: "kind".into(),
            question: format!("Hi, I'm {}! What should I do for you?", bot.name),
            options: vec![CHAT.into(), DAILY.into(), INTERVAL.into(), ON_DATE.into()],
            selected: None,
        },
        Step::Description => MessageBody::Agent {
            text: match config.schedule.as_ref().map(|s| s.every_minutes) {
                Some(None) if config.schedule.as_ref().is_some_and(|s| s.date.is_some()) => "Describe the task I should do.\n\nFor example: \u{201c}Sum up last month's expenses from my notes and remind me to pay rent.\u{201d}",
                Some(None) => "Describe the job I should do each day.\n\nFor example: \u{201c}Give me a morning brief of AI news and anything due today in my notes.\u{201d}",
                Some(Some(_)) => "Describe the job I should do on each run.\n\nFor example: \u{201c}Check my Downloads folder for new invoices and add them to my expenses sheet.\u{201d}",
                None => "Describe what I should do.\n\nFor example: \u{201c}Help me write replies to customer emails in a friendly, professional tone.\u{201d}",
            }
            .into(),
        },
        Step::Schedule => {
            let schedule = config.schedule.clone().unwrap_or_default();
            MessageBody::SetupSchedule {
                time: schedule.time,
                days: schedule.days,
                every_minutes: schedule.every_minutes,
                date: schedule.date,
                monthly: schedule.monthly,
                notify: schedule.notify,
                submitted: false,
            }
        }
        Step::Web => MessageBody::SetupChoice {
            step: "web".into(),
            question: "Should I be able to search the web?".into(),
            options: vec![YES.into(), NO.into()],
            selected: None,
        },
        Step::Workspace => MessageBody::SetupFolders { folders: config.workspace_folders.clone(), submitted: false },
        Step::Clarify { questions, answers } => {
            let question = &questions[answers.len()];
            MessageBody::Agent {
                text: if answers.is_empty() {
                    format!("A few quick questions so I get this right.\n\n{question}")
                } else {
                    question.clone()
                },
            }
        }
        Step::Review => {
            let config = config.clone();
            MessageBody::SetupReview { config, confirmed: false, previous: None, name: None, discarded: false }
        }
        Step::Generating { .. } => return Ok(()),
        // Its cards are posted by `command` and `run_generate`.
        Step::Edit { .. } => {
            events::bots_changed(app);
            return Ok(());
        }
    };
    post(app, &bot.id, body);
    events::bots_changed(app);
    Ok(())
}

/// Saves the setup; `updated` = a change made with `/setup`.
fn finish(app: &AppHandle, bot: &Bot, updated: bool) -> Result<(), String> {
    store_op(app, |s| {
        s.set_setup(&bot.id, SetupState::Done, None)?;
        // The session's system prompt is fixed when it starts; begin one with the new instructions.
        s.set_session_id(&bot.id, None)
    })?;
    let mut text = if updated { "Setup updated" } else { "Setup complete" }.to_string();
    if let Some(schedule) = &bot.config.schedule {
        let now = chrono::Local::now();
        if let Some(n) = schedule.every_minutes {
            text += &format!(" \u{b7} Runs every {}", agent::describe_every(n));
        } else if let Some(next) = crate::scheduler::next_run(schedule, now) {
            text += &format!(" \u{b7} Next run: {}", crate::scheduler::describe_next_run(next, now));
        }
    }
    post(app, &bot.id, MessageBody::System { text });
    events::bots_changed(app);
    Ok(())
}

/// Asks Claude for clarifying questions or the final instructions, then
/// moves on. Falls back to sensible defaults if Claude can't be reached.
fn generate(app: AppHandle, ticket: Ticket, what: Generate) {
    tauri::async_runtime::spawn(async move {
        let bot_id = ticket.bot_id.clone();
        let result = run_generate(&app, &ticket, &what).await;
        drop(ticket);
        if let Err(e) = result {
            post(&app, &bot_id, MessageBody::System { text: e });
        }
    });
}

async fn run_generate(app: &AppHandle, ticket: &Ticket, what: &Generate) -> Result<(), String> {
    let bot_id = ticket.bot_id.as_str();
    let bot = store_op(app, |s| s.bot(bot_id))?;
    let summary = describe_for_claude(&bot);
    let ask = |system: String, prompt: String, schema: serde_json::Value| {
        let (app, cancel, model) = (app.clone(), ticket.cancel.clone(), Some(agent::model(app, &bot)));
        async move {
            let bin = agent::ready_binary(&app).await?;
            claude::ask_json(&bin, agent::workdir(&app, bot_id), system, prompt, schema, model, cancel).await
        }
    };
    // The step to go to, and what to post after entering it.
    let (next, follow_up) = match what {
        Generate::Questions => {
            let result = ask(
                QUESTIONS_PROMPT.into(),
                summary,
                json!({
                    "type": "object",
                    "properties": {"questions": {"type": "array", "items": {"type": "string"}, "maxItems": 3}},
                    "required": ["questions"],
                    "additionalProperties": false
                }),
            )
            .await;
            let questions: Vec<String> = match result {
                Ok(v) => serde_json::from_value(v["questions"].clone()).unwrap_or_default(),
                Err(e) => {
                    eprintln!("clarifying questions failed: {e}");
                    Vec::new()
                }
            };
            let questions: Vec<String> =
                questions.into_iter().map(|q| q.trim().to_string()).filter(|q| !q.is_empty()).take(3).collect();
            let next = match questions.is_empty() {
                true => Step::Review,
                false => Step::Clarify { questions, answers: Vec::new() },
            };
            (next, Vec::new())
        }
        Generate::Review { clarifications } => {
            let mut prompt = summary;
            if !clarifications.is_empty() {
                prompt += "\n\nClarifications:\n";
                for (q, a) in clarifications {
                    prompt += &format!("Q: {q}\nA: {a}\n");
                }
            }
            let result = ask(
                REVIEW_PROMPT.into(),
                prompt,
                json!({
                    "type": "object",
                    "properties": {"instructions": {"type": "string"}, "task": {"type": "string"}},
                    "required": ["instructions", "task"],
                    "additionalProperties": false
                }),
            )
            .await;
            let (instructions, task) = match result {
                Ok(v) => (
                    v["instructions"].as_str().unwrap_or_default().trim().to_string(),
                    v["task"].as_str().unwrap_or_default().trim().to_string(),
                ),
                Err(e) => {
                    eprintln!("writing instructions failed: {e}");
                    (String::new(), String::new())
                }
            };
            let mut config = bot.config.clone();
            config.instructions =
                if instructions.is_empty() { config.description.clone() } else { instructions };
            if let Some(schedule) = &mut config.schedule {
                schedule.task = if task.is_empty() { config.description.clone() } else { task };
            }
            store_op(app, |s| s.set_config(bot_id, &config))?;
            (Step::Review, Vec::new())
        }
        Generate::Edit { request, draft, name } => {
            let name = name.as_deref().unwrap_or(&bot.name);
            let result = ask(EDIT_PROMPT.into(), describe_edit(name, draft, request), edit_schema()).await;
            match result {
                Ok(v) => {
                    let is_dir = |p: &str| Path::new(p).is_absolute() && Path::new(p).is_dir();
                    let (mut config, mut note) = apply_edit(draft, &v, is_dir);
                    let name = Some(edit_name(name, &v)).filter(|n| *n != bot.name);
                    let now = chrono::Local::now();
                    if let Some(Err(e)) =
                        config.schedule.as_ref().map(|s| crate::scheduler::check_date(s, draft.schedule.as_ref(), now))
                    {
                        config.schedule = draft.schedule.clone();
                        note = [note, format!("{e}, so I kept the schedule as it was.")].join("\n\n").trim().to_string();
                    }
                    let mut follow_up: Vec<MessageBody> = Vec::new();
                    if !note.is_empty() {
                        follow_up.push(MessageBody::Agent { text: note });
                    }
                    if config == bot.config && name.is_none() {
                        if follow_up.is_empty() {
                            follow_up.push(MessageBody::Agent { text: "That's how I'm set up already.".into() });
                        }
                    } else {
                        follow_up.push(MessageBody::SetupReview {
                            config: config.clone(),
                            confirmed: false,
                            previous: Some(bot.config.clone()),
                            name: name.clone(),
                            discarded: false,
                        });
                    }
                    (Step::Edit { draft: config, name }, follow_up)
                }
                Err(e) => {
                    let text = match e.as_str() {
                        "stopped" => "Stopped".to_string(),
                        _ => format!("I couldn't change my setup: {e}"),
                    };
                    let name = Some(name.to_string()).filter(|n| *n != bot.name);
                    (Step::Edit { draft: draft.clone(), name }, vec![MessageBody::System { text }])
                }
            }
        }
    };
    // Skipped, restarted or closed while Claude was thinking: drop the result.
    let generating = Step::Generating { what: what.clone() };
    let current = store_op(app, |s| Ok((s.bot(bot_id)?.setup_state, s.setup_step(bot_id)?)))?;
    if current != (generating.state(), Some(generating)) {
        return Ok(());
    }
    let bot = store_op(app, |s| s.bot(bot_id))?;
    enter(app, &bot, next)?;
    for body in follow_up {
        post(app, bot_id, body);
    }
    Ok(())
}

fn describe_for_claude(bot: &Bot) -> String {
    let config = &bot.config;
    let mut s = format!("Agent name: {}\n", bot.name);
    match &config.schedule {
        Some(schedule) => {
            let days = agent::describe_days(&schedule.days);
            s += &match schedule.every_minutes {
                None if schedule.date.is_some() => format!(
                    "Kind: scheduled task, runs {} at {} and posts the result in the chat\n",
                    agent::describe_date(schedule).unwrap_or_default(),
                    schedule.time
                ),
                None => format!("Kind: daily job, runs {days} at {} and posts the result in the chat\n", schedule.time),
                Some(n) => format!(
                    "Kind: scheduled job, runs every {} ({days}) and posts the result in the chat\n",
                    agent::describe_every(n)
                ),
            }
        }
        None => s += "Kind: chat agent, answers the user's messages\n",
    }
    s += &format!("Web access: {}\n", if config.web_access { "yes" } else { "no" });
    if config.workspace_folders.is_empty() {
        s += "Folders it works with: none\n";
    } else {
        s += &format!("Folders it works with: {}\n", config.workspace_folders.join(", "));
    }
    s += &format!("\nUser's description:\n{}", config.description);
    s
}

/// What Claude gets for a `/setup` change: the setup so far and the request.
fn describe_edit(name: &str, draft: &AgentConfig, request: &str) -> String {
    // A chat agent shows the default schedule, used if it becomes a scheduled job.
    let schedule = draft.schedule.clone().unwrap_or_default();
    let current = json!({
        "name": name,
        "description": draft.description,
        "instructions": draft.instructions,
        "scheduledJob": draft.schedule.is_some(),
        "everyMinutes": schedule.every_minutes.unwrap_or(0),
        "time": schedule.time,
        "days": schedule.days,
        "date": schedule.date.unwrap_or_default(),
        "monthly": schedule.monthly,
        "notify": schedule.notify,
        "task": schedule.task,
        "webAccess": draft.web_access,
        "workspaceFolders": draft.workspace_folders,
    });
    let current = serde_json::to_string_pretty(&current).unwrap_or_default();
    format!("Current setup:\n{current}\n\nThe user's change request:\n{request}")
}

fn edit_schema() -> Value {
    let text = json!({"type": "string"});
    let flag = json!({"type": "boolean"});
    json!({
        "type": "object",
        "properties": {
            "name": text,
            "description": text,
            "instructions": text,
            "scheduledJob": flag,
            "everyMinutes": {"type": "integer"},
            "time": text,
            "days": {"type": "array", "items": {"type": "string", "enum": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]}},
            "date": text,
            "monthly": flag,
            "notify": flag,
            "task": text,
            "webAccess": flag,
            "workspaceFolders": {"type": "array", "items": {"type": "string"}},
            "note": text
        },
        "required": ["name", "description", "instructions", "scheduledJob", "everyMinutes", "time", "days", "date", "monthly", "notify", "task", "webAccess", "workspaceFolders", "note"],
        "additionalProperties": false
    })
}

/// Builds the config Claude proposed for a `/setup` change from `draft`,
/// keeping as it was anything missing or invalid. New folders must exist
/// (`is_dir`). Returns the config and a note for the user.
pub fn apply_edit(draft: &AgentConfig, v: &Value, is_dir: impl Fn(&str) -> bool) -> (AgentConfig, String) {
    let text = |key: &str| v[key].as_str().map(str::trim).filter(|t| !t.is_empty()).map(String::from);
    let mut config = draft.clone();
    let mut notes: Vec<String> = text("note").into_iter().collect();
    config.description = text("description").unwrap_or(config.description);
    config.instructions = text("instructions").unwrap_or(config.instructions);
    if let Some(web) = v["webAccess"].as_bool() {
        config.web_access = web;
    }
    match v["scheduledJob"].as_bool() {
        Some(false) => config.schedule = None,
        Some(true) => {
            let schedule = config.schedule.get_or_insert_with(Schedule::default);
            match v["everyMinutes"].as_u64() {
                Some(0) => schedule.every_minutes = None,
                Some(n) => {
                    let n = u32::try_from(n).unwrap_or(u32::MAX).clamp(Schedule::MIN_EVERY, Schedule::MAX_EVERY);
                    schedule.every_minutes = Some(n);
                }
                None => {}
            }
            if let Some(time) = text("time").and_then(|t| chrono::NaiveTime::parse_from_str(&t, "%H:%M").ok()) {
                schedule.time = time.format("%H:%M").to_string();
            }
            let days: Vec<Weekday> = serde_json::from_value(v["days"].clone()).unwrap_or_default();
            if !days.is_empty() {
                schedule.days = Weekday::ALL.into_iter().filter(|d| days.contains(d)).collect();
            }
            // "" makes it daily again; a date that doesn't parse is ignored; an interval has none.
            match v["date"].as_str().map(str::trim) {
                Some("") => schedule.date = None,
                Some(date) => {
                    if let Ok(date) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
                        schedule.date = Some(date.format("%Y-%m-%d").to_string());
                    }
                }
                None => {}
            }
            if schedule.every_minutes.is_some() {
                schedule.date = None;
            }
            if let Some(monthly) = v["monthly"].as_bool() {
                schedule.monthly = monthly;
            }
            schedule.monthly &= schedule.date.is_some();
            if let Some(notify) = v["notify"].as_bool() {
                schedule.notify = notify;
            }
            if let Some(task) = text("task") {
                schedule.task = task;
            } else if schedule.task.is_empty() {
                schedule.task = config.description.clone();
            }
        }
        None => {}
    }
    if let Ok(folders) = serde_json::from_value::<Vec<String>>(v["workspaceFolders"].clone()) {
        config.workspace_folders = Vec::new();
        for folder in dedupe(folders) {
            let path = expand_home(&folder);
            if draft.workspace_folders.contains(&path) || is_dir(&path) {
                config.workspace_folders.push(path);
            } else {
                notes.push(format!("I couldn't find the folder {folder}, so I left it out."));
            }
        }
    }
    (config, notes.join("\n\n"))
}

/// The name Claude proposed for a `/setup` change, or `current` if it's
/// missing or not a valid name.
pub fn edit_name(current: &str, v: &Value) -> String {
    v["name"].as_str().and_then(|n| Bot::clean_name(n).ok()).unwrap_or_else(|| current.to_string())
}

/// "~/notes" -> "/Users/me/notes".
fn expand_home(path: &str) -> String {
    match (path.strip_prefix('~'), std::env::home_dir()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            format!("{}{rest}", home.display())
        }
        _ => path.to_string(),
    }
}

const QUESTIONS_PROMPT: &str = "You help a user set up a personal AI agent in Kbot, a desktop app. \
Given the agent's setup, ask at most 3 short clarifying questions whose answers would change how the agent behaves \
(for example: focus, sources, length, format, tone). Don't ask about anything already clear, and nothing about the schedule, \
web access or folders, which are set already. Return an empty list if the description is clear enough. \
Write the questions in the language of the user's description.";

const REVIEW_PROMPT: &str = "You help a user set up a personal AI agent in Kbot, a desktop app. \
From the agent's setup and the user's answers, write:\n\
- instructions: the agent's instructions, addressed to the agent as \"you\". Concise and concrete: its purpose, what to focus on, \
output format and tone. Include every preference the user stated. Plain text, no Markdown headings.\n\
- task: for a job that runs by itself (daily, on an interval or on a date), what to do on each run, in one short paragraph. \
For a chat agent, an empty string.\n\
Write both in the language of the user's description.";

const EDIT_PROMPT: &str = "You help a user change the setup of their personal AI agent in Kbot, a desktop app. \
You get the agent's current setup as JSON and the user's change request. Return the whole setup with the request applied:\n\
- Change only what the request asks for, plus whatever has to change with it. Copy everything else exactly.\n\
- name: the agent's name, at most 60 characters.\n\
- description: one or two sentences on what the agent does.\n\
- instructions: the agent's instructions, addressed to the agent as \"you\". Concise and concrete, plain text, no Markdown headings. \
Work a new preference into them rather than appending the request.\n\
- scheduledJob: whether the agent also runs a job by itself. everyMinutes: 0 for once a day at time (or on date), or run every \
this many minutes (5 to 1440). time: local 24-hour \"HH:MM\" of a daily run or a run on date. days: the days it runs daily or on \
an interval. date: \"YYYY-MM-DD\" for a task that runs once on that date instead of daily (everyMinutes 0), or \"\" for none. \
monthly: a task on a date repeats every month on that day. \
notify: show a notification when a run finishes. task: what to do on each run, one short paragraph.\n\
- webAccess: whether it can search the web.\n\
- workspaceFolders: absolute paths of folders it works with. Add or remove only folders the user names.\n\
- note: one or two short sentences telling the user what you changed. If the request is unclear, or asks for something \
the setup doesn't cover (like the agent's icon), change nothing and say so.\n\
Write the note, and any text you change, in the language of the user's request.";

#[cfg(test)]
mod tests {
    use super::*;

    fn choice(option: &str) -> Input {
        Input::Card(SetupAnswer::Choice { option: option.into() })
    }

    #[test]
    fn daily_job_walks_every_step() {
        let mut config = AgentConfig::default();
        assert_eq!(apply(&Step::Kind, choice(DAILY), &mut config), Ok(Next::Ask(Step::Description)));
        assert!(config.schedule.is_some());
        assert_eq!(
            apply(&Step::Description, Input::Text("AI news brief".into()), &mut config),
            Ok(Next::Ask(Step::Schedule))
        );
        let schedule = SetupAnswer::Schedule {
            time: "07:30".into(),
            days: vec![Weekday::Fri, Weekday::Mon],
            every_minutes: None,
            date: None,
            monthly: false,
            notify: false,
        };
        assert_eq!(apply(&Step::Schedule, Input::Card(schedule), &mut config), Ok(Next::Ask(Step::Web)));
        assert_eq!(apply(&Step::Web, choice(YES), &mut config), Ok(Next::Ask(Step::Workspace)));
        let folders = SetupAnswer::Folders { folders: vec!["/a".into(), "/a".into(), " ".into()] };
        assert_eq!(apply(&Step::Workspace, Input::Card(folders), &mut config), Ok(Next::Generate(Generate::Questions)));

        let clarify = Step::Clarify { questions: vec!["Q1".into(), "Q2".into()], answers: vec![] };
        let next = apply(&clarify, Input::Text("A1".into()), &mut config).unwrap();
        let Next::Ask(clarify) = next else { panic!("expected another question, got {next:?}") };
        assert_eq!(
            apply(&clarify, Input::Text("A2".into()), &mut config),
            Ok(Next::Generate(Generate::Review {
                clarifications: vec![("Q1".into(), "A1".into()), ("Q2".into(), "A2".into())]
            }))
        );
        let review = SetupAnswer::Review { instructions: " Be brief. ".into(), task: Some("Brief me".into()) };
        assert_eq!(apply(&Step::Review, Input::Card(review), &mut config), Ok(Next::Done));

        let schedule = config.schedule.unwrap();
        assert_eq!((schedule.time.as_str(), schedule.notify, schedule.task.as_str()), ("07:30", false, "Brief me"));
        assert_eq!(schedule.days, [Weekday::Mon, Weekday::Fri], "days kept in week order");
        assert_eq!(config.description, "AI news brief");
        assert_eq!(config.instructions, "Be brief.");
        assert!(config.web_access);
        assert_eq!(config.workspace_folders, ["/a"]);
    }

    #[test]
    fn interval_job_runs_every_few_minutes() {
        let mut config = AgentConfig::default();
        apply(&Step::Kind, choice(INTERVAL), &mut config).unwrap();
        assert_eq!(config.schedule, Some(Schedule::interval()));
        assert_eq!(
            apply(&Step::Description, Input::Text("Check the build".into()), &mut config),
            Ok(Next::Ask(Step::Schedule))
        );
        // The time card field is ignored on an interval.
        let schedule = SetupAnswer::Schedule {
            time: "".into(),
            days: Weekday::ALL.to_vec(),
            every_minutes: Some(15),
            date: None,
            monthly: false,
            notify: true,
        };
        assert_eq!(apply(&Step::Schedule, Input::Card(schedule), &mut config), Ok(Next::Ask(Step::Web)));
        let schedule = config.schedule.as_ref().unwrap();
        assert_eq!((schedule.every_minutes, schedule.notify, schedule.time.as_str()), (Some(15), true, "08:00"));

        // Going back to the kind step switches between daily and interval.
        apply(&Step::Kind, choice(DAILY), &mut config).unwrap();
        assert_eq!(config.schedule, Some(Schedule::default()));
        apply(&Step::Kind, choice(INTERVAL), &mut config).unwrap();
        assert_eq!(config.schedule.and_then(|s| s.every_minutes), Some(Schedule::DEFAULT_EVERY));
    }

    #[test]
    fn a_task_runs_on_a_date() {
        let mut config = AgentConfig::default();
        apply(&Step::Kind, choice(ON_DATE), &mut config).unwrap();
        let tomorrow = chrono::Local::now().date_naive().succ_opt().unwrap();
        assert_eq!(config.schedule, Some(Schedule::on_date(tomorrow)), "tomorrow at 08:00 to start with");
        apply(&Step::Description, Input::Text("Pay rent".into()), &mut config).unwrap();
        let card = |date: &str, monthly| {
            Input::Card(SetupAnswer::Schedule {
                time: "09:15".into(),
                days: Weekday::ALL.to_vec(),
                every_minutes: None,
                date: Some(date.into()),
                monthly,
                notify: true,
            })
        };
        assert_eq!(apply(&Step::Schedule, card("2099-01-31", true), &mut config), Ok(Next::Ask(Step::Web)));
        let schedule = config.schedule.clone().unwrap();
        assert_eq!((schedule.date.as_deref(), schedule.monthly, schedule.time.as_str()), (Some("2099-01-31"), true, "09:15"));
        assert!(describe_for_claude(&Bot { config: config.clone(), ..bot() }).contains("runs monthly on the 31st at 09:15"));

        let past = apply(&Step::Schedule, card("2020-01-31", false), &mut config);
        assert_eq!(past, Err("Pick a date and time in the future".into()));
        assert!(apply(&Step::Schedule, card("2099-02-30", false), &mut config).is_err(), "no such date");

        // Switching kinds keeps or drops the date.
        apply(&Step::Kind, choice(ON_DATE), &mut config).unwrap();
        assert_eq!(config.schedule.as_ref().and_then(|s| s.date.as_deref()), Some("2099-01-31"));
        apply(&Step::Kind, choice(DAILY), &mut config).unwrap();
        assert_eq!(config.schedule, Some(Schedule::default()));
    }

    fn bot() -> Bot {
        serde_json::from_value(json!({
            "id": "b", "name": "Rent Bot", "avatar": {"kind": "icon", "icon": "happy", "color": "#000"},
            "updatedAt": 0, "preview": "", "setupState": "pending", "config": {}, "lastRunAt": null
        }))
        .unwrap()
    }

    #[test]
    fn chat_agent_skips_schedule() {
        let mut config = AgentConfig { schedule: Some(Schedule::default()), ..AgentConfig::default() };
        apply(&Step::Kind, choice(CHAT), &mut config).unwrap();
        assert_eq!(config.schedule, None);
        assert_eq!(apply(&Step::Description, Input::Text("Email helper".into()), &mut config), Ok(Next::Ask(Step::Web)));
    }

    #[test]
    fn rejects_answers_that_dont_fit() {
        let mut config = AgentConfig::default();
        assert!(apply(&Step::Kind, Input::Text("daily please".into()), &mut config).is_err());
        assert!(apply(&Step::Web, choice("Maybe"), &mut config).is_err());
        assert!(apply(&Step::Description, choice(YES), &mut config).is_err());
        let schedule = |time: &str, days: Vec<Weekday>, every_minutes| {
            Input::Card(SetupAnswer::Schedule { time: time.into(), days, every_minutes, date: None, monthly: false, notify: true })
        };
        assert!(apply(&Step::Schedule, schedule("8am", Weekday::ALL.to_vec(), None), &mut config).is_err());
        assert!(apply(&Step::Schedule, schedule("08:00", vec![], None), &mut config).is_err());
        assert!(apply(&Step::Schedule, schedule("08:00", vec![], Some(30)), &mut config).is_err());
        assert!(apply(&Step::Schedule, schedule("08:00", Weekday::ALL.to_vec(), Some(2)), &mut config).is_err());
        assert!(apply(&Step::Schedule, schedule("08:00", Weekday::ALL.to_vec(), Some(1441)), &mut config).is_err());
        let generating = Step::Generating { what: Generate::Questions };
        assert!(apply(&generating, Input::Text("hello?".into()), &mut config).is_err());
    }

    #[test]
    fn edit_takes_requests_then_saves_the_draft() {
        let saved = AgentConfig { instructions: "Be brief.".into(), ..AgentConfig::default() };
        let draft = AgentConfig { instructions: "Be brief. Use bullets.".into(), web_access: true, ..saved.clone() };
        let step = Step::Edit { draft: draft.clone(), name: Some("Brief Bot".into()) };
        assert_eq!(step.state(), SetupState::Done);
        let mut config = saved.clone();
        assert_eq!(
            apply(&step, Input::Text("no web".into()), &mut config),
            Ok(Next::Generate(Generate::Edit {
                request: "no web".into(),
                draft: draft.clone(),
                name: Some("Brief Bot".into())
            }))
        );
        assert_eq!(config, saved, "nothing changes before saving");
        let save = SetupAnswer::Review { instructions: " Use bullets. ".into(), task: None };
        assert_eq!(apply(&step, Input::Card(save), &mut config), Ok(Next::Done));
        assert_eq!(config, AgentConfig { instructions: "Use bullets.".into(), ..draft });
        assert!(apply(&step, choice(YES), &mut config).is_err());
    }

    #[test]
    fn edit_name_keeps_a_name_that_doesnt_fit() {
        assert_eq!(edit_name("Planner", &json!({"name": "  Week Planner "})), "Week Planner");
        assert_eq!(edit_name("Planner", &json!({"name": "   "})), "Planner");
        assert_eq!(edit_name("Planner", &json!({"name": "x".repeat(Bot::MAX_NAME + 1)})), "Planner");
        assert_eq!(edit_name("Planner", &json!({})), "Planner");
    }

    #[test]
    fn apply_edit_keeps_what_claude_got_wrong() {
        let draft = AgentConfig {
            description: "AI news".into(),
            instructions: "Brief me.".into(),
            schedule: Some(Schedule { task: "Brief".into(), ..Schedule::default() }),
            workspace_folders: vec!["/notes".into()],
            ..AgentConfig::default()
        };
        let v = json!({
            "description": "AI and chip news",
            "instructions": "  ",
            "scheduledJob": true,
            "everyMinutes": 0,
            "time": "7:05",
            "days": ["fri", "mon"],
            "notify": false,
            "task": "",
            "webAccess": true,
            "workspaceFolders": ["/notes", "/real", "/missing", "/real"],
            "note": "Moved it to 07:05."
        });
        let (config, note) = apply_edit(&draft, &v, |p| p == "/real");
        assert_eq!(config.description, "AI and chip news");
        assert_eq!(config.instructions, "Brief me.", "empty text keeps the old one");
        let schedule = config.schedule.unwrap();
        assert_eq!((schedule.time.as_str(), schedule.notify, schedule.task.as_str()), ("07:05", false, "Brief"));
        assert_eq!(schedule.days, [Weekday::Mon, Weekday::Fri]);
        assert!(config.web_access);
        assert_eq!(config.workspace_folders, ["/notes", "/real"]);
        assert_eq!(note, "Moved it to 07:05.\n\nI couldn't find the folder /missing, so I left it out.");

        let bad = json!({"scheduledJob": true, "time": "noon", "days": ["someday"], "everyMinutes": -5});
        let (config, note) = apply_edit(&draft, &bad, |_| false);
        assert_eq!(config, draft, "invalid values are ignored");
        assert_eq!(note, "");
        let (config, _) = apply_edit(&draft, &json!({"scheduledJob": false}), |_| false);
        assert_eq!(config.schedule, None);
        let chat = AgentConfig { description: "News".into(), ..AgentConfig::default() };
        let (config, _) = apply_edit(&chat, &json!({"scheduledJob": true}), |_| false);
        assert_eq!(config.schedule.map(|s| s.task), Some("News".into()), "a new scheduled job gets a task");

        let every = |n: i64| {
            let (config, _) = apply_edit(&draft, &json!({"scheduledJob": true, "everyMinutes": n}), |_| false);
            config.schedule.unwrap().every_minutes
        };
        assert_eq!(every(15), Some(15));
        assert_eq!(every(1), Some(Schedule::MIN_EVERY), "clamped to the shortest interval");
        assert_eq!(every(100_000), Some(Schedule::MAX_EVERY));
        let interval = AgentConfig { schedule: Some(Schedule::interval()), ..draft.clone() };
        let (config, _) = apply_edit(&interval, &json!({"scheduledJob": true, "everyMinutes": 0}), |_| false);
        assert_eq!(config.schedule.unwrap().every_minutes, None, "0 makes it daily");

        let on_date = |from: &AgentConfig, v: Value| apply_edit(from, &v, |_| false).0.schedule.unwrap();
        let s = on_date(&interval, json!({"scheduledJob": true, "everyMinutes": 0, "date": "2099-3-1", "monthly": true}));
        assert_eq!((s.every_minutes, s.date.as_deref(), s.monthly), (None, Some("2099-03-01"), true));
        let dated = AgentConfig { schedule: Some(s), ..draft.clone() };
        let s = on_date(&dated, json!({"scheduledJob": true, "everyMinutes": 0, "date": "", "monthly": true}));
        assert_eq!((s.date, s.monthly), (None, false), "\"\" makes it daily");
        let s = on_date(&dated, json!({"scheduledJob": true, "everyMinutes": 30, "date": "2099-03-01"}));
        assert_eq!((s.every_minutes, s.date), (Some(30), None), "an interval has no date");
        let s = on_date(&dated, json!({"scheduledJob": true, "date": "soon"}));
        assert_eq!(s.date.as_deref(), Some("2099-03-01"), "a bad date is ignored");
    }

    #[test]
    fn step_round_trips_as_json() {
        let edit = Step::Generating {
            what: Generate::Edit { request: "shorter".into(), draft: AgentConfig::default(), name: None },
        };
        // Steps saved before renaming came in have no `name`.
        let old = r#"{"step":"edit","draft":{"description":"","instructions":"","schedule":null,"workspaceFolders":[],"webAccess":false,"model":null}}"#;
        assert_eq!(serde_json::from_str::<Step>(old).unwrap(), Step::Edit { draft: AgentConfig::default(), name: None });
        assert_eq!(serde_json::from_str::<Step>(&serde_json::to_string(&edit).unwrap()).unwrap(), edit);
        assert_eq!(edit.state(), SetupState::Done);
        assert_eq!(Step::Generating { what: Generate::Questions }.state(), SetupState::Pending);
        let step = Step::Generating {
            what: Generate::Review { clarifications: vec![("q".into(), "a".into())] },
        };
        let json = serde_json::to_string(&step).unwrap();
        assert_eq!(serde_json::from_str::<Step>(&json).unwrap(), step);
        assert!(valid_time("08:00") && !valid_time("8:00") && !valid_time("24:00"));
    }
}
