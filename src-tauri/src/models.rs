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

/// Payload of the `kbot://message` event: a message was added or changed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageEvent {
    pub bot_id: String,
    pub message: Message,
}
