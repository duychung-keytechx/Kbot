//! Data types shared with the React UI. Everything is serialized camelCase;
//! the TypeScript mirror lives in `src/lib/types.ts`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The 15 robot glyphs (in `src/components/avatars/botIcons.ts`). No longer
/// offered when creating a bot, but still rendered for bots that have one.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BotIcon {
    Classic,
    Happy,
    Love,
    Angry,
    Buddy,
    Round,
    Sleepy,
    Boxy,
    Helper,
    Block,
    Cyclops,
    Bust,
    Bubble,
    Tall,
    Chatty,
}

/// The 20 bot pictures offered in the "Create New Bot" dialog
/// (`src/assets/bots/<id>.png`, from Flaticon; see THIRD_PARTY_NOTICES.md).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BotImage {
    Bot01,
    Bot02,
    Bot03,
    Bot04,
    Bot05,
    Bot06,
    Bot07,
    Bot08,
    Bot09,
    Bot10,
    Bot11,
    Bot12,
    Bot13,
    Bot14,
    Bot15,
    Bot16,
    Bot17,
    Bot18,
    Bot19,
    Bot20,
}

/// The mock's 15 bot shapes. No longer offered when creating a bot, but
/// still rendered for bots that were created with one.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BotShape {
    Circle,
    Cloud,
    Squircle,
    Tilted,
    Diamond,
    Flower,
    Egg,
    Pill,
    Triangle,
    Hexagon,
    Heart,
    Ghost,
    Burst,
    Shield,
    Cross,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Avatar {
    /// A full-color bot picture.
    Image { image: BotImage },
    /// A robot glyph drawn in one of the palette colors (older bots).
    Icon { icon: BotIcon, color: String },
    /// A shape filled with one of the palette colors (older bots).
    Shape { shape: BotShape, color: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub avatar: Avatar,
    #[serde(default)]
    pub pinned: bool,
    /// Unix epoch milliseconds of the last activity.
    pub updated_at: i64,
    /// One-line summary shown under the name in the sidebar.
    pub preview: String,
    pub setup_state: SetupState,
    pub config: AgentConfig,
    /// Unix epoch milliseconds of the last scheduled job run.
    pub last_run_at: Option<i64>,
    /// A set-up bot is being changed with `/setup` (see `setup::Step::Edit`).
    #[serde(default)]
    pub editing: bool,
    /// A scheduled job posted a result or question the user hasn't seen.
    #[serde(default)]
    pub unread: bool,
    /// Ids of the bot's tags, in the order they were added.
    #[serde(default)]
    pub tags: Vec<String>,
    /// The team the bot is in, as its orchestrator (`Team::lead_id`) or a member.
    #[serde(default)]
    pub team_id: Option<String>,
    /// What the bot does in its team; the orchestrator routes tasks by it.
    #[serde(default)]
    pub team_role: String,
}

/// A label for grouping bots, shared by all of them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    /// One of `Tag::COLORS`.
    pub color: String,
}

impl Tag {
    /// The swatches in a tag's "Color" menu, in order (mirrored in `src/lib/types.ts`).
    pub const COLORS: [&str; 11] = [
        "#141414", "#9A5B34", "#F0263E", "#FF5A1F", "#F7931E", "#16B364", "#12A89A", "#1A73F0", "#7C3AED", "#EC2D8C",
        "#8E8E8E",
    ];
    /// Longest name the UI lets you type.
    pub const MAX_NAME: usize = 30;

    /// A name as typed, trimmed; an error if it's empty or too long.
    pub fn clean_name(name: &str) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Tag name is required".into());
        }
        if name.chars().count() > Self::MAX_NAME {
            return Err(format!("Tag name can be at most {} characters", Self::MAX_NAME));
        }
        Ok(name.to_string())
    }

    pub fn check_color(color: &str) -> Result<(), String> {
        match Self::COLORS.contains(&color) {
            true => Ok(()),
            false => Err(format!("unknown tag color {color}")),
        }
    }
}

/// An orchestrator (the lead) and the member bots it gives tasks to. Talking
/// to the team is talking to the lead; the team chat is stored under the
/// team's id (see `teams::run`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    /// "What does this team do?"
    pub purpose: String,
    /// One of `Tag::COLORS`; tints the team avatar and the orchestrator's crown.
    pub color: String,
    /// The orchestrator, a bot whose `team_id` is this team.
    pub lead_id: String,
    pub mode: TeamMode,
    /// The run order when `mode` is `Flow`.
    pub flow: Flow,
    /// Shown as one row in the sidebar.
    pub collapsed: bool,
    pub updated_at: i64,
    /// Last line of the team chat.
    pub preview: String,
    /// The orchestrator replied while the team chat wasn't on screen.
    pub unread: bool,
    /// Member ids in order, not counting the orchestrator.
    pub members: Vec<String>,
    /// What the team is doing right now; `None` when no request is running.
    /// Not stored: filled in from `teams::Teams`.
    #[serde(default)]
    pub activity: Option<TeamActivity>,
}

impl Team {
    pub const MAX_NAME: usize = 60;

    pub fn clean_name(name: &str) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Team name is required".into());
        }
        if name.chars().count() > Self::MAX_NAME {
            return Err(format!("Team name can be at most {} characters", Self::MAX_NAME));
        }
        Ok(name.to_string())
    }
}

/// How the orchestrator runs a request.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TeamMode {
    /// "Let it decide": the orchestrator plans the tasks for each request.
    #[default]
    Auto,
    /// "Custom flow": members run in the order of `Team::flow`.
    Flow,
}

/// A custom run order: steps run one after another, members in the same
/// step at the same time.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Flow {
    pub nodes: Vec<FlowNode>,
    /// The orchestrator may leave out members a request doesn't need, but
    /// never changes the order.
    pub skip_unneeded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct FlowNode {
    pub id: String,
    pub member_id: String,
    /// The step (column) it's in, from 0.
    pub step: u32,
    /// Nodes it waits for; empty = every node of the step before.
    pub after: Vec<String>,
    /// What the member does here; the orchestrator writes the brief from it.
    pub task: String,
    /// How many times it runs; each run gets its last result and the lead's notes.
    pub runs: u32,
    /// Stop repeating once the orchestrator accepts a result.
    pub stop_early: bool,
    pub gets: FlowInput,
    pub on_fail: OnFail,
}

impl Default for FlowNode {
    fn default() -> Self {
        Self {
            id: String::new(),
            member_id: String::new(),
            step: 0,
            after: Vec::new(),
            task: String::new(),
            runs: 1,
            stop_early: true,
            gets: FlowInput::Results,
            on_fail: OnFail::Ask,
        }
    }
}

/// What a flow node gets besides its brief.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FlowInput {
    /// The results of the nodes it waits for.
    #[default]
    Results,
    /// Every result so far.
    Everything,
}

/// What happens when a member can't finish its task.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OnFail {
    /// Stop the whole run.
    Stop,
    /// Go on without it.
    Skip,
    /// Wait for the user to retry, skip or stop.
    #[default]
    Ask,
}

impl Flow {
    pub const MAX_RUNS: u32 = 5;

    /// Renumbers steps from 0 without gaps, drops nodes of unknown members
    /// and waits that don't point at an earlier step, and clamps runs.
    pub fn normalized(mut self, members: &[String]) -> Flow {
        self.nodes.retain(|n| members.contains(&n.member_id) && !n.id.is_empty());
        let mut steps: Vec<u32> = self.nodes.iter().map(|n| n.step).collect();
        steps.sort_unstable();
        steps.dedup();
        for node in &mut self.nodes {
            node.step = steps.iter().position(|s| *s == node.step).unwrap_or(0) as u32;
            node.runs = node.runs.clamp(1, Self::MAX_RUNS);
        }
        let step_of: BTreeMap<String, u32> = self.nodes.iter().map(|n| (n.id.clone(), n.step)).collect();
        for node in &mut self.nodes {
            let step = node.step;
            node.after.retain(|id| step_of.get(id).is_some_and(|s| *s < step));
            node.after.dedup();
        }
        self.nodes.sort_by_key(|n| n.step);
        self
    }

    /// The nodes `node` waits for: its own `after`, or every node of the
    /// nearest earlier step.
    pub fn waits_for(&self, node: &FlowNode) -> Vec<String> {
        if !node.after.is_empty() {
            return node.after.clone();
        }
        let before = self.nodes.iter().filter(|n| n.step < node.step).map(|n| n.step).max();
        match before {
            Some(step) => self.nodes.iter().filter(|n| n.step == step).map(|n| n.id.clone()).collect(),
            None => Vec::new(),
        }
    }
}

/// Live state of a team while it works on a request (see `Team::activity`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamActivity {
    /// What each member is doing, by member id.
    pub statuses: BTreeMap<String, TaskStatus>,
    /// "1 working · 1 of 3 done", for the collapsed sidebar row.
    pub summary: String,
}

/// One task of a plan, as the Plan card shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanTask {
    pub id: String,
    pub title: String,
    pub member_id: String,
    pub member_name: String,
    pub brief: String,
    /// Tasks that must finish first.
    pub after: Vec<String>,
    /// The flow step it belongs to; `None` in a plan the orchestrator made.
    #[serde(default)]
    pub step: Option<u32>,
    pub status: TaskStatus,
    /// "Starts after task 2", "20 leads · 3 swapped after review".
    pub detail: String,
    /// Planned runs (flow) and the current one.
    pub runs: u32,
    pub run: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Waiting,
    Working,
    /// The orchestrator is checking the result.
    Review,
    Done,
    Skipped,
    Failed,
    /// Failed, and waiting for the user to retry, skip or stop.
    Blocked,
}

impl TaskStatus {
    /// Done, skipped or failed: tasks after it may start.
    pub fn finished(self) -> bool {
        matches!(self, TaskStatus::Done | TaskStatus::Skipped | TaskStatus::Failed)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlanState {
    Running,
    Paused,
    Done,
    Stopped,
}

/// The Plan card in a team chat, updated in place as tasks run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanCard {
    pub mode: TeamMode,
    pub state: PlanState,
    pub tasks: Vec<PlanTask>,
}

/// A change to a waiting task from "Edit plan".
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEdit {
    pub task_id: String,
    pub title: String,
    pub brief: String,
    pub member_id: String,
    #[serde(default)]
    pub remove: bool,
}

/// The user's answer when a task failed and its card asks what to do.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskAction {
    Retry,
    Skip,
    Stop,
}

/// Whether the onboarding chat has configured this bot yet.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SetupState {
    #[default]
    Pending,
    Done,
    Skipped,
}

/// Everything the agent runs with. Stored as JSON in `bots.config`, so new
/// fields only need a `#[serde(default)]`, not a migration.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentConfig {
    /// What the user typed during setup.
    pub description: String,
    /// Claude's rewrite of `description`; the agent's system prompt. User-editable.
    pub instructions: String,
    /// `None` = chat agent; `Some` = also runs a job by itself: daily, on an interval or on a date.
    pub schedule: Option<Schedule>,
    /// Folders the agent may read.
    pub workspace_folders: Vec<String>,
    pub web_access: bool,
    /// Claude Code `--model` value (e.g. "sonnet"); `None` = `AppSettings::default_model`.
    pub model: Option<String>,
    /// Codex `--model` value; `None` = `AppSettings::codex_model`.
    pub codex_model: Option<String>,
}

/// Claude Code `--model` for bots that don't pick their own.
pub const DEFAULT_MODEL: &str = "claude-sonnet-5-5";

/// The coding agent CLI that bots run on.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Claude,
    Codex,
}

impl Provider {
    /// The model's name in chat messages ("Claude couldn't finish").
    pub fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
        }
    }

    /// The CLI's name in chat messages ("Claude Code stopped unexpectedly").
    pub fn cli(self) -> &'static str {
        match self {
            Provider::Claude => "Claude Code",
            Provider::Codex => "Codex",
        }
    }
}

/// How long the model thinks before acting: Claude Code `--effort`, Codex `model_reasoning_effort`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    #[default]
    Medium,
    High,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Light,
    Dark,
}

/// App-wide preferences, edited in Kbot > Settings…. Stored as rows of `app_settings`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub provider: Provider,
    /// Claude Code `--model` for bots whose `AgentConfig::model` is `None`.
    pub default_model: String,
    /// Codex `--model` for bots whose `AgentConfig::codex_model` is `None`;
    /// `None` = the model in the user's Codex config.
    pub codex_model: Option<String>,
    pub effort: Effort,
    pub theme: Theme,
}

impl AppSettings {
    /// The model a bot runs with on the current provider: its own, else the
    /// default; `None` lets Codex use its configured model.
    pub fn model_for(&self, config: &AgentConfig) -> Option<String> {
        match self.provider {
            Provider::Claude => Some(config.model.clone().unwrap_or_else(|| self.default_model.clone())),
            Provider::Codex => config.codex_model.clone().or_else(|| self.codex_model.clone()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Schedule {
    /// Local time, "HH:MM", of a daily job or a task on a date. Unused on an interval.
    pub time: String,
    /// The days it runs, daily or on an interval. Unused on a date.
    pub days: Vec<Weekday>,
    /// `None` = once a day at `time`, or on `date`; `Some(n)` = every `n` minutes.
    pub every_minutes: Option<u32>,
    /// "YYYY-MM-DD": a task that runs on this date at `time` instead of daily.
    pub date: Option<String>,
    /// A task on a date repeats every month on that day of the month.
    pub monthly: bool,
    /// What to do on each run.
    pub task: String,
    /// Show an OS notification when the run finishes.
    pub notify: bool,
}

impl Bot {
    /// Longest name the UI lets you type (`maxLength` of the name fields).
    pub const MAX_NAME: usize = 60;

    /// A name as typed, trimmed; an error if it's empty or too long.
    pub fn clean_name(name: &str) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Bot name is required".into());
        }
        if name.chars().count() > Self::MAX_NAME {
            return Err(format!("Bot name can be at most {} characters", Self::MAX_NAME));
        }
        Ok(name.to_string())
    }
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            time: "08:00".into(),
            days: Weekday::ALL.to_vec(),
            every_minutes: None,
            date: None,
            monthly: false,
            task: String::new(),
            notify: true,
        }
    }
}

impl Schedule {
    /// Shortest and longest interval, in minutes.
    pub const MIN_EVERY: u32 = 5;
    pub const MAX_EVERY: u32 = 24 * 60;
    /// Interval a new interval job starts with.
    pub const DEFAULT_EVERY: u32 = 30;

    /// A new interval job. Not notifying: a notification every few minutes is noise.
    pub fn interval() -> Self {
        Self { every_minutes: Some(Self::DEFAULT_EVERY), notify: false, ..Self::default() }
    }

    /// A new task on `date`, at the default time.
    pub fn on_date(date: chrono::NaiveDate) -> Self {
        Self { date: Some(date.format("%Y-%m-%d").to_string()), ..Self::default() }
    }

    /// `date`, if it's a task on a date.
    pub fn parsed_date(&self) -> Option<chrono::NaiveDate> {
        chrono::NaiveDate::parse_from_str(self.date.as_deref()?, "%Y-%m-%d").ok()
    }

    /// Checks `every_minutes`, or `time` for a daily job or a task on a date,
    /// and `days`, or `date` for a task on a date.
    pub fn validate(&self) -> Result<(), String> {
        match self.every_minutes {
            Some(n) if !(Self::MIN_EVERY..=Self::MAX_EVERY).contains(&n) => {
                return Err(format!("Pick an interval from {} minutes to 24 hours", Self::MIN_EVERY));
            }
            Some(_) if self.date.is_some() => return Err("An interval job can't also run on a date".into()),
            Some(_) => {}
            None if !crate::setup::valid_time(&self.time) => return Err(format!("{} is not a valid time", self.time)),
            None => {}
        }
        match &self.date {
            Some(date) if self.parsed_date().is_none() => Err(format!("{date} is not a valid date")),
            Some(_) => Ok(()),
            None if self.days.is_empty() => Err("Pick at least one day".into()),
            None => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Weekday {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Weekday {
    pub const ALL: [Weekday; 7] = [
        Weekday::Mon,
        Weekday::Tue,
        Weekday::Wed,
        Weekday::Thu,
        Weekday::Fri,
        Weekday::Sat,
        Weekday::Sun,
    ];
}

impl From<chrono::Weekday> for Weekday {
    fn from(day: chrono::Weekday) -> Self {
        Weekday::ALL[day.num_days_from_monday() as usize]
    }
}

/// Who is driving the computer shown in a Computer card.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Control {
    User,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MessageBody {
    User { text: String },
    Agent { text: String },
    System { text: String },
    Computer { prompt: String, control: Control },
    /// Onboarding question answered with one of a few buttons.
    SetupChoice { step: String, question: String, options: Vec<String>, selected: Option<String> },
    /// Onboarding: when a job runs; `every_minutes` set for an interval job,
    /// `date` for a task on a date.
    SetupSchedule {
        time: String,
        days: Vec<Weekday>,
        // Variant fields aren't renamed by `rename_all`; the UI reads camelCase.
        #[serde(default, rename = "everyMinutes")]
        every_minutes: Option<u32>,
        #[serde(default)]
        date: Option<String>,
        #[serde(default)]
        monthly: bool,
        notify: bool,
        submitted: bool,
    },
    /// Onboarding: folders the agent may read.
    SetupFolders { folders: Vec<String>, submitted: bool },
    /// Onboarding: the final config for the user to confirm or edit. With
    /// `previous`, a change made with `/setup`, shown against the saved config.
    SetupReview {
        config: AgentConfig,
        confirmed: bool,
        #[serde(default)]
        previous: Option<AgentConfig>,
        /// The new name, when a `/setup` change renames the bot.
        #[serde(default)]
        name: Option<String>,
        /// Replaced by a newer change, or `/setup` was closed without saving.
        #[serde(default)]
        discarded: bool,
    },
    /// `/setup` on a set-up bot: its current config and how to change it.
    SetupCurrent { config: AgentConfig },
    /// Claude Code asks before using a tool, or asks the user something with
    /// `AskUserQuestion` (`questions`). Answered with `answer_permission`.
    Permission {
        request_id: String,
        tool: String,
        /// What the tool is for, e.g. a Bash command's description.
        summary: String,
        /// The command, file or URL, or the whole input as JSON.
        detail: String,
        /// The tool input, sent back as is when approved.
        input: Value,
        #[serde(default)]
        questions: Vec<Question>,
        status: PermissionStatus,
        /// Picked option labels by question (comma-separated if several).
        #[serde(default)]
        answers: BTreeMap<String, String>,
    },
    /// In a member's chat: a brief or review from its team's orchestrator.
    Brief {
        /// The orchestrator's name.
        from: String,
        /// The member's name.
        to: String,
        text: String,
        /// Sent back after a review rather than a first brief.
        review: bool,
    },
    /// In a team chat: a member's reply to an @mention.
    Member {
        #[serde(rename = "botId")]
        bot_id: String,
        name: String,
        text: String,
    },
    /// In a team chat: the tasks of a request and how they're going.
    Plan(PlanCard),
}

/// One question of an `AskUserQuestion` call, as Claude Code sends it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Question {
    pub question: String,
    pub header: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PermissionStatus {
    Pending,
    Approved,
    Denied,
    Answered,
    /// The run ended (finished, stopped or the app quit) before an answer.
    Expired,
}

/// Answer to a `Permission` card, sent with `answer_permission`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PermissionAnswer {
    Allow,
    Deny,
    /// `AskUserQuestion`: picked option labels by question.
    Answers { answers: BTreeMap<String, String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub created_at: i64,
    #[serde(flatten)]
    pub body: MessageBody,
}

impl Message {
    pub fn new(body: MessageBody) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: chrono::Utc::now().timestamp_millis(),
            body,
        }
    }
}

/// Answer to an onboarding card, sent with `answer_setup`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SetupAnswer {
    Choice { option: String },
    Schedule {
        time: String,
        days: Vec<Weekday>,
        #[serde(default, rename = "everyMinutes")]
        every_minutes: Option<u32>,
        #[serde(default)]
        date: Option<String>,
        #[serde(default)]
        monthly: bool,
        notify: bool,
    },
    Folders { folders: Vec<String> },
    Review { instructions: String, task: Option<String> },
}

/// Payload of the `kbot://run` event: an agent run started or finished.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub bot_id: String,
    pub running: bool,
}

/// Payload of the `kbot://message` event: a message was added or changed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEvent {
    pub bot_id: String,
    pub message: Message,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, member: &str, step: u32, after: &[&str]) -> FlowNode {
        FlowNode {
            id: id.into(),
            member_id: member.into(),
            step,
            after: after.iter().map(|a| a.to_string()).collect(),
            ..FlowNode::default()
        }
    }

    #[test]
    fn flow_normalizes_steps_members_and_waits() {
        let flow = Flow {
            nodes: vec![
                node("c", "m3", 7, &["a", "c", "gone"]),
                node("a", "m1", 2, &["c"]),
                node("x", "stranger", 4, &[]),
                FlowNode { runs: 0, ..node("b", "m2", 2, &[]) },
                FlowNode { runs: 9, ..node("d", "m1", 9, &["b"]) },
            ],
            skip_unneeded: false,
        };
        let members = ["m1", "m2", "m3"].map(String::from);
        let flow = flow.normalized(&members);
        let ids: Vec<_> = flow.nodes.iter().map(|n| (n.id.as_str(), n.step)).collect();
        assert_eq!(ids, [("a", 0), ("b", 0), ("c", 1), ("d", 2)]);
        assert_eq!(flow.nodes[0].after, Vec::<String>::new());
        assert_eq!(flow.nodes[1].runs, 1);
        assert_eq!(flow.nodes[2].after, vec!["a".to_string()]);
        assert_eq!(flow.nodes[3].runs, Flow::MAX_RUNS);
        // An explicit wait, or the whole step before.
        assert_eq!(flow.waits_for(&flow.nodes[3]), vec!["b".to_string()]);
        assert_eq!(flow.waits_for(&flow.nodes[2]), vec!["a".to_string()]);
        let c = FlowNode { after: Vec::new(), ..flow.nodes[2].clone() };
        assert_eq!(flow.waits_for(&c), vec!["a".to_string(), "b".to_string()]);
        assert!(flow.waits_for(&flow.nodes[0]).is_empty());
    }

    #[test]
    fn team_messages_round_trip() {
        let body = MessageBody::Member { bot_id: "b".into(), name: "R".into(), text: "hi".into() };
        let json = serde_json::to_value(&body).unwrap();
        assert_eq!(json["type"], "member");
        assert_eq!(json["botId"], "b");
        let card = MessageBody::Plan(PlanCard { mode: TeamMode::Auto, state: PlanState::Running, tasks: Vec::new() });
        let json = serde_json::to_value(&card).unwrap();
        assert_eq!(json["type"], "plan");
        assert_eq!(json["state"], "running");
        assert!(matches!(serde_json::from_value::<MessageBody>(json).unwrap(), MessageBody::Plan(_)));
    }
}
