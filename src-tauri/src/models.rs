//! Data types shared with the React UI. Everything is serialized camelCase;
//! the TypeScript mirror lives in `src/lib/types.ts`.

use serde::{Deserialize, Serialize};

/// The 15 robot icons offered in the "Create New Bot" dialog
/// (glyphs in `src/components/avatars/botIcons.ts`).
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
    /// A robot icon drawn in one of the palette colors.
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
    /// Unix epoch milliseconds of the last daily job run.
    pub last_run_at: Option<i64>,
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
    /// `None` = chat agent; `Some` = also runs a job every day.
    pub schedule: Option<Schedule>,
    /// Folders the agent may read.
    pub workspace_folders: Vec<String>,
    pub web_access: bool,
    /// Claude Code `--model` value (e.g. "sonnet"); `None` = CLI default.
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Schedule {
    /// Local time, "HH:MM".
    pub time: String,
    pub days: Vec<Weekday>,
    /// What to do on each run.
    pub task: String,
    /// Show an OS notification when the run finishes.
    pub notify: bool,
}

impl Default for Schedule {
    fn default() -> Self {
        Self { time: "08:00".into(), days: Weekday::ALL.to_vec(), task: String::new(), notify: true }
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
    /// Onboarding: when a daily job runs.
    SetupSchedule { time: String, days: Vec<Weekday>, notify: bool, submitted: bool },
    /// Onboarding: folders the agent may read.
    SetupFolders { folders: Vec<String>, submitted: bool },
    /// Onboarding: the final config for the user to confirm or edit.
    SetupReview { config: AgentConfig, confirmed: bool },
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
    Schedule { time: String, days: Vec<Weekday>, notify: bool },
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
