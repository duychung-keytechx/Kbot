//! Agent teams runtime. A request to a team goes to its orchestrator (the
//! lead, an ordinary bot), which plans it as tasks for the members with a
//! structured call (`agent::ask_json`). Kbot then runs each task as a normal
//! turn of the member's own session, at most `MAX_PARALLEL` at a time, has the
//! lead review every result (accept, or send it back with notes), and finally
//! has the lead write one reply. The Plan card in the team chat is updated in
//! place as tasks move; members' chats show their briefs and work.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Local;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::{watch, Notify};
use tokio::task::JoinSet;

use crate::agent::{self, Outcome, Trigger};
use crate::events;
use crate::models::{
    Bot, Flow, FlowInput, FlowNode, Message, MessageBody, OnFail, PlanCard, PlanEdit, PlanState, PlanTask, TaskAction,
    TaskStatus, Team, TeamActivity, TeamMode,
};
use crate::runs::Ticket;
use crate::AppState;

/// Members working at the same time, per team.
pub const MAX_PARALLEL: usize = 3;
/// Times the lead may send a result back before it has to take it.
const MAX_REVISIONS: u32 = 2;
/// Characters of a result passed on to the lead or other members.
const RESULT_LIMIT: usize = 8000;
/// Earlier team chat messages the lead sees when planning.
const HISTORY: usize = 12;
const MAX_TASKS: usize = 8;

pub const BUSY: &str = "Wait for the team to finish, or stop it.";
const STOPPED: &str = "stopped";

/// Teams working on a request right now.
#[derive(Default)]
pub struct Teams {
    live: Mutex<HashMap<String, Live>>,
}

struct Live {
    signals: UnboundedSender<Signal>,
    activity: TeamActivity,
}

/// What the user can do to a running request.
pub enum Signal {
    /// "Pause team" / "Resume": no new tasks start while paused.
    Pause(bool),
    /// "Edit plan": changes to tasks that haven't started.
    Edit(Vec<PlanEdit>),
    /// Retry, skip or stop on a task that failed.
    Answer { task_id: String, action: TaskAction },
    /// The user wrote to a member while it works on a task; it gets the
    /// text and goes again before its result is reviewed.
    StepIn { member_id: String, text: String },
}

impl Teams {
    /// `false` if the team isn't working on a request.
    pub fn send(&self, team_id: &str, signal: Signal) -> bool {
        self.live.lock().unwrap().get(team_id).is_some_and(|live| live.signals.send(signal).is_ok())
    }

    pub fn is_live(&self, team_id: &str) -> bool {
        self.live.lock().unwrap().contains_key(team_id)
    }

    /// Whether `member_id` is working on a task of `team_id`'s request.
    pub fn working(&self, team_id: &str, member_id: &str) -> bool {
        self.live
            .lock()
            .unwrap()
            .get(team_id)
            .is_some_and(|live| live.activity.statuses.get(member_id) == Some(&TaskStatus::Working))
    }

    fn set_activity(&self, team_id: &str, activity: TeamActivity) {
        if let Some(live) = self.live.lock().unwrap().get_mut(team_id) {
            live.activity = activity;
        }
    }
}

/// Every team, with what the running ones are doing.
pub fn list(app: &AppHandle) -> Vec<Team> {
    let state = app.state::<AppState>();
    let mut teams = state.store.lock().unwrap().teams();
    let live = state.teams.live.lock().unwrap();
    for team in &mut teams {
        team.activity = live.get(&team.id).map(|l| l.activity.clone());
    }
    teams
}

/// Appends a message to a team chat and tells the UI.
pub fn post(app: &AppHandle, team_id: &str, body: MessageBody) -> Option<Message> {
    let result = app.state::<AppState>().store.lock().unwrap().push_message(team_id, Message::new(body));
    match result {
        Ok(message) => {
            events::message_only(app, team_id, message.clone());
            events::teams_changed(app);
            Some(message)
        }
        Err(err) => {
            eprintln!("posting to team {team_id} failed: {err}");
            None
        }
    }
}

/// Marks the team chat unread unless it's on screen.
fn mark_unread(app: &AppHandle, team_id: &str) {
    let state = app.state::<AppState>();
    if state.viewing.lock().unwrap().as_deref() == Some(team_id) {
        return;
    }
    if state.store.lock().unwrap().set_team_unread(team_id, true).unwrap_or(false) {
        events::teams_changed(app);
    }
}

/// Works on `text`, a request the user sent to the team chat; `ticket` is
/// held for the team's id, so `cancel_run` on it stops the whole team.
pub fn spawn(app: AppHandle, ticket: Ticket, text: String) {
    let team_id = ticket.bot_id.clone();
    let (signals, receiver) = mpsc::unbounded_channel();
    let live = Live { signals, activity: TeamActivity::default() };
    app.state::<AppState>().teams.live.lock().unwrap().insert(team_id.clone(), live);
    events::teams_changed(&app);
    tauri::async_runtime::spawn(async move {
        let result = match Run::new(&app, &team_id, text) {
            Ok(run) => run.go(&ticket, receiver).await,
            Err(err) => Err(err),
        };
        if let Err(err) = result {
            post(&app, &team_id, MessageBody::System { text: err });
            mark_unread(&app, &team_id);
        }
        app.state::<AppState>().teams.live.lock().unwrap().remove(&team_id);
        drop(ticket);
        events::teams_changed(&app);
    });
}

/// An @mention in the team chat: `member` answers by itself in its own
/// chat, and its reply is copied to the team chat. `team` is held too when
/// the team was idle, so the team chat shows it typing.
pub fn spawn_direct(app: AppHandle, team_id: String, member: Ticket, team: Option<Ticket>, text: String) {
    tauri::async_runtime::spawn(async move {
        let outcome = agent::run_turn(&app, &member, Trigger::UserMessage(text)).await;
        let bot = app.state::<AppState>().store.lock().unwrap().bot(&member.bot_id);
        let name = bot.map(|b| b.name).unwrap_or_default();
        let body = match (outcome.text.trim().is_empty(), outcome.stopped) {
            (false, _) => MessageBody::Member { bot_id: member.bot_id.clone(), name, text: outcome.text },
            (true, true) => MessageBody::System { text: format!("{name} was stopped") },
            (true, false) => MessageBody::System { text: format!("{name} couldn't reply. Its chat has the details.") },
        };
        drop(member);
        drop(team);
        post(&app, &team_id, body);
        mark_unread(&app, &team_id);
    });
}

/// `text` without a leading "@Name" for `name`.
pub fn strip_mention(text: &str, name: &str) -> String {
    let trimmed = text.trim_start();
    if let Some(rest) = trimmed.strip_prefix('@')
        && rest.is_char_boundary(name.len().min(rest.len()))
        && rest.len() >= name.len()
        && rest[..name.len()].eq_ignore_ascii_case(name)
    {
        let rest = rest[name.len()..].trim_start_matches([',', ':']).trim();
        if !rest.is_empty() {
            return rest.to_string();
        }
    }
    text.trim().to_string()
}

fn truncate(text: &str, limit: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(limit) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

fn first_line(text: &str) -> String {
    truncate(text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or(""), 140)
}

fn role_of(bot: &Bot) -> &str {
    match (bot.team_role.trim(), bot.config.description.trim()) {
        ("", "") => "no role given",
        ("", description) => description,
        (role, _) => role,
    }
}

/// Earlier messages of the team chat, oldest first, without the request
/// itself (the last message).
fn history(messages: &[Message], lead: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let messages = match messages.last() {
        Some(Message { body: MessageBody::User { .. }, .. }) => &messages[..messages.len() - 1],
        _ => messages,
    };
    for message in messages.iter().rev() {
        let line = match &message.body {
            MessageBody::User { text } => format!("User: {}", truncate(text, 1500)),
            MessageBody::Agent { text } => format!("{lead}: {}", truncate(text, 1500)),
            MessageBody::Member { name, text, .. } => format!("{name} (asked directly): {}", truncate(text, 1500)),
            _ => continue,
        };
        lines.push(line);
        if lines.len() == HISTORY {
            break;
        }
    }
    lines.reverse();
    lines.join("\n\n")
}

/// Finds a member by name, ignoring case and a leading "@".
fn find_member<'a>(members: &'a [Bot], name: &str) -> Option<&'a Bot> {
    let name = name.trim().trim_start_matches('@').trim();
    members.iter().find(|m| m.name.eq_ignore_ascii_case(name))
}

fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim()
}

/// The reply and tasks of an auto plan (`plan_schema`). Tasks for unknown
/// members are dropped; `after` keeps only earlier tasks.
fn auto_tasks(value: &Value, members: &[Bot]) -> (String, Vec<PlanTask>) {
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut tasks = Vec::new();
    for raw in value.get("tasks").and_then(Value::as_array).into_iter().flatten() {
        if tasks.len() == MAX_TASKS {
            break;
        }
        let Some(member) = find_member(members, str_of(raw, "member")) else { continue };
        let brief = str_of(raw, "brief");
        if brief.is_empty() {
            continue;
        }
        let id = format!("t{}", tasks.len() + 1);
        let after = raw
            .get("after")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str().and_then(|a| ids.get(a.trim())).cloned())
            .fold(Vec::new(), |mut acc: Vec<String>, id| {
                if !acc.contains(&id) {
                    acc.push(id);
                }
                acc
            });
        let title = match str_of(raw, "title") {
            "" => first_line(brief),
            title => truncate(title, 80),
        };
        ids.insert(str_of(raw, "id").to_string(), id.clone());
        tasks.push(PlanTask {
            id,
            title,
            member_id: member.id.clone(),
            member_name: member.name.clone(),
            brief: brief.to_string(),
            after,
            step: None,
            status: TaskStatus::Waiting,
            detail: String::new(),
            runs: 1,
            run: 0,
        });
    }
    (str_of(value, "reply").to_string(), tasks)
}

/// The reply and tasks of a flow plan (`flow_schema`): one task per node, in
/// the flow's order. A node without a brief gets its own task text; `skip`
/// counts only when the flow lets the lead leave out steps.
fn flow_tasks(value: &Value, flow: &Flow, members: &[Bot]) -> (String, Vec<PlanTask>) {
    let briefs: HashMap<&str, &Value> = value
        .get("briefs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|b| (str_of(b, "node"), b))
        .collect();
    let mut tasks = Vec::new();
    for node in &flow.nodes {
        let Some(member) = members.iter().find(|m| m.id == node.member_id) else { continue };
        let raw = briefs.get(node.id.as_str());
        let skip = flow.skip_unneeded && raw.and_then(|r| r.get("skip")).and_then(Value::as_bool).unwrap_or(false);
        let brief = match raw.map(|r| str_of(r, "brief")).unwrap_or("") {
            "" => node.task.trim().to_string(),
            brief => brief.to_string(),
        };
        let title = match node.task.trim() {
            "" => first_line(&brief),
            task => first_line(task),
        };
        tasks.push(PlanTask {
            id: node.id.clone(),
            title,
            member_id: member.id.clone(),
            member_name: member.name.clone(),
            brief,
            after: flow.waits_for(node),
            step: Some(node.step),
            status: if skip { TaskStatus::Skipped } else { TaskStatus::Waiting },
            detail: if skip { "Not needed for this request".into() } else { String::new() },
            runs: node.runs,
            run: 0,
        });
    }
    (str_of(value, "reply").to_string(), tasks)
}

fn plan_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["reply", "tasks"],
        "properties": {
            "reply": { "type": "string" },
            "tasks": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id", "member", "title", "brief", "after"],
                    "properties": {
                        "id": { "type": "string" },
                        "member": { "type": "string" },
                        "title": { "type": "string" },
                        "brief": { "type": "string" },
                        "after": { "type": "array", "items": { "type": "string" } }
                    }
                }
            }
        }
    })
}

fn flow_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["reply", "briefs"],
        "properties": {
            "reply": { "type": "string" },
            "briefs": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["node", "brief", "skip"],
                    "properties": {
                        "node": { "type": "string" },
                        "brief": { "type": "string" },
                        "skip": { "type": "boolean" }
                    }
                }
            }
        }
    })
}

fn review_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["verdict", "notes", "summary"],
        "properties": {
            "verdict": { "type": "string", "enum": ["accept", "revise"] },
            "notes": { "type": "string" },
            "summary": { "type": "string" }
        }
    })
}

fn reply_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["reply"],
        "properties": { "reply": { "type": "string" } }
    })
}

struct Review {
    accept: bool,
    notes: String,
    summary: String,
}

fn parse_review(value: Value) -> Review {
    Review {
        accept: str_of(&value, "verdict") != "revise",
        notes: str_of(&value, "notes").to_string(),
        summary: truncate(str_of(&value, "summary"), 140),
    }
}

/// Resolves once `stop` is true (or the run is gone).
async fn stopped(stop: &mut watch::Receiver<bool>) {
    loop {
        let done = *stop.borrow_and_update();
        if done || stop.changed().await.is_err() {
            return;
        }
    }
}

/// One turn of `member_id` on a task: waits until the member is free (it
/// may be answering the user), posts the brief to its chat and runs it.
async fn run_task(
    app: AppHandle,
    member_id: String,
    brief: Option<MessageBody>,
    prompt: String,
    mut stop: watch::Receiver<bool>,
) -> Outcome {
    let halted = Outcome { stopped: true, ..Outcome::default() };
    let ticket = loop {
        if *stop.borrow_and_update() {
            return halted;
        }
        if let Some(ticket) = app.state::<AppState>().runs.start(&app, &member_id) {
            break ticket;
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
            changed = stop.changed() => if changed.is_err() { return halted },
        }
    };
    if let Some(brief) = brief {
        agent::post(&app, &member_id, brief);
    }
    let cancel = ticket.cancel.clone();
    let turn = agent::run_turn(&app, &ticket, Trigger::Task(prompt));
    tokio::pin!(turn);
    tokio::select! {
        outcome = &mut turn => return outcome,
        _ = stopped(&mut stop) => {}
    }
    cancel.notify_one();
    turn.await
}

enum Event {
    Worked { task_id: String, outcome: Outcome },
    Reviewed { task_id: String, review: Result<Review, String> },
}

/// Per-task bookkeeping the card doesn't show.
#[derive(Default)]
struct Work {
    /// Turns started so far.
    attempt: u32,
    /// The member's last result.
    result: String,
    /// The lead's notes for the next turn.
    notes: String,
    /// What the user wrote to the member while it worked.
    step_ins: Vec<String>,
}

enum Finish {
    Done,
    Stopped,
}

/// One request to a team, from plan to final reply.
struct Run {
    app: AppHandle,
    team: Team,
    lead: Bot,
    /// The team's members when the request came in, without the lead.
    members: Vec<Bot>,
    request: String,
    history: String,
    card_id: Option<String>,
    card: PlanCard,
    work: HashMap<String, Work>,
    paused: bool,
    stop: watch::Sender<bool>,
}

impl Run {
    fn new(app: &AppHandle, team_id: &str, request: String) -> Result<Run, String> {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        let mut team = store.team(team_id)?;
        let lead = store.bot(&team.lead_id)?;
        let members: Vec<Bot> = store.team_bots(team_id).into_iter().filter(|b| b.id != team.lead_id).collect();
        let ids: Vec<String> = members.iter().map(|m| m.id.clone()).collect();
        team.flow = std::mem::take(&mut team.flow).normalized(&ids);
        let history = history(&store.messages(team_id), &lead.name);
        let mode = team.mode;
        Ok(Run {
            app: app.clone(),
            team,
            lead,
            members,
            request,
            history,
            card_id: None,
            card: PlanCard { mode, state: PlanState::Running, tasks: Vec::new() },
            work: HashMap::new(),
            paused: false,
            stop: watch::channel(false).0,
        })
    }

    async fn go(mut self, ticket: &Ticket, mut signals: UnboundedReceiver<Signal>) -> Result<(), String> {
        let team_id = self.team.id.clone();
        let reply = match self.plan(ticket.cancel.clone()).await {
            Err(err) if err == STOPPED => {
                post(&self.app, &team_id, MessageBody::System { text: "Stopped".into() });
                return Ok(());
            }
            result => result?,
        };
        if !reply.is_empty() {
            post(&self.app, &team_id, MessageBody::Agent { text: reply });
        }
        if self.card.tasks.is_empty() {
            mark_unread(&self.app, &team_id);
            return Ok(());
        }
        self.card_id = post(&self.app, &team_id, MessageBody::Plan(self.card.clone())).map(|m| m.id);
        let finish = self.execute(ticket, &mut signals).await;
        let finish = match finish {
            Finish::Done => self.conclude(ticket.cancel.clone()).await,
            Finish::Stopped => Finish::Stopped,
        };
        if let Finish::Stopped = finish {
            for task in &mut self.card.tasks {
                if !task.status.finished() {
                    task.status = TaskStatus::Skipped;
                    task.detail = "Stopped".into();
                }
            }
            post(&self.app, &team_id, MessageBody::System { text: "Stopped".into() });
        }
        self.card.state = match finish {
            Finish::Done => PlanState::Done,
            Finish::Stopped => PlanState::Stopped,
        };
        self.save_card();
        mark_unread(&self.app, &team_id);
        Ok(())
    }

    fn member(&self, member_id: &str) -> Option<&Bot> {
        self.members.iter().find(|m| m.id == member_id)
    }

    fn task(&mut self, task_id: &str) -> Option<&mut PlanTask> {
        self.card.tasks.iter_mut().find(|t| t.id == task_id)
    }

    fn number(&self, task_id: &str) -> usize {
        self.card.tasks.iter().position(|t| t.id == task_id).map_or(0, |i| i + 1)
    }

    fn node(&self, task_id: &str) -> Option<&FlowNode> {
        match self.card.mode {
            TeamMode::Flow => self.team.flow.nodes.iter().find(|n| n.id == task_id),
            TeamMode::Auto => None,
        }
    }

    /// The lead's system prompt for planning, reviews and the final reply.
    fn lead_prompt(&self) -> String {
        let mut s = format!(
            "You are {lead}, the orchestrator of \"{team}\", a team of AI agents the user built in Kbot, a desktop app. \
             The user talks to the team through you. You don't do the work yourself: you split requests into tasks \
             for the members, check their results and write the reply.\n\n",
            lead = self.lead.name,
            team = self.team.name,
        );
        if !self.team.purpose.trim().is_empty() {
            s += &format!("# What the team does\n\n{}\n\n", self.team.purpose.trim());
        }
        let instructions = match self.lead.config.instructions.trim() {
            "" => "Split each request into tasks, give each task to the best member, run independent tasks at the same time, check every result, and reply with one short summary.",
            instructions => instructions,
        };
        s += &format!("# Your instructions\n\n{instructions}\n\n# Members\n\n");
        if self.members.is_empty() {
            s += "The team has no members yet. Answer by yourself, and suggest adding members in Team settings when a request needs them.\n";
        }
        for member in &self.members {
            s += &format!("- {}: {}\n", member.name, role_of(member));
        }
        s += "\n# Style\n\n\
              - Reply in the language the user writes in.\n\
              - Replies appear in a plain-text chat bubble: write short paragraphs and simple lists, no Markdown headings or tables.\n";
        s
    }

    fn context(&self) -> String {
        let mut s = format!("Current local time: {}.\n\n", Local::now().format("%A %Y-%m-%d %H:%M"));
        if !self.history.is_empty() {
            s += &format!("Earlier in the team chat:\n\n{}\n\n", self.history);
        }
        s += &format!("The user's request:\n\n{}\n\n", self.request);
        s
    }

    /// Asks the lead for a plan; fills in the card's tasks and returns the
    /// lead's reply.
    async fn plan(&mut self, cancel: Arc<Notify>) -> Result<String, String> {
        let flow = self.card.mode == TeamMode::Flow && !self.team.flow.nodes.is_empty();
        if !flow {
            self.card.mode = TeamMode::Auto;
        }
        let mut prompt = self.context();
        let schema = if flow {
            prompt += "The team works through a fixed flow the user set up. Steps run in order; nodes in the same step run at the same time.\n\n";
            for node in &self.team.flow.nodes {
                let name = self.member(&node.member_id).map_or("", |m| m.name.as_str());
                prompt += &format!("- node \"{}\" · step {} · {name}: {}\n", node.id, node.step + 1, node.task.trim());
            }
            prompt += "\nFor each node, write the brief: exactly what the member does for this request and what to hand back. \
                       Members don't see the chat, so include everything they need. ";
            prompt += match self.team.flow.skip_unneeded {
                true => "Set \"skip\" for nodes this request doesn't need, but never change the order. If the request needs no work at all (a greeting, a question about an earlier result), skip every node and put your full answer in \"reply\". ",
                false => "Every node runs; set \"skip\" to false. ",
            };
            prompt += "Otherwise \"reply\" is one short line to the user about what the team will do.";
            flow_schema()
        } else {
            prompt += &format!(
                "Plan how the team handles it.\n\
                 - If you can answer without the members (a greeting, a question about the team or an earlier result), return no tasks and put your full answer in \"reply\".\n\
                 - Otherwise split the request into tasks, each for one member, named exactly as in the member list. \
                 \"brief\" tells the member exactly what to do and what to hand back; members don't see the chat, so include everything they need. \
                 \"after\" lists the ids of earlier tasks whose results the task needs; tasks that don't need each other run at the same time. \
                 Use as few tasks as the request needs, at most {MAX_TASKS}. \"reply\" is then one short line to the user about the plan."
            );
            plan_schema()
        };
        let value = agent::ask_json(&self.app, &self.lead, self.lead_prompt(), prompt, schema, cancel).await?;
        let (reply, tasks) = match flow {
            true => flow_tasks(&value, &self.team.flow, &self.members),
            false => auto_tasks(&value, &self.members),
        };
        let all_skipped = tasks.iter().all(|t| t.status == TaskStatus::Skipped);
        self.card.tasks = if all_skipped { Vec::new() } else { tasks };
        for task in &self.card.tasks {
            self.work.insert(task.id.clone(), Work::default());
        }
        Ok(reply)
    }

    async fn execute(&mut self, ticket: &Ticket, signals: &mut UnboundedReceiver<Signal>) -> Finish {
        let mut set: JoinSet<Event> = JoinSet::new();
        loop {
            if !self.stopping() && !self.paused {
                self.start_ready(&mut set);
            }
            self.save_card();
            if set.is_empty() {
                if self.stopping() {
                    return Finish::Stopped;
                }
                if self.card.tasks.iter().all(|t| t.status.finished()) {
                    return Finish::Done;
                }
                // Paused, or a failed task waits for the user.
            }
            let stopping = self.stopping();
            tokio::select! {
                Some(joined) = set.join_next(), if !set.is_empty() => match joined {
                    Ok(Event::Worked { task_id, outcome }) => self.worked(&mut set, &task_id, outcome),
                    Ok(Event::Reviewed { task_id, review }) => self.reviewed(&task_id, review),
                    Err(err) => eprintln!("team task failed: {err}"),
                },
                Some(signal) = signals.recv() => self.signal(signal),
                _ = ticket.cancel.notified(), if !stopping => self.halt(),
                else => return Finish::Stopped,
            }
        }
    }

    fn stopping(&self) -> bool {
        *self.stop.borrow()
    }

    fn halt(&mut self) {
        let _ = self.stop.send(true);
        self.paused = false;
    }

    /// Starts waiting tasks whose inputs are done, up to `MAX_PARALLEL`.
    fn start_ready(&mut self, set: &mut JoinSet<Event>) {
        let mut busy: Vec<String> = self
            .card
            .tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Working)
            .map(|t| t.member_id.clone())
            .collect();
        let ready: Vec<String> = self
            .card
            .tasks
            .iter()
            .filter(|t| t.status == TaskStatus::Waiting)
            .filter(|t| t.after.iter().all(|a| self.card.tasks.iter().any(|d| d.id == *a && d.status.finished())))
            .map(|t| t.id.clone())
            .collect();
        for task_id in ready {
            if busy.len() >= MAX_PARALLEL {
                break;
            }
            let Some(member_id) = self.card.tasks.iter().find(|t| t.id == task_id).map(|t| t.member_id.clone()) else {
                continue;
            };
            // A member works on one task at a time.
            if busy.contains(&member_id) {
                continue;
            }
            busy.push(member_id);
            self.start_work(set, &task_id, false);
        }
    }

    /// Starts the task's next turn; `step_in` = the same turn again with what
    /// the user wrote meanwhile, which doesn't count as a run or post a brief.
    fn start_work(&mut self, set: &mut JoinSet<Event>, task_id: &str, step_in: bool) {
        let work = self.work.entry(task_id.to_string()).or_default();
        if !step_in {
            work.attempt += 1;
        }
        let attempt = work.attempt;
        let notes = work.notes.clone();
        let prompt = self.member_prompt(task_id);
        let lead = self.lead.name.clone();
        let Some(task) = self.task(task_id) else { return };
        task.status = TaskStatus::Working;
        task.run = attempt;
        let brief = match attempt {
            _ if step_in => None,
            1 => Some(MessageBody::Brief { from: lead, to: task.member_name.clone(), text: task.brief.clone(), review: false }),
            _ => {
                let text = match notes.trim() {
                    "" => "Another pass, please: improve your last result.".to_string(),
                    notes => notes.to_string(),
                };
                Some(MessageBody::Brief { from: lead, to: task.member_name.clone(), text, review: true })
            }
        };
        let member_id = task.member_id.clone();
        let (app, task_id, stop) = (self.app.clone(), task_id.to_string(), self.stop.subscribe());
        set.spawn(async move {
            let outcome = run_task(app, member_id, brief, prompt, stop).await;
            Event::Worked { task_id, outcome }
        });
    }

    /// What a member is sent for a task: its brief plus what it needs from
    /// the rest of the team.
    fn member_prompt(&self, task_id: &str) -> String {
        let Some(task) = self.card.tasks.iter().find(|t| t.id == task_id) else { return String::new() };
        let empty = Work::default();
        let work = self.work.get(task_id).unwrap_or(&empty);
        let lead = &self.lead.name;
        let mut s = format!(
            "{lead}, the orchestrator of your team \"{team}\", gives you a task.\n\n\
             The user asked the team:\n\n{request}\n\n\
             Your task: {title}\n\n{brief}\n\n",
            team = self.team.name,
            request = self.request.trim(),
            title = task.title,
            brief = task.brief.trim(),
        );
        let everything = self.node(task_id).is_some_and(|n| n.gets == FlowInput::Everything);
        let inputs: Vec<&PlanTask> = self
            .card
            .tasks
            .iter()
            .filter(|t| t.id != task.id && t.status == TaskStatus::Done)
            .filter(|t| everything || task.after.contains(&t.id))
            .collect();
        if !inputs.is_empty() {
            s += "Results from your teammates:\n\n";
            for input in inputs {
                let result = self.work.get(&input.id).map_or("", |w| w.result.as_str());
                s += &format!("## {} · {}\n\n{}\n\n", input.member_name, input.title, truncate(result, RESULT_LIMIT));
            }
        }
        if !work.result.is_empty() {
            s += &format!("Your previous result:\n\n{}\n\n", truncate(&work.result, RESULT_LIMIT));
            if work.step_ins.is_empty() {
                s += &match work.notes.trim() {
                    "" => format!("{lead} asks for another pass: improve it.\n\n"),
                    notes => format!("{lead}'s notes on it:\n\n{notes}\n\n"),
                };
            }
        }
        if !work.step_ins.is_empty() {
            s += "While you worked, the user wrote to you:\n\n";
            for text in &work.step_ins {
                s += &format!("- {}\n", text.trim());
            }
            s += "\nTake it into account and hand back your updated result.\n\n";
        }
        s += &format!(
            "Do the task and reply with your result; it goes to {lead}, who reviews it and answers the user. \
             Don't ask questions back: if something is missing, make a reasonable assumption and say so."
        );
        s
    }

    fn worked(&mut self, set: &mut JoinSet<Event>, task_id: &str, outcome: Outcome) {
        let stopping = self.stopping();
        let Some(task) = self.task(task_id) else { return };
        if stopping {
            task.status = TaskStatus::Skipped;
            task.detail = "Stopped".into();
            return;
        }
        let member = task.member_name.clone();
        if outcome.stopped || outcome.failed || outcome.text.trim().is_empty() {
            let reason = match (outcome.stopped, outcome.failed) {
                (true, _) => "was stopped",
                (_, true) => "ran into an error",
                _ => "didn't reply",
            };
            self.fail(task_id, format!("{member} {reason}"));
            return;
        }
        let work = self.work.entry(task_id.to_string()).or_default();
        work.result = outcome.text;
        // The user wrote to the member while it worked: one more turn with that.
        if !work.step_ins.is_empty() {
            self.start_work(set, task_id, true);
            if let Some(work) = self.work.get_mut(task_id) {
                work.step_ins.clear();
            }
            return;
        }
        self.start_review(set, task_id);
    }

    fn start_review(&mut self, set: &mut JoinSet<Event>, task_id: &str) {
        let lead_name = self.lead.name.clone();
        let Some(task) = self.card.tasks.iter().find(|t| t.id == task_id).cloned() else { return };
        let work = self.work.get(task_id);
        let result = work.map_or("", |w| w.result.as_str());
        let attempt = work.map_or(1, |w| w.attempt);
        let mut prompt = self.context();
        prompt += &format!(
            "You gave {member} this task: {title}\n\n{brief}\n\n{member}'s result (turn {attempt}):\n\n{result}\n\n\
             Review it. \"accept\" if it does the task well enough to use; \"revise\" to send it back, with \"notes\" telling {member} \
             exactly what to fix (written to {member}). \"summary\" is a few words for the plan card on what came back, \
             e.g. \"20 leads, 3 swapped after review\".",
            member = task.member_name,
            title = task.title,
            brief = task.brief.trim(),
            result = truncate(result, RESULT_LIMIT),
        );
        if let Some(task) = self.task(task_id) {
            task.status = TaskStatus::Review;
            task.detail = format!("{lead_name} is checking the result");
        }
        let (app, lead, system, task_id, mut stop) =
            (self.app.clone(), self.lead.clone(), self.lead_prompt(), task_id.to_string(), self.stop.subscribe());
        set.spawn(async move {
            let cancel = Arc::new(Notify::new());
            let review = tokio::select! {
                value = agent::ask_json(&app, &lead, system, prompt, review_schema(), cancel) => value.map(parse_review),
                _ = stopped(&mut stop) => Err(STOPPED.to_string()),
            };
            Event::Reviewed { task_id, review }
        });
    }

    fn reviewed(&mut self, task_id: &str, review: Result<Review, String>) {
        if self.stopping() {
            if let Some(task) = self.task(task_id) {
                task.status = TaskStatus::Skipped;
                task.detail = "Stopped".into();
            }
            return;
        }
        let result = self.work.get(task_id).map(|w| w.result.clone()).unwrap_or_default();
        // The review itself failed: take the result as it is.
        let review = review.unwrap_or_else(|err| {
            eprintln!("team review failed: {err}");
            Review { accept: true, notes: String::new(), summary: first_line(&result) }
        });
        let attempt = self.work.get(task_id).map_or(1, |w| w.attempt);
        let again = match self.node(task_id) {
            Some(node) if node.runs > 1 => attempt < node.runs && !(review.accept && node.stop_early),
            _ => !review.accept && attempt <= MAX_REVISIONS,
        };
        let lead = self.lead.name.clone();
        let number = self.number(task_id);
        let Some(task) = self.task(task_id) else { return };
        let (member_id, member) = (task.member_id.clone(), task.member_name.clone());
        if again {
            task.status = TaskStatus::Waiting;
            task.detail = match review.notes.trim() {
                "" => format!("Run {} of {} next", attempt + 1, task.runs),
                notes => format!("Sent back: {}", first_line(notes)),
            };
            if let Some(work) = self.work.get_mut(task_id) {
                work.notes = review.notes.clone();
            }
            if !review.accept {
                let text = match review.notes.trim() {
                    "" => format!("{lead} sent {member}'s result back."),
                    notes => format!("{lead} sent {member}'s result back: {}", truncate(notes, 300)),
                };
                post(&self.app, &self.team.id, MessageBody::System { text });
            }
            return;
        }
        task.status = TaskStatus::Done;
        task.detail = match review.summary.trim() {
            "" => first_line(&result),
            summary => summary.to_string(),
        };
        agent::post(&self.app, &member_id, MessageBody::System { text: format!("{lead} accepted the result · task {number} done") });
    }

    /// A member couldn't finish: what happens next is the flow node's
    /// "If it fails", or asking the user in an orchestrator-made plan.
    fn fail(&mut self, task_id: &str, reason: String) {
        let on_fail = self.node(task_id).map_or(OnFail::Ask, |n| n.on_fail);
        let Some(task) = self.task(task_id) else { return };
        match on_fail {
            OnFail::Stop => {
                task.status = TaskStatus::Failed;
                task.detail = reason.clone();
                post(&self.app, &self.team.id, MessageBody::System { text: format!("{reason}, so the team stopped.") });
                self.halt();
            }
            OnFail::Skip => {
                task.status = TaskStatus::Failed;
                task.detail = format!("{reason} · skipped");
            }
            OnFail::Ask => {
                task.status = TaskStatus::Blocked;
                task.detail = format!("{reason}. Retry, skip or stop?");
                mark_unread(&self.app, &self.team.id);
            }
        }
    }

    fn signal(&mut self, signal: Signal) {
        match signal {
            Signal::Pause(paused) => self.paused = paused && !self.stopping(),
            Signal::Edit(edits) => self.edit(edits),
            Signal::Answer { task_id, action } => {
                let Some(task) = self.task(&task_id) else { return };
                if task.status != TaskStatus::Blocked {
                    return;
                }
                match action {
                    TaskAction::Retry => {
                        task.status = TaskStatus::Waiting;
                        task.detail.clear();
                        if let Some(work) = self.work.get_mut(&task_id) {
                            work.attempt = 0;
                            work.notes.clear();
                        }
                    }
                    TaskAction::Skip => {
                        task.status = TaskStatus::Skipped;
                        task.detail = "Skipped".into();
                    }
                    TaskAction::Stop => self.halt(),
                }
            }
            Signal::StepIn { member_id, text } => {
                let task_id = self
                    .card
                    .tasks
                    .iter()
                    .find(|t| t.member_id == member_id && t.status == TaskStatus::Working)
                    .map(|t| t.id.clone());
                if let Some(work) = task_id.and_then(|id| self.work.get_mut(&id)) {
                    work.step_ins.push(text);
                }
            }
        }
    }

    /// "Edit plan": only tasks that haven't started change.
    fn edit(&mut self, edits: Vec<PlanEdit>) {
        for edit in edits {
            let untouched = self.work.get(&edit.task_id).is_none_or(|w| w.attempt == 0);
            let waiting = self.card.tasks.iter().any(|t| t.id == edit.task_id && t.status == TaskStatus::Waiting);
            if !untouched || !waiting {
                continue;
            }
            if edit.remove {
                self.card.tasks.retain(|t| t.id != edit.task_id);
                for task in &mut self.card.tasks {
                    task.after.retain(|a| *a != edit.task_id);
                }
                self.work.remove(&edit.task_id);
                continue;
            }
            let member = self.member(&edit.member_id).map(|m| (m.id.clone(), m.name.clone()));
            let Some(task) = self.task(&edit.task_id) else { continue };
            if !edit.title.trim().is_empty() {
                task.title = truncate(&edit.title, 80);
            }
            if !edit.brief.trim().is_empty() {
                task.brief = edit.brief.trim().to_string();
            }
            if let Some((id, name)) = member {
                task.member_id = id;
                task.member_name = name;
            }
        }
    }

    /// Fills in what the card says about tasks waiting to start.
    fn describe_waiting(&mut self) {
        let numbers: HashMap<String, usize> =
            self.card.tasks.iter().enumerate().map(|(i, t)| (t.id.clone(), i + 1)).collect();
        let finished: HashMap<String, bool> =
            self.card.tasks.iter().map(|t| (t.id.clone(), t.status.finished())).collect();
        let paused = self.paused;
        for task in &mut self.card.tasks {
            let started = self.work.get(&task.id).is_some_and(|w| w.attempt > 0);
            if task.status != TaskStatus::Waiting || started {
                if task.status == TaskStatus::Working {
                    task.detail = match (task.runs, task.run) {
                        (runs, run) if runs > 1 => format!("Run {run} of {runs}"),
                        (_, run) if run > 1 => "Revising".into(),
                        _ => "Working on it".into(),
                    };
                }
                continue;
            }
            let pending: Vec<usize> =
                task.after.iter().filter(|a| !finished.get(*a).copied().unwrap_or(true)).filter_map(|a| numbers.get(a).copied()).collect();
            task.detail = match pending.as_slice() {
                [] if paused => "Paused".into(),
                [] => "Up next".into(),
                [n] => format!("Starts after task {n}"),
                many => format!(
                    "Starts after tasks {}",
                    many.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(", ")
                ),
            };
        }
    }

    fn activity(&self) -> TeamActivity {
        let mut activity = TeamActivity::default();
        // The busiest state wins for a member with several tasks.
        let rank = |s: TaskStatus| match s {
            TaskStatus::Working => 6,
            TaskStatus::Review => 5,
            TaskStatus::Blocked => 4,
            TaskStatus::Waiting => 3,
            TaskStatus::Done => 2,
            TaskStatus::Failed => 1,
            TaskStatus::Skipped => 0,
        };
        for task in &self.card.tasks {
            let entry = activity.statuses.entry(task.member_id.clone()).or_insert(task.status);
            if rank(task.status) > rank(*entry) {
                *entry = task.status;
            }
        }
        let total = self.card.tasks.len();
        let done = self.card.tasks.iter().filter(|t| t.status.finished()).count();
        let working = self.card.tasks.iter().filter(|t| t.status == TaskStatus::Working).count();
        activity.summary = match (self.card.state, working) {
            (PlanState::Paused, _) => format!("Paused · {done} of {total} done"),
            (_, 0) => format!("{done} of {total} done"),
            (_, n) => format!("{n} working · {done} of {total} done"),
        };
        if self.card.tasks.iter().any(|t| t.status == TaskStatus::Blocked) {
            activity.summary = format!("Needs you · {}", activity.summary);
        }
        activity
    }

    /// Saves the card and tells the UI, with the team's activity.
    fn save_card(&mut self) {
        if self.card.state == PlanState::Running || self.card.state == PlanState::Paused {
            self.card.state = if self.paused { PlanState::Paused } else { PlanState::Running };
        }
        self.describe_waiting();
        let state = self.app.state::<AppState>();
        state.teams.set_activity(&self.team.id, self.activity());
        if let Some(card_id) = &self.card_id {
            let card = self.card.clone();
            let saved = state.store.lock().unwrap().update_message(&self.team.id, card_id, |m| m.body = MessageBody::Plan(card));
            match saved {
                Ok(message) => events::message_only(&self.app, &self.team.id, message),
                Err(err) => eprintln!("saving plan card failed: {err}"),
            }
        }
        events::teams_changed(&self.app);
    }

    /// Has the lead pull the results together into one reply.
    async fn conclude(&mut self, cancel: Arc<Notify>) -> Finish {
        let lead = self.lead.name.clone();
        let mut prompt = self.context();
        prompt += "Your team's results:\n\n";
        for (i, task) in self.card.tasks.iter().enumerate() {
            let state = match task.status {
                TaskStatus::Done => "done",
                TaskStatus::Skipped => "skipped",
                _ => "failed",
            };
            let result = self.work.get(&task.id).map_or("", |w| w.result.as_str());
            prompt += &format!("## Task {} · {} ({}, {state})\n\n", i + 1, task.title, task.member_name);
            if task.status == TaskStatus::Done {
                prompt += &format!("{}\n\n", truncate(result, RESULT_LIMIT));
            } else if !task.detail.is_empty() {
                prompt += &format!("{}\n\n", task.detail);
            }
        }
        prompt += "Write your reply to the user: one answer that pulls the results together, \
                   and say what failed or was skipped, if anything.";
        match agent::ask_json(&self.app, &self.lead, self.lead_prompt(), prompt, reply_schema(), cancel).await {
            Ok(value) => {
                let reply = str_of(&value, "reply");
                let text = match reply {
                    "" => format!("{lead}: the team is done."),
                    reply => reply.to_string(),
                };
                post(&self.app, &self.team.id, MessageBody::Agent { text });
                Finish::Done
            }
            Err(err) if err == STOPPED => Finish::Stopped,
            Err(err) => {
                post(&self.app, &self.team.id, MessageBody::System { text: format!("{lead} couldn't write the reply: {err}") });
                Finish::Done
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentConfig, Avatar, BotImage, SetupState};

    fn bot(id: &str, name: &str) -> Bot {
        Bot {
            id: id.into(),
            name: name.into(),
            avatar: Avatar::Image { image: BotImage::Bot01 },
            pinned: false,
            updated_at: 0,
            preview: String::new(),
            setup_state: SetupState::Done,
            config: AgentConfig::default(),
            last_run_at: None,
            editing: false,
            unread: false,
            tags: Vec::new(),
            team_id: Some("team".into()),
            team_role: String::new(),
        }
    }

    #[test]
    fn auto_plan_maps_members_and_dependencies() {
        let members = vec![bot("a", "Researcher"), bot("b", "Sales Outbound")];
        let value = json!({
            "reply": "On it.",
            "tasks": [
                { "id": "r", "member": "researcher", "title": "Research", "brief": "Look up Acme", "after": [] },
                { "id": "x", "member": "Nobody", "title": "Lost", "brief": "Dropped", "after": [] },
                { "id": "d", "member": "@Sales Outbound", "title": "", "brief": "Draft follow-ups\nmore", "after": ["r", "d", "x", "later"] },
                { "id": "later", "member": "Researcher", "title": "Check", "brief": "Check", "after": [] }
            ]
        });
        let (reply, tasks) = auto_tasks(&value, &members);
        assert_eq!(reply, "On it.");
        assert_eq!(tasks.len(), 3);
        assert_eq!(tasks[0].member_id, "a");
        assert_eq!(tasks[1].id, "t2");
        assert_eq!(tasks[1].member_id, "b");
        assert_eq!(tasks[1].title, "Draft follow-ups");
        // Only earlier, known tasks.
        assert_eq!(tasks[1].after, vec!["t1".to_string()]);
    }

    #[test]
    fn flow_plan_follows_the_flow() {
        let members = vec![bot("a", "Researcher"), bot("b", "Writer")];
        let flow = Flow {
            nodes: vec![
                FlowNode { id: "n1".into(), member_id: "a".into(), step: 0, task: "Research".into(), ..FlowNode::default() },
                FlowNode { id: "n2".into(), member_id: "b".into(), step: 1, task: "Write".into(), runs: 2, ..FlowNode::default() },
            ],
            skip_unneeded: false,
        };
        let value = json!({ "reply": "", "briefs": [{ "node": "n2", "brief": "Write about Acme", "skip": true }] });
        let (_, tasks) = flow_tasks(&value, &flow, &members);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].brief, "Research");
        assert_eq!(tasks[1].brief, "Write about Acme");
        assert_eq!(tasks[1].after, vec!["n1".to_string()]);
        assert_eq!(tasks[1].runs, 2);
        // Skipping isn't allowed in this flow.
        assert_eq!(tasks[1].status, TaskStatus::Waiting);

        let flow = Flow { skip_unneeded: true, ..flow };
        let (_, tasks) = flow_tasks(&value, &flow, &members);
        assert_eq!(tasks[1].status, TaskStatus::Skipped);
    }

    #[test]
    fn strips_a_leading_mention() {
        assert_eq!(strip_mention("@researcher, look up Acme", "Researcher"), "look up Acme");
        assert_eq!(strip_mention("@Sales Outbound draft it", "Sales Outbound"), "draft it");
        assert_eq!(strip_mention("hello @Researcher", "Researcher"), "hello @Researcher");
        assert_eq!(strip_mention("@Researcher", "Researcher"), "@Researcher");
    }

    #[test]
    fn history_skips_the_request_and_cards() {
        let messages = vec![
            Message::new(MessageBody::User { text: "first".into() }),
            Message::new(MessageBody::Agent { text: "answer".into() }),
            Message::new(MessageBody::System { text: "note".into() }),
            Message::new(MessageBody::User { text: "now".into() }),
        ];
        assert_eq!(history(&messages, "Lead"), "User: first\n\nLead: answer");
    }
}
