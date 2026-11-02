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

/** The pictures offered when creating a bot (`src/assets/bots/<id>.png`). */
export const BOT_IMAGES = [
  "bot01",
  "bot02",
  "bot03",
  "bot04",
  "bot05",
  "bot06",
  "bot07",
  "bot08",
  "bot09",
  "bot10",
  "bot11",
  "bot12",
  "bot13",
  "bot14",
  "bot15",
  "bot16",
  "bot17",
  "bot18",
  "bot19",
  "bot20",
] as const;
export type BotImage = (typeof BOT_IMAGES)[number];

/** Robot glyphs of older bots, drawn in their color. */
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
  | { kind: "image"; image: BotImage }
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
  /** Last scheduled job run, epoch ms. */
  lastRunAt: number | null;
  /** A set-up bot is being changed with `/setup`. */
  editing: boolean;
  /** A scheduled job posted a result or question the user hasn't seen. */
  unread: boolean;
  /** Ids of the bot's tags, in the order they were added. */
  tags: string[];
  /** The team the bot is in, as its orchestrator or a member. */
  teamId: string | null;
  /** What the bot does in its team; the orchestrator routes tasks by it. */
  teamRole: string;
}

/** An orchestrator (the lead) and the member bots it gives tasks to. */
export interface Team {
  id: string;
  name: string;
  /** "What does this team do?" */
  purpose: string;
  /** One of `TAG_COLORS`. */
  color: string;
  /** The orchestrator, a bot in this team. */
  leadId: string;
  mode: TeamMode;
  /** The run order when `mode` is "flow". */
  flow: Flow;
  collapsed: boolean;
  updatedAt: number;
  preview: string;
  unread: boolean;
  /** Member ids in order, not counting the orchestrator. */
  members: string[];
  /** What the team is doing right now; null when idle. */
  activity: TeamActivity | null;
}

export const MAX_TEAM_NAME = 60;

/** "auto" = Let it decide; "flow" = Custom flow. */
export type TeamMode = "auto" | "flow";

export interface Flow {
  nodes: FlowNode[];
  /** The orchestrator may leave out members a request doesn't need. */
  skipUnneeded: boolean;
}

export type FlowInput = "results" | "everything";
export type OnFail = "stop" | "skip" | "ask";

export interface FlowNode {
  id: string;
  memberId: string;
  /** The step (column), from 0. */
  step: number;
  /** Nodes it waits for; empty = every node of the step before. */
  after: string[];
  task: string;
  /** 1..MAX_RUNS. */
  runs: number;
  stopEarly: boolean;
  gets: FlowInput;
  onFail: OnFail;
}

/** Mirrors `Flow::MAX_RUNS`. */
export const MAX_RUNS = 5;

export const EMPTY_FLOW: Flow = { nodes: [], skipUnneeded: false };

export function newFlowNode(memberId: string, step: number): FlowNode {
  return {
    id: crypto.randomUUID(),
    memberId,
    step,
    after: [],
    task: "",
    runs: 1,
    stopEarly: true,
    gets: "results",
    onFail: "ask",
  };
}

export type TaskStatus = "waiting" | "working" | "review" | "done" | "skipped" | "failed" | "blocked";

export interface TeamActivity {
  /** By member id. */
  statuses: Record<string, TaskStatus>;
  /** "1 working · 1 of 3 done". */
  summary: string;
}

export interface PlanTask {
  id: string;
  title: string;
  memberId: string;
  memberName: string;
  brief: string;
  after: string[];
  step: number | null;
  status: TaskStatus;
  detail: string;
  runs: number;
  run: number;
}

export type PlanState = "running" | "paused" | "done" | "stopped";

export interface PlanCard {
  mode: TeamMode;
  state: PlanState;
  tasks: PlanTask[];
}

export interface PlanEdit {
  taskId: string;
  title: string;
  brief: string;
  memberId: string;
  remove: boolean;
}

export type TaskAction = "retry" | "skip" | "stop";

/** A member in the "Create team" wizard: an existing bot, or a new agent. */
export interface NewMember {
  /** What the wizard's flow nodes call it. */
  key: string;
  botId: string | null;
  name: string;
  image: BotImage | null;
  role: string;
}

export interface NewTeam {
  name: string;
  purpose: string;
  color: string;
  leadName: string;
  leadImage: BotImage;
  instructions: string;
  mode: TeamMode;
  members: NewMember[];
  /** Members are named by `NewMember.key`. */
  flow: Flow;
}

/** "Team settings": Team Info and Flow. */
export interface TeamInfo {
  name: string;
  purpose: string;
  color: string;
  mode: TeamMode;
  flow: Flow;
}

/** A label for grouping bots, shared by all of them. */
export interface Tag {
  id: string;
  name: string;
  /** One of `TAG_COLORS`. */
  color: string;
}

/** Mirrors `Tag::COLORS`: the swatches in a tag's "Color" menu. */
export const TAG_COLORS = [
  "#141414",
  "#9A5B34",
  "#F0263E",
  "#FF5A1F",
  "#F7931E",
  "#16B364",
  "#12A89A",
  "#1A73F0",
  "#7C3AED",
  "#EC2D8C",
  "#8E8E8E",
] as const;

/** Mirrors `Tag::MAX_NAME`. */
export const MAX_TAG_NAME = 30;

export type SetupState = "pending" | "done" | "skipped";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Schedule {
  /** Local "HH:MM" of a daily job or a task on a date; unused on an interval. */
  time: string;
  /** Daily or on an interval; unused on a date. */
  days: Weekday[];
  /** null = once a day at `time`, or on `date`; n = every n minutes. */
  everyMinutes: number | null;
  /** "YYYY-MM-DD": a task that runs on this date at `time` instead of daily. */
  date: string | null;
  /** A task on a date repeats every month on that day of the month. */
  monthly: boolean;
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
  /** Claude Code `--model`; null = `AppSettings.defaultModel`. */
  model: string | null;
  /** Codex `--model`; null = `AppSettings.codexModel`. */
  codexModel: string | null;
  /**
   * "MCP servers & tools": run with the user's own CLI setup (settings,
   * CLAUDE.md, hooks, plugins, MCP servers, Claude in Chrome).
   */
  extendedTools: boolean;
}

/** What the "MCP servers & tools" switch does, under its label. */
export const EXTENDED_TOOLS_HINT =
  "Use your own Claude Code setup: MCP servers like JIRA, Claude in Chrome, skills and plugins";

/** Mirrors `Bot::MAX_NAME`. */
export const MAX_NAME = 60;

/** Claude Code `--model` for bots that don't pick their own. */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** The coding agent CLI bots run on. */
export type Provider = "claude" | "codex";
/** How long the model thinks before acting. */
export type Effort = "low" | "medium" | "high";
export type Theme = "light" | "dark";

/** App-wide preferences, edited in Kbot > Settings…. */
export interface AppSettings {
  provider: Provider;
  /** Claude Code `--model` for bots whose `AgentConfig.model` is null. */
  defaultModel: string;
  /** Codex `--model` for bots whose `AgentConfig.codexModel` is null; null = the Codex config's model. */
  codexModel: string | null;
  effort: Effort;
  theme: Theme;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  provider: "claude",
  defaultModel: DEFAULT_MODEL,
  codexModel: null,
  effort: "medium",
  theme: "light",
};

export const DEFAULT_SCHEDULE: Schedule = {
  time: "08:00",
  days: [...WEEKDAYS],
  everyMinutes: null,
  date: null,
  monthly: false,
  task: "",
  notify: true,
};

/** Mirrors `Schedule::MIN_EVERY`, `MAX_EVERY` and `DEFAULT_EVERY`. */
export const MIN_EVERY = 5;
export const MAX_EVERY = 24 * 60;
export const DEFAULT_EVERY = 30;

/** Mirrors `Schedule::interval`: no notification every few minutes. */
export const INTERVAL_SCHEDULE: Schedule = { ...DEFAULT_SCHEDULE, everyMinutes: DEFAULT_EVERY, notify: false };

/** A local date as "YYYY-MM-DD". */
export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** A new task on a date, tomorrow at the default time, like setup's "Schedule a task". */
export function dateSchedule(): Schedule {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { ...DEFAULT_SCHEDULE, date: isoDate(tomorrow) };
}

export const EMPTY_CONFIG: AgentConfig = {
  description: "",
  instructions: "",
  schedule: null,
  workspaceFolders: [],
  webAccess: false,
  model: null,
  codexModel: null,
  extendedTools: false,
};

export type Control = "user" | "agent";

export type MessageBody =
  | { type: "user"; text: string }
  | { type: "agent"; text: string }
  | { type: "system"; text: string }
  | { type: "computer"; prompt: string; control: Control }
  | { type: "setupChoice"; step: string; question: string; options: string[]; selected: string | null }
  | {
      type: "setupSchedule";
      time: string;
      days: Weekday[];
      everyMinutes: number | null;
      date: string | null;
      monthly: boolean;
      notify: boolean;
      submitted: boolean;
    }
  | { type: "setupFolders"; folders: string[]; submitted: boolean }
  | {
      type: "setupReview";
      config: AgentConfig;
      confirmed: boolean;
      /** Set on a change made with `/setup`: the saved config it would replace. */
      previous: AgentConfig | null;
      /** The new name, when a `/setup` change renames the bot. */
      name: string | null;
      /** Replaced by a newer change, or `/setup` was closed without saving. */
      discarded: boolean;
    }
  | { type: "setupCurrent"; config: AgentConfig }
  | {
      /** Claude Code asks before using a tool, or asks the user something (`questions`). */
      type: "permission";
      requestId: string;
      tool: string;
      summary: string;
      detail: string;
      input: unknown;
      questions: Question[];
      status: PermissionStatus;
      /** Picked option labels by question text (comma-separated if several). */
      answers: Record<string, string>;
    }
  /** In a member's chat: a brief or review from its team's orchestrator. */
  | { type: "brief"; from: string; to: string; text: string; review: boolean }
  /** In a team chat: a member's reply to an @mention. */
  | { type: "member"; botId: string; name: string; text: string }
  /** In a team chat: the tasks of a request and how they're going. */
  | ({ type: "plan" } & PlanCard);

export type Question = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
};

export type PermissionStatus = "pending" | "approved" | "denied" | "answered" | "expired";

export type PermissionAnswer =
  | { type: "allow" }
  | { type: "deny" }
  | { type: "answers"; answers: Record<string, string> };

export type Message = MessageBody & { id: string; createdAt: number };

export interface MessageEvent {
  botId: string;
  message: Message;
}

/** Answer to an onboarding card (`answer_setup`). */
export type SetupAnswer =
  | { type: "choice"; option: string }
  | {
      type: "schedule";
      time: string;
      days: Weekday[];
      everyMinutes: number | null;
      date: string | null;
      monthly: boolean;
      notify: boolean;
    }
  | { type: "folders"; folders: string[] }
  | { type: "review"; instructions: string; task: string | null };

export interface RunEvent {
  botId: string;
  running: boolean;
}

/** Mirrors `codex::CodexStatus`. `account`: "ChatGPT", "an API key" or a model provider's name. */
export type CodexStatus = { state: "notInstalled" } | { state: "loggedOut" } | { state: "ready"; account: string };

/** Mirrors `codex::CodexModels`; `configured` is the model in the user's Codex config. */
export interface CodexModels {
  configured: string | null;
  models: { id: string; description: string }[];
}

/** Mirrors `claude::ClaudeStatus`. */
export type ClaudeStatus =
  | { state: "notInstalled" }
  | { state: "loggedOut" }
  | { state: "notSubscription"; authMethod: string }
  | { state: "ready"; subscription: string; email: string | null };
