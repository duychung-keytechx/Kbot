//! Onboarding: a new bot asks the user what it should do, in the chat.
//!
//! Fixed steps (kind, schedule, web, folders) are answered with cards, so
//! nothing is parsed from free text. Claude is only used to ask a few
//! clarifying questions about the description and to turn it into
//! instructions. The current step is saved in `bots.setup_step`, so a setup
//! interrupted by quitting the app resumes where it left off.

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::agent::{self, post};
use crate::claude;
use crate::events;
use crate::models::{AgentConfig, Bot, Message, MessageBody, Schedule, SetupAnswer, SetupState, Weekday};
use crate::runs::Ticket;
use crate::AppState;

pub const CHAT: &str = "Chat with me";
pub const DAILY: &str = "Run a daily job";
pub const YES: &str = "Yes";
pub const NO: &str = "No";

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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Generate {
    Questions,
    Review { clarifications: Vec<(String, String)> },
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
            config.schedule = match option.as_str() {
                CHAT => None,
                DAILY => Some(config.schedule.take().unwrap_or_default()),
                _ => return Err(format!("unknown option {option}")),
            };
            Next::Ask(Step::Description)
        }
        (Step::Description, Input::Text(text)) => {
            config.description = text;
            Next::Ask(if config.schedule.is_some() { Step::Schedule } else { Step::Web })
        }
        (Step::Schedule, Input::Card(A::Schedule { time, days, notify })) => {
            if !valid_time(&time) {
                return Err(format!("{time} is not a valid time"));
            }
            if days.is_empty() {
                return Err("Pick at least one day".into());
            }
            let schedule = config.schedule.get_or_insert_with(Schedule::default);
            schedule.time = time;
            schedule.days = Weekday::ALL.into_iter().filter(|d| days.contains(d)).collect();
            schedule.notify = notify;
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
        (Step::Review, MessageBody::SetupReview { .. }) => true,
        _ => false,
    }
}

/// Locks an answered card and records the answer on it.
fn mark_answered(body: &mut MessageBody, answer: &SetupAnswer) {
    match (body, answer) {
        (MessageBody::SetupChoice { selected, .. }, SetupAnswer::Choice { option }) => *selected = Some(option.clone()),
        (MessageBody::SetupSchedule { time, days, notify, submitted }, SetupAnswer::Schedule { time: t, days: d, notify: n }) => {
            (*time, *days, *notify, *submitted) = (t.clone(), d.clone(), *n, true);
        }
        (MessageBody::SetupFolders { folders, submitted }, SetupAnswer::Folders { folders: f }) => {
            (*folders, *submitted) = (dedupe(f.clone()), true);
        }
        (MessageBody::SetupReview { config, confirmed }, SetupAnswer::Review { instructions, task }) => {
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
    if bot.setup_state != SetupState::Pending {
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
    store_op(app, |s| s.set_setup(bot_id, SetupState::Pending, None))?;
    events::bots_changed(app);
    ensure(app, bot_id)
}

pub fn skip(app: &AppHandle, bot_id: &str) -> Result<(), String> {
    store_op(app, |s| {
        s.set_setup(bot_id, SetupState::Skipped, None)?;
        s.set_session_id(bot_id, None)
    })?;
    post(app, bot_id, MessageBody::System { text: "Setup skipped. You can set me up any time from Settings.".into() });
    events::bots_changed(app);
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
        MessageBody::SetupReview { confirmed, .. } => *confirmed,
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
            store_op(app, |s| s.set_setup(bot_id, SetupState::Pending, Some(&Step::Generating { what: what.clone() })))?;
            let Some(ticket) = app.state::<AppState>().runs.start(app, bot_id) else {
                return Err("I'm still busy, try again in a moment.".into());
            };
            generate(app.clone(), ticket, what);
            Ok(())
        }
        Next::Done => finish(app, &bot),
    }
}

/// Saves `step` and posts what the bot says or shows for it.
fn enter(app: &AppHandle, bot: &Bot, step: Step) -> Result<(), String> {
    store_op(app, |s| s.set_setup(&bot.id, SetupState::Pending, Some(&step)))?;
    let config = &bot.config;
    let body = match &step {
        Step::Kind => MessageBody::SetupChoice {
            step: "kind".into(),
            question: format!("Hi, I'm {}! What should I do for you?", bot.name),
            options: vec![CHAT.into(), DAILY.into()],
            selected: None,
        },
        Step::Description => MessageBody::Agent {
            text: if config.schedule.is_some() {
                "Describe the job I should do each day.\n\nFor example: \u{201c}Give me a morning brief of AI news and anything due today in my notes.\u{201d}"
            } else {
                "Describe what I should do.\n\nFor example: \u{201c}Help me write replies to customer emails in a friendly, professional tone.\u{201d}"
            }
            .into(),
        },
        Step::Schedule => {
            let schedule = config.schedule.clone().unwrap_or_default();
            MessageBody::SetupSchedule { time: schedule.time, days: schedule.days, notify: schedule.notify, submitted: false }
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
        Step::Review => MessageBody::SetupReview { config: config.clone(), confirmed: false },
        Step::Generating { .. } => return Ok(()),
    };
    post(app, &bot.id, body);
    events::bots_changed(app);
    Ok(())
}

fn finish(app: &AppHandle, bot: &Bot) -> Result<(), String> {
    store_op(app, |s| {
        s.set_setup(&bot.id, SetupState::Done, None)?;
        // The session's system prompt is fixed when it starts; begin one with the new instructions.
        s.set_session_id(&bot.id, None)
    })?;
    let mut text = "Setup complete".to_string();
    if let Some(next) = bot.config.schedule.as_ref().and_then(|s| crate::scheduler::next_run(s, chrono::Local::now())) {
        text += &format!(" \u{b7} Next run: {}", crate::scheduler::describe_next_run(next, chrono::Local::now()));
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
        let (app, cancel, model) = (app.clone(), ticket.cancel.clone(), bot.config.model.clone());
        async move {
            let bin = agent::ready_binary(&app).await?;
            claude::ask_json(&bin, agent::workdir(&app, bot_id), system, prompt, schema, model, cancel).await
        }
    };
    let next = match what {
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
            if questions.is_empty() {
                Step::Review
            } else {
                Step::Clarify { questions, answers: Vec::new() }
            }
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
            Step::Review
        }
    };
    // Skipped or restarted while Claude was thinking: drop the result.
    let current = store_op(app, |s| Ok((s.bot(bot_id)?.setup_state, s.setup_step(bot_id)?)))?;
    if current != (SetupState::Pending, Some(Step::Generating { what: what.clone() })) {
        return Ok(());
    }
    let bot = store_op(app, |s| s.bot(bot_id))?;
    enter(app, &bot, next)
}

fn describe_for_claude(bot: &Bot) -> String {
    let config = &bot.config;
    let mut s = format!("Agent name: {}\n", bot.name);
    match &config.schedule {
        Some(schedule) => {
            s += &format!(
                "Kind: daily job, runs {} at {} and posts the result in the chat\n",
                agent::describe_days(&schedule.days),
                schedule.time
            )
        }
        None => s += "Kind: chat agent, answers the user's messages\n",
    }
    s += &format!("Web access: {}\n", if config.web_access { "yes" } else { "no" });
    if config.workspace_folders.is_empty() {
        s += "Folders it can read: none\n";
    } else {
        s += &format!("Folders it can read: {}\n", config.workspace_folders.join(", "));
    }
    s += &format!("\nUser's description:\n{}", config.description);
    s
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
- task: for a daily job, what to do on each run, in one short paragraph. For a chat agent, an empty string.\n\
Write both in the language of the user's description.";

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
        let schedule = SetupAnswer::Schedule { time: "07:30".into(), days: vec![Weekday::Fri, Weekday::Mon], notify: false };
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
        let bad_time = SetupAnswer::Schedule { time: "8am".into(), days: Weekday::ALL.to_vec(), notify: true };
        assert!(apply(&Step::Schedule, Input::Card(bad_time), &mut config).is_err());
        let no_days = SetupAnswer::Schedule { time: "08:00".into(), days: vec![], notify: true };
        assert!(apply(&Step::Schedule, Input::Card(no_days), &mut config).is_err());
        let generating = Step::Generating { what: Generate::Questions };
        assert!(apply(&generating, Input::Text("hello?".into()), &mut config).is_err());
    }

    #[test]
    fn step_round_trips_as_json() {
        let step = Step::Generating {
            what: Generate::Review { clarifications: vec![("q".into(), "a".into())] },
        };
        let json = serde_json::to_string(&step).unwrap();
        assert_eq!(serde_json::from_str::<Step>(&json).unwrap(), step);
        assert!(valid_time("08:00") && !valid_time("8:00") && !valid_time("24:00"));
    }
}
