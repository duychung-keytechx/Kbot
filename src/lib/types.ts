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
  setupState: SetupState;
  config: AgentConfig;
  /** Last daily job run, epoch ms. */
  lastRunAt: number | null;
}

export type SetupState = "pending" | "done" | "skipped";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Schedule {
  /** Local "HH:MM". */
  time: string;
  days: Weekday[];
  task: string;
  notify: boolean;
}

export interface AgentConfig {
  description: string;
  instructions: string;
  /** null = chat agent. */
  schedule: Schedule | null;
  workspaceFolders: string[];
  webAccess: boolean;
  /** Claude Code `--model`; null = CLI default. */
  model: string | null;
}

export const DEFAULT_SCHEDULE: Schedule = { time: "08:00", days: [...WEEKDAYS], task: "", notify: true };

export const EMPTY_CONFIG: AgentConfig = {
  description: "",
  instructions: "",
  schedule: null,
  workspaceFolders: [],
  webAccess: false,
  model: null,
};

export type Control = "user" | "agent";

export type MessageBody =
  | { type: "user"; text: string }
  | { type: "agent"; text: string }
  | { type: "system"; text: string }
  | { type: "computer"; prompt: string; control: Control }
  | { type: "setupChoice"; step: string; question: string; options: string[]; selected: string | null }
  | { type: "setupSchedule"; time: string; days: Weekday[]; notify: boolean; submitted: boolean }
  | { type: "setupFolders"; folders: string[]; submitted: boolean }
  | { type: "setupReview"; config: AgentConfig; confirmed: boolean };

export type Message = MessageBody & { id: string; createdAt: number };

export interface MessageEvent {
  botId: string;
  message: Message;
}

/** Answer to an onboarding card (`answer_setup`). */
export type SetupAnswer =
  | { type: "choice"; option: string }
  | { type: "schedule"; time: string; days: Weekday[]; notify: boolean }
  | { type: "folders"; folders: string[] }
  | { type: "review"; instructions: string; task: string | null };

export interface RunEvent {
  botId: string;
  running: boolean;
}

/** Mirrors `claude::ClaudeStatus`. */
export type ClaudeStatus =
  | { state: "notInstalled" }
  | { state: "loggedOut" }
  | { state: "notSubscription"; authMethod: string }
  | { state: "ready"; subscription: string; email: string | null };
