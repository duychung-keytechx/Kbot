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
