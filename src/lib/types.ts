// Mirrors src-tauri/src/models.rs (serde camelCase).

export const BOT_SHAPES = [
  "circle",
  "cloud",
  "squircle",
  "tilted",
  "diamond",
  "flower",
  "egg",
  "pill",
  "triangle",
  "hexagon",
  "heart",
  "ghost",
  "burst",
  "shield",
  "cross",
] as const;
export type BotShape = (typeof BOT_SHAPES)[number];

export const BOT_ICONS = [
  "classic",
  "happy",
  "love",
  "angry",
  "buddy",
  "round",
  "sleepy",
  "boxy",
  "helper",
  "block",
  "cyclops",
  "bust",
  "bubble",
  "tall",
  "chatty",
] as const;
export type BotIcon = (typeof BOT_ICONS)[number];

export type Avatar =
  | { kind: "icon"; icon: BotIcon; color: string }
  | { kind: "shape"; shape: BotShape; color: string };

export interface Bot {
  id: string;
  name: string;
  avatar: Avatar;
  pinned: boolean;
  updatedAt: number;
  preview: string;
}

export type Control = "user" | "agent";

export type MessageBody =
  | { type: "user"; text: string }
  | { type: "agent"; text: string }
  | { type: "system"; text: string }
  | { type: "computer"; prompt: string; control: Control };

export type Message = MessageBody & { id: string; createdAt: number };

export interface MessageEvent {
  botId: string;
  message: Message;
}
