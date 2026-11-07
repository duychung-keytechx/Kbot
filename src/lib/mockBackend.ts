// Browser-only stand-in for the Rust backend (see api.ts). Mirrors the
// behaviour of src-tauri/src/{store,commands,agent,setup}.rs closely enough
// for UI work. `?claude=loggedOut` (or notInstalled / notSubscription) shows
// the Connect Claude screen, `?codex=loggedOut` (or notInstalled) the Connect
// Codex one once Codex is picked in Settings.

import type { Backend } from "./api";
import {
  type AgentConfig,
  type AppSettings,
  type Bot,
  type BotImage,
  type ClaudeStatus,
  type CodexModels,
  type CodexStatus,
  dateSchedule,
  DEFAULT_APP_SETTINGS,
  DEFAULT_SCHEDULE,
  EMPTY_CONFIG,
  INTERVAL_SCHEDULE,
  MAX_EVERY,
  MAX_NAME,
  MAX_TAG_NAME,
  MAX_TEAM_NAME,
  MIN_EVERY,
  type Message,
  type MessageBody,
  type MessageEvent,
  type PermissionAnswer,
  type PlanCard,
  type PlanEdit,
  type PlanTask,
  type RunEvent,
  type Tag,
  TAG_COLORS,
  type TaskAction,
  type TaskStatus,
  type Team,
  type TeamActivity,
} from "./types";

type Step = "kind" | "description" | "schedule" | "web" | "workspace" | "clarify" | "review" | "edit";

const CHAT = "Chat with me";
const DAILY = "Run a daily job";
const INTERVAL = "Run on an interval";
const ON_DATE = "Schedule a task";

/** `agent::describe_every`. */
const describeEvery = (n: number) => (n === 60 ? "1 hour" : n % 60 === 0 ? `${n / 60} hours` : `${n} min`);

/** `Schedule::validate`. */
function validateSchedule(s: { time: string; days: unknown[]; everyMinutes: number | null; date: string | null; monthly: boolean }) {
  if (s.everyMinutes !== null && !(Number.isInteger(s.everyMinutes) && s.everyMinutes >= MIN_EVERY && s.everyMinutes <= MAX_EVERY)) {
    throw new Error(`Pick an interval from ${MIN_EVERY} minutes to 24 hours`);
  }
  if (s.everyMinutes === null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time)) throw new Error(`${s.time} is not a valid time`);
  if (s.date !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date)) throw new Error(`${s.date} is not a valid date`);
  } else if (s.days.length === 0) throw new Error("Pick at least one day");
}

/** `scheduler::check_date`: a one-time task set in the past would never run. */
function checkDate(s: { time: string; date: string | null; monthly: boolean }) {
  if (s.date !== null && !s.monthly && new Date(`${s.date}T${s.time}`).getTime() <= Date.now()) {
    throw new Error("Pick a date and time in the future");
  }
}
const BUSY = "Wait for the current reply to finish, or stop it.";
const SETUP_COMMAND = "/setup";

const bots: Bot[] = [];
const conversations = new Map<string, Message[]>();
const steps = new Map<string, Step>();
const running = new Map<string, () => void>();
const botListeners = new Set<(bots: Bot[]) => void>();
const messageListeners = new Set<(e: MessageEvent) => void>();
const runListeners = new Set<(e: RunEvent) => void>();
const clearedListeners = new Set<(botId: string) => void>();
const settingsListeners = new Set<(settings: AppSettings) => void>();
const tags: Tag[] = [];
const tagListeners = new Set<(tags: Tag[]) => void>();
let appSettings: AppSettings = { ...DEFAULT_APP_SETTINGS };
let viewing: string | null = null;

const wanted = new URLSearchParams(location.search).get("claude");
let claude: ClaudeStatus =
  wanted === "notInstalled" || wanted === "loggedOut"
    ? { state: wanted }
    : wanted === "notSubscription"
      ? { state: "notSubscription", authMethod: "api_key" }
      : { state: "ready", subscription: "max", email: "you@example.com" };

const wantedCodex = new URLSearchParams(location.search).get("codex");
const codexReady: CodexStatus = { state: "ready", account: "oMLX" };
let codex: CodexStatus = wantedCodex === "notInstalled" || wantedCodex === "loggedOut" ? { state: wantedCodex } : codexReady;
const CODEX_MODELS: CodexModels = {
  configured: "Qwen3.8-27B-MLX-4bit",
  models: [
    { id: "gpt-5.2-codex", description: "Tuned for agentic work and tool use" },
    { id: "gpt-5.2", description: "General reasoning, research and writing" },
    { id: "gpt-5.1-codex-max", description: "Long, multi-step tasks. Slower" },
    { id: "gpt-5.1-codex-mini", description: "Faster and cheaper, for light tasks" },
  ],
};

const bot = (botId: string) => {
  const b = bots.find((b) => b.id === botId);
  if (!b) throw new Error(`unknown bot ${botId}`);
  return b;
};
const emitBots = () => botListeners.forEach((cb) => cb(structuredClone(bots)));

const teams: Team[] = [];
const teamListeners = new Set<(teams: Team[]) => void>();
/** `teams::list`: newest activity first, with what running teams are doing. */
const listTeams = () =>
  structuredClone(teams)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t) => ({ ...t, activity: live.get(t.id)?.activity ?? null }));
const emitTeams = () => {
  const list = listTeams();
  teamListeners.forEach((cb) => cb(structuredClone(list)));
};
const team = (teamId: string) => {
  const t = teams.find((t) => t.id === teamId);
  if (!t) throw new Error(`unknown team ${teamId}`);
  return t;
};
const isTeam = (id: string) => teams.some((t) => t.id === id);
/** The owner of a chat: a bot, or a team for a team chat. */
const chat = (id: string): Bot | Team => teams.find((t) => t.id === id) ?? bot(id);
const sortedTags = () => structuredClone(tags).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
const emitTags = () => tagListeners.forEach((cb) => cb(sortedTags()));
const tag = (tagId: string) => {
  const t = tags.find((t) => t.id === tagId);
  if (!t) throw new Error(`unknown tag ${tagId}`);
  return t;
};
/** `Tag::clean_name` plus the store's case-insensitive UNIQUE. */
function cleanTagName(name: string, except?: string) {
  const clean = name.trim();
  if (!clean) throw new Error("Tag name is required");
  if (clean.length > MAX_TAG_NAME) throw new Error(`Tag name can be at most ${MAX_TAG_NAME} characters`);
  if (tags.some((t) => t.id !== except && t.name.toLowerCase() === clean.toLowerCase()))
    throw new Error(`A tag named “${clean}” already exists`);
  return clean;
}

function emit(botId: string, message: Message) {
  messageListeners.forEach((cb) => cb({ botId, message: structuredClone(message) }));
  emitBots();
  if (isTeam(botId)) emitTeams();
}

function push(botId: string, body: MessageBody): Message {
  const message = { ...body, id: crypto.randomUUID(), createdAt: Date.now() } as Message;
  if (!conversations.has(botId)) conversations.set(botId, []);
  conversations.get(botId)!.push(message);
  const b = chat(botId);
  b.updatedAt = message.createdAt;
  if (body.type === "user" || body.type === "agent") b.preview = body.text;
  if (body.type === "member") b.preview = `${body.name}: ${body.text}`;
  if (body.type === "brief") b.preview = `${body.from}: ${body.text}`;
  if (body.type === "permission")
    b.preview = body.questions[0]?.question ?? `Wants to use ${body.tool}. Approve?`;
  emit(botId, message);
  return message;
}

function setRunning(botId: string, stop: (() => void) | null) {
  if (stop) running.set(botId, stop);
  else running.delete(botId);
  runListeners.forEach((cb) => cb({ botId, running: !!stop }));
}

/** Resumes a run waiting on a permission card, by message id. */
const permissionWaits = new Map<string, (answer: PermissionAnswer) => void>();

/** "ask me …" shows a question card, "… approval" a Bash approval card. */
function askPermission(botId: string, question: boolean) {
  const card = push(
    botId,
    question
      ? {
          type: "permission",
          requestId: crypto.randomUUID(),
          tool: "AskUserQuestion",
          summary: "",
          detail: "",
          input: {},
          questions: [
            {
              question: "Coffee or tea?",
              header: "Drink",
              options: [
                { label: "Coffee", description: "Strong and hot" },
                { label: "Tea", description: "Green, no sugar" },
              ],
              multiSelect: false,
            },
          ],
          status: "pending",
          answers: {},
        }
      : {
          type: "permission",
          requestId: crypto.randomUUID(),
          tool: "Bash",
          summary: "Delete the old build folder",
          detail: "rm -rf ~/projects/site/build",
          input: {},
          questions: [],
          status: "pending",
          answers: {},
        },
  );
  const expire = () => {
    permissionWaits.delete(card.id);
    if (card.type === "permission" && card.status === "pending") card.status = "expired";
    emit(botId, card);
  };
  setRunning(botId, () => {
    setRunning(botId, null);
    expire();
    push(botId, { type: "system", text: "Stopped" });
  });
  permissionWaits.set(card.id, (answer) => {
    setRunning(botId, null);
    reply(
      botId,
      answer.type === "answers"
        ? `You picked ${Object.values(answer.answers).join(", ")}.`
        : answer.type === "allow"
          ? "Done, the build folder is gone."
          : "OK, I left it alone.",
    );
  });
}

/** Streams `text` into one agent bubble, like `agent::Reply`. */
function reply(botId: string, text: string, then?: () => void) {
  let timer = 0;
  const stop = () => {
    clearTimeout(timer);
    setRunning(botId, null);
  };
  setRunning(botId, () => {
    stop();
    push(botId, { type: "system", text: "Stopped" });
  });
  const words = text.split(" ");
  let shown = 0;
  let message: Message | undefined;
  const tick = () => {
    shown += 2;
    const body = { type: "agent" as const, text: words.slice(0, shown).join(" ") };
    if (!message) message = push(botId, body);
    else {
      Object.assign(message, body);
      chat(botId).preview = body.text;
      emit(botId, message);
    }
    if (shown < words.length) timer = window.setTimeout(tick, 60);
    else {
      stop();
      then?.();
    }
  };
  timer = window.setTimeout(tick, 600);
}

/** Pretends to ask Claude, like `setup::generate`. */
function think(botId: string, then: () => void) {
  const timer = window.setTimeout(() => {
    setRunning(botId, null);
    then();
  }, 900);
  setRunning(botId, () => {
    clearTimeout(timer);
    setRunning(botId, null);
    then();
  });
}

function enter(botId: string, step: Step) {
  steps.set(botId, step);
  const { name, config } = bot(botId);
  switch (step) {
    case "kind":
      push(botId, {
        type: "setupChoice",
        step: "kind",
        question: `Hi, I'm ${name}! What should I do for you?`,
        options: [CHAT, DAILY, INTERVAL, ON_DATE],
        selected: null,
      });
      break;
    case "description":
      push(botId, {
        type: "agent",
        text: !config.schedule
          ? "Describe what I should do.\n\nFor example: “Help me write replies to customer emails in a friendly, professional tone.”"
          : config.schedule.date !== null
            ? "Describe the task I should do.\n\nFor example: “Sum up last month's expenses from my notes and remind me to pay rent.”"
            : config.schedule.everyMinutes === null
            ? "Describe the job I should do each day.\n\nFor example: “Give me a morning brief of AI news and anything due today in my notes.”"
            : "Describe the job I should do on each run.\n\nFor example: “Check my Downloads folder for new invoices and add them to my expenses sheet.”",
      });
      break;
    case "schedule": {
      const s = config.schedule ?? DEFAULT_SCHEDULE;
      push(botId, {
        type: "setupSchedule",
        time: s.time,
        days: s.days,
        everyMinutes: s.everyMinutes,
        date: s.date,
        monthly: s.monthly,
        notify: s.notify,
        submitted: false,
      });
      break;
    }
    case "web":
      push(botId, {
        type: "setupChoice",
        step: "web",
        question: "Should I be able to search the web?",
        options: ["Yes", "No"],
        selected: null,
      });
      break;
    case "workspace":
      push(botId, { type: "setupFolders", folders: config.workspaceFolders, submitted: false });
      break;
    case "clarify":
      push(botId, {
        type: "agent",
        text: "A few quick questions so I get this right.\n\nAnything I should focus on or leave out? (Browser mock)",
      });
      break;
    case "review":
      push(botId, {
        type: "setupReview",
        config: structuredClone(config),
        confirmed: false,
        previous: null,
        name: null,
        discarded: false,
      });
      break;
    case "edit":
      bot(botId).editing = true;
      emitBots();
      push(botId, { type: "setupCurrent", config: structuredClone(config) });
      break;
  }
}

function finish(botId: string, updated = false) {
  const b = bot(botId);
  steps.delete(botId);
  b.setupState = "done";
  b.editing = false;
  emitBots();
  const s = b.config.schedule;
  const done = updated ? "Setup updated" : "Setup complete";
  const when = !s
    ? ""
    : s.everyMinutes !== null
      ? ` · Runs every ${describeEvery(s.everyMinutes)}`
      : ` · Next run: ${s.date !== null ? `${s.date} ` : ""}${s.time}`;
  push(botId, { type: "system", text: done + when });
}

/** Marks an unsaved `/setup` change as not saved, like `setup::discard_changes`. */
function discardChanges(botId: string) {
  for (const m of conversations.get(botId) ?? []) {
    if (m.type === "setupReview" && m.previous && !m.confirmed && !m.discarded) {
      m.discarded = true;
      emit(botId, m);
    }
  }
}

/** `/setup`, like `setup::command`: onboarding again, or show and change the setup. */
function setupCommand(botId: string) {
  const b = bot(botId);
  discardChanges(botId);
  // Like `setup::has_setup`: team members and bots with instructions are set up too.
  if (b.setupState !== "done" && !b.teamId && !b.config.instructions.trim()) {
    b.setupState = "pending";
    b.config = structuredClone(EMPTY_CONFIG);
    emitBots();
    enter(botId, "kind");
  } else {
    enter(botId, "edit");
  }
}

function advance(botId: string, step: Step, input: string | Extract<Message, { type: `setup${string}` }>) {
  const { config } = bot(botId);
  if (typeof input === "string") {
    if (step === "description") {
      config.description = input;
      enter(botId, config.schedule ? "schedule" : "web");
    } else if (step === "edit") {
      discardChanges(botId);
      think(botId, () => {
        // "Rename yourself to …" renames; anything else is added to the instructions.
        const name = input.match(/^rename (?:yourself )?to (.+)$/i)?.[1].trim() ?? null;
        const draft = structuredClone(config);
        if (!name) draft.instructions = `${draft.instructions}\n\n${input}`;
        push(botId, { type: "setupReview", config: draft, confirmed: false, previous: structuredClone(config), name, discarded: false });
      });
    } else if (step === "clarify") {
      think(botId, () => {
        config.instructions = `${config.description}\n\nFocus: ${input}`;
        if (config.schedule) config.schedule.task = config.description;
        enter(botId, "review");
      });
    } else {
      push(botId, { type: "agent", text: "Please answer with the card above, or skip setup." });
    }
    return;
  }
  switch (input.type) {
    case "setupChoice":
      if (input.step === "kind") {
        config.schedule =
          input.selected === DAILY
            ? { ...DEFAULT_SCHEDULE }
            : input.selected === INTERVAL
              ? { ...INTERVAL_SCHEDULE }
              : input.selected === ON_DATE
                ? dateSchedule()
                : null;
        enter(botId, "description");
      } else {
        config.webAccess = input.selected === "Yes";
        enter(botId, "workspace");
      }
      break;
    case "setupSchedule":
      config.schedule = {
        ...(config.schedule ?? DEFAULT_SCHEDULE),
        time: input.time,
        days: input.days,
        everyMinutes: input.everyMinutes,
        date: input.date,
        monthly: input.monthly,
        notify: input.notify,
      };
      enter(botId, "web");
      break;
    case "setupFolders":
      config.workspaceFolders = input.folders;
      think(botId, () => enter(botId, "clarify"));
      break;
    case "setupReview":
      if (input.previous) {
        bot(botId).config = structuredClone(input.config);
        if (input.name) bot(botId).name = input.name;
        finish(botId, true);
        break;
      }
      config.instructions = input.config.instructions;
      if (config.schedule && input.config.schedule) config.schedule.task = input.config.schedule.task;
      finish(botId);
      break;
  }
}


// ---------------------------------------------------------------------------
// Agent teams, like src-tauri/src/teams.rs: the orchestrator plans tasks, the
// members work on them (at most MAX_PARALLEL at once) and the orchestrator
// checks each result. Timers stand in for the agents.

const TEAM_BUSY = "Wait for the team to finish, or stop it.";
const NOT_RUNNING = "The team isn't working on anything right now.";
const MAX_PARALLEL = 3;
const MAX_TASKS = 8;

type Live = {
  teamId: string;
  request: string;
  card: Message & { type: "plan" };
  activity: TeamActivity;
  paused: boolean;
  timers: Set<number>;
  /** Review rounds so far, by task id. */
  reviews: Map<string, number>;
  /** Steps-in waiting for the member's current task, by member id. */
  stepIns: Map<string, string[]>;
  failOn: string | null;
};
const live = new Map<string, Live>();

const isFinished = (s: TaskStatus) => s === "done" || s === "skipped" || s === "failed";

/** `team_bot`: a bot that skips setup, with web access. */
function teamBot(name: string, image: BotImage, description: string, instructions: string): Bot {
  const clean = name.trim();
  if (!clean) throw new Error("Bot name is required");
  if (clean.length > MAX_NAME) throw new Error(`Bot name can be at most ${MAX_NAME} characters`);
  return {
    id: crypto.randomUUID(),
    name: clean,
    avatar: { kind: "image", image },
    pinned: false,
    updatedAt: Date.now(),
    preview: "",
    setupState: "skipped",
    config: { ...structuredClone(EMPTY_CONFIG), description: description.trim(), instructions: instructions.trim(), webAccess: true },
    lastRunAt: null,
    editing: false,
    unread: false,
    tags: [],
    teamId: null,
    teamRole: "",
  };
}

function addBot(b: Bot) {
  bots.splice(bots.filter((b) => b.pinned).length, 0, b);
  conversations.set(b.id, []);
}

function cleanTeamName(name: string) {
  const clean = name.trim();
  if (!clean) throw new Error("Team name is required");
  if (clean.length > MAX_TEAM_NAME) throw new Error(`Team name can be at most ${MAX_TEAM_NAME} characters`);
  return clean;
}

function checkColor(color: string) {
  if (!(TAG_COLORS as readonly string[]).includes(color)) throw new Error(`unknown tag color ${color}`);
}

/** `Flow::normalized`. */
function normalizeFlow(t: Team) {
  const nodes = t.flow.nodes.filter((n) => t.members.includes(n.memberId) && n.id);
  const steps = [...new Set(nodes.map((n) => n.step))].sort((a, b) => a - b);
  for (const n of nodes) {
    n.step = steps.indexOf(n.step);
    n.runs = Math.min(5, Math.max(1, n.runs));
  }
  const stepOf = new Map(nodes.map((n) => [n.id, n.step]));
  for (const n of nodes) n.after = [...new Set(n.after.filter((id) => (stepOf.get(id) ?? Infinity) < n.step))];
  nodes.sort((a, b) => a.step - b.step);
  t.flow = { ...t.flow, nodes };
}

/** `leave_team`. */
function leaveTeam(botId: string) {
  const b = bot(botId);
  if (!b.teamId) return;
  const t = team(b.teamId);
  if (t.leadId === botId) throw new Error(`This bot is ${t.name}'s orchestrator. Make another member the orchestrator first.`);
  if (live.has(t.id)) throw new Error(TEAM_BUSY);
  t.members = t.members.filter((m) => m !== botId);
  normalizeFlow(t);
  b.teamId = null;
}

/** `join_team`. */
function joinTeam(teamId: string, botId: string, role?: string | null) {
  const b = bot(botId);
  if (b.teamId !== teamId) {
    leaveTeam(botId);
    b.teamId = teamId;
    team(teamId).members.push(botId);
  }
  if (role != null) b.teamRole = role.trim();
}

function teamChanged(teamId: string): Team {
  emitBots();
  emitTeams();
  return listTeams().find((t) => t.id === teamId)!;
}

function markUnread(teamId: string) {
  if (viewing === teamId) return;
  team(teamId).unread = true;
  emitTeams();
}

/** `strip_mention`: "@Name do this" → "do this". */
function stripMention(text: string, name: string) {
  const t = text.trim();
  const at = `@${name}`;
  return t.toLowerCase().startsWith(at.toLowerCase()) ? t.slice(at.length).trim() || t : t;
}

function later(l: Live, ms: number, fn: () => void) {
  const id = window.setTimeout(() => {
    l.timers.delete(id);
    if (live.get(l.teamId) === l) fn();
  }, ms);
  l.timers.add(id);
}

const roleOf = (b: Bot) => b.teamRole || b.config.description || "Help with the request";

/** The tasks of a request: one per member, or the team's flow. */
function planTasks(t: Team, request: string): PlanTask[] {
  const member = (id: string) => bot(id);
  if (t.mode === "flow" && t.flow.nodes.length > 0) {
    const ids = new Map(t.flow.nodes.map((n, i) => [n.id, `t${i + 1}`]));
    return t.flow.nodes.map((n) => {
      // `Flow::waits_for`.
      let after = n.after;
      if (after.length === 0) {
        const before = Math.max(-1, ...t.flow.nodes.filter((o) => o.step < n.step).map((o) => o.step));
        after = before < 0 ? [] : t.flow.nodes.filter((o) => o.step === before).map((o) => o.id);
      }
      const m = member(n.memberId);
      return {
        id: ids.get(n.id)!,
        title: n.task.trim() || roleOf(m),
        memberId: m.id,
        memberName: m.name,
        brief: `${n.task.trim() || roleOf(m)}, for: ${request}`,
        after: after.map((a) => ids.get(a)!).filter(Boolean),
        step: n.step,
        status: "waiting",
        detail: "",
        runs: n.runs,
        run: 0,
      };
    });
  }
  return t.members.slice(0, MAX_TASKS).map((id, i) => {
    const m = member(id);
    return {
      id: `t${i + 1}`,
      title: roleOf(m),
      memberId: m.id,
      memberName: m.name,
      brief: `${roleOf(m)}, for: ${request}`,
      // The first two start together; the rest wait for the one before.
      after: i < 2 ? [] : [`t${i}`],
      step: null,
      status: "waiting",
      detail: "",
      runs: 1,
      run: 0,
    };
  });
}

/** `Run::describe_waiting` and `Run::activity`, then tells the UI. */
function saveCard(l: Live) {
  const { card } = l;
  if (card.state === "running" || card.state === "paused") card.state = l.paused ? "paused" : "running";
  const numbers = new Map(card.tasks.map((t, i) => [t.id, i + 1]));
  const finished = new Map(card.tasks.map((t) => [t.id, isFinished(t.status)]));
  for (const task of card.tasks) {
    if (task.status === "working") {
      task.detail = task.runs > 1 ? `Run ${task.run} of ${task.runs}` : (l.reviews.get(task.id) ?? 0) > 0 ? "Revising" : "Working on it";
    } else if (task.status === "waiting" && task.run === 0) {
      const pending = task.after.filter((a) => finished.get(a) === false).map((a) => numbers.get(a)!);
      task.detail =
        pending.length === 0
          ? l.paused
            ? "Paused"
            : "Up next"
          : pending.length === 1
            ? `Starts after task ${pending[0]}`
            : `Starts after tasks ${pending.join(", ")}`;
    }
  }
  const rank: Record<TaskStatus, number> = { working: 6, review: 5, blocked: 4, waiting: 3, done: 2, failed: 1, skipped: 0 };
  const statuses: Record<string, TaskStatus> = {};
  for (const task of card.tasks) {
    const cur = statuses[task.memberId];
    if (!cur || rank[task.status] > rank[cur]) statuses[task.memberId] = task.status;
  }
  const total = card.tasks.length;
  const done = card.tasks.filter((t) => isFinished(t.status)).length;
  const working = card.tasks.filter((t) => t.status === "working").length;
  let summary =
    card.state === "paused" ? `Paused · ${done} of ${total} done` : working === 0 ? `${done} of ${total} done` : `${working} working · ${done} of ${total} done`;
  if (card.tasks.some((t) => t.status === "blocked")) summary = `Needs you · ${summary}`;
  l.activity = { statuses, summary };
  emit(l.teamId, card);
}

/** Starts every task that can start: its waits are done, fewer than 3 work, one task per member. */
function pump(l: Live) {
  if (l.paused || l.card.state !== "running") return;
  const tasks = l.card.tasks;
  if (tasks.every((t) => isFinished(t.status))) return conclude(l);
  const busy = () => tasks.filter((t) => t.status === "working" || t.status === "review");
  for (const task of tasks) {
    if (busy().length >= MAX_PARALLEL) break;
    if (task.status !== "waiting") continue;
    if (busy().some((t) => t.memberId === task.memberId)) continue;
    const waits = task.after.map((a) => tasks.find((t) => t.id === a));
    if (!waits.every((w) => !w || isFinished(w.status))) continue;
    startTask(l, task);
  }
  saveCard(l);
}

function startTask(l: Live, task: PlanTask, note?: string) {
  const t = team(l.teamId);
  const lead = bot(t.leadId).name;
  const number = l.card.tasks.indexOf(task) + 1;
  task.status = "working";
  task.run += 1;
  const text =
    note ??
    (task.run > 1
      ? `Run ${task.run} of ${task.runs}: improve on your last result.`
      : `Task ${number} of ${l.card.tasks.length}: ${task.brief}`);
  push(task.memberId, { type: "brief", from: lead, to: task.memberName, text, review: !!note });
  bot(task.memberId).updatedAt = Date.now();
  later(l, 2200 + Math.random() * 2200, () => finishWork(l, task));
}

function finishWork(l: Live, task: PlanTask) {
  if (task.status !== "working") return;
  const stepIns = l.stepIns.get(task.memberId) ?? [];
  l.stepIns.delete(task.memberId);
  if (l.failOn === task.id && (l.reviews.get(task.id) ?? 0) === 0) {
    l.failOn = null;
    const node = team(l.teamId).flow.nodes.find((n) => n.memberId === task.memberId && n.step === task.step);
    const onFail = node?.onFail ?? "ask";
    const reason = `${task.memberName} couldn't finish`;
    push(task.memberId, { type: "system", text: `${task.memberName} couldn't reply. Its chat has the details.` });
    if (onFail === "stop") {
      task.status = "failed";
      task.detail = reason;
      push(l.teamId, { type: "system", text: `${reason}, so the team stopped.` });
      return stopRun(l, false);
    }
    if (onFail === "skip") {
      task.status = "skipped";
      task.detail = `${reason} · skipped`;
    } else {
      task.status = "blocked";
      task.detail = `${reason}. Retry, skip or stop?`;
      markUnread(l.teamId);
    }
    return pump(l);
  }
  push(task.memberId, {
    type: "agent",
    text:
      `Done: ${task.title.toLowerCase()}.` +
      (stepIns.length ? ` I also took your note into account: “${stepIns.join(" ")}”.` : "") +
      " (Browser mock)",
  });
  task.status = "review";
  task.detail = `${bot(team(l.teamId).leadId).name} is checking the result`;
  saveCard(l);
  later(l, 1100, () => review(l, task));
}

function review(l: Live, task: PlanTask) {
  if (task.status !== "review") return;
  const lead = bot(team(l.teamId).leadId).name;
  const rounds = l.reviews.get(task.id) ?? 0;
  // The first task goes back once, to show a review round-trip.
  if (task.id === "t1" && rounds === 0 && task.runs === 1) {
    l.reviews.set(task.id, 1);
    const notes = "a few results don't match the request";
    push(l.teamId, { type: "system", text: `${lead} sent ${task.memberName}'s result back: ${notes}` });
    task.status = "waiting";
    task.run -= 1;
    startTask(l, task, `Review: ${notes}. Fix those and send it again.`);
    return saveCard(l);
  }
  if (task.run < task.runs && !(task.run >= 2 && Math.random() < 0.4)) {
    task.status = "waiting";
    startTask(l, task);
    return saveCard(l);
  }
  const number = l.card.tasks.indexOf(task) + 1;
  push(task.memberId, { type: "system", text: `${lead} accepted the result · task ${number} done` });
  task.status = "done";
  task.detail = rounds > 0 ? "Finished after review" : task.runs > 1 ? `Finished in ${task.run} runs` : "Finished";
  pump(l);
}

function conclude(l: Live) {
  l.card.state = "done";
  saveCard(l);
  const done = l.card.tasks.filter((t) => t.status === "done");
  const text =
    done.length === 0
      ? "The team couldn't finish any task."
      : `Done. ${done.map((t) => `${t.memberName}: ${t.title.toLowerCase()}`).join("; ")}. (Browser mock)`;
  endRun(l);
  reply(l.teamId, text, () => markUnread(l.teamId));
}

function endRun(l: Live) {
  l.timers.forEach((id) => clearTimeout(id));
  l.timers.clear();
  live.delete(l.teamId);
  setRunning(l.teamId, null);
  emitTeams();
}

/** Stop: unfinished tasks are skipped. */
function stopRun(l: Live, note = true) {
  for (const task of l.card.tasks) {
    if (!isFinished(task.status)) {
      task.status = "skipped";
      task.detail = "Stopped";
    }
  }
  l.card.state = "stopped";
  saveCard(l);
  endRun(l);
  if (note) push(l.teamId, { type: "system", text: "Stopped" });
  markUnread(l.teamId);
}

/** `teams::spawn`: plan, then run the tasks. */
function runTeam(teamId: string, request: string) {
  const t = team(teamId);
  const tasks = planTasks(t, request);
  let timer = 0;
  setRunning(teamId, () => {
    clearTimeout(timer);
    const l = live.get(teamId);
    if (l) stopRun(l);
    else {
      setRunning(teamId, null);
      push(teamId, { type: "system", text: "Stopped" });
    }
  });
  timer = window.setTimeout(() => {
    if (tasks.length === 0) {
      setRunning(teamId, null);
      reply(teamId, `${t.name} has no members yet, so I'll answer myself: “${request}”. Add members in Team settings. (Browser mock)`, () =>
        markUnread(teamId),
      );
      return;
    }
    const flow = t.mode === "flow" && t.flow.nodes.length > 0;
    const first = tasks.filter((x) => x.after.length === 0).map((x) => x.memberName);
    push(teamId, {
      type: "agent",
      text: flow
        ? `On it. Running the flow: ${first.join(" and ")} ${first.length === 1 ? "starts" : "start"} now.`
        : `On it. I've split this into ${tasks.length === 1 ? "one task" : `${tasks.length} tasks`} for the team.`,
    });
    const body: PlanCard = { mode: flow ? "flow" : "auto", state: "running", tasks };
    const card = push(teamId, { type: "plan", ...body }) as Live["card"];
    const l: Live = {
      teamId,
      request,
      card,
      activity: { statuses: {}, summary: "" },
      paused: false,
      timers: new Set(),
      reviews: new Map(),
      stepIns: new Map(),
      // "…fail…" in a request makes the last task fail, to try Retry / Skip / Stop.
      failOn: /fail/i.test(request) ? tasks[tasks.length - 1].id : null,
    };
    live.set(teamId, l);
    pump(l);
  }, 900);
}

/** `teams::spawn_direct`: one member answers an @mention in the team chat. */
function runDirect(teamId: string, member: Bot, ask: string) {
  let timer = 0;
  const done = () => {
    setRunning(member.id, null);
    if (!live.has(teamId)) setRunning(teamId, null);
  };
  const stop = () => {
    clearTimeout(timer);
    done();
    push(teamId, { type: "system", text: `${member.name} was stopped` });
  };
  setRunning(member.id, stop);
  if (!running.has(teamId)) setRunning(teamId, stop);
  timer = window.setTimeout(() => {
    const text = `Here's my answer to “${ask}”. (Browser mock)`;
    push(member.id, { type: "agent", text });
    push(teamId, { type: "member", botId: member.id, name: member.name, text });
    done();
    markUnread(teamId);
  }, 1500);
}

const working = (teamId: string, memberId: string) =>
  live.get(teamId)?.card.tasks.some((t) => t.memberId === memberId && (t.status === "working" || t.status === "review")) ?? false;

export const mockBackend: Backend = {
  listBots: async () => structuredClone(bots),
  getMessages: async (botId) => structuredClone(conversations.get(botId) ?? []),
  createBot: async (name, image) => {
    const b: Bot = {
      id: crypto.randomUUID(),
      name: name.trim(),
      avatar: { kind: "image", image },
      pinned: false,
      updatedAt: Date.now(),
      preview: "",
      setupState: "pending",
      config: structuredClone(EMPTY_CONFIG),
      lastRunAt: null,
      editing: false,
      unread: false,
      tags: [],
      teamId: null,
      teamRole: "",
    };
    bots.splice(bots.filter((b) => b.pinned).length, 0, b);
    conversations.set(b.id, []);
    emitBots();
    enter(b.id, "kind");
    return structuredClone(b);
  },
  sendMessage: async (botId, text) => {
    const teamId = bot(botId).teamId;
    if (teamId && working(teamId, botId) && text.trim().toLowerCase() !== SETUP_COMMAND) {
      // Stepping in: the text goes into the member's current task.
      const message = push(botId, { type: "user", text: text.trim() });
      const l = live.get(teamId)!;
      l.stepIns.set(botId, [...(l.stepIns.get(botId) ?? []), text.trim()]);
      return { ...message };
    }
    if (running.has(botId)) throw new Error(BUSY);
    const message = push(botId, { type: "user", text: text.trim() });
    const step = steps.get(botId);
    if (text.trim().toLowerCase() === SETUP_COMMAND) setupCommand(botId);
    else if (step && (bot(botId).setupState === "pending" || step === "edit")) advance(botId, step, text.trim());
    else if (/ask me|approval/i.test(text)) askPermission(botId, /ask me/i.test(text));
    else reply(botId, `On it: “${text.trim()}”. (Browser mock, run \`npm run tauri dev\` for Claude.)`);
    return { ...message };
  },
  answerPermission: async (botId, messageId, answer) => {
    const message = conversations.get(botId)?.find((m) => m.id === messageId);
    if (!message || message.type !== "permission") throw new Error(`unknown message ${messageId}`);
    if (message.status !== "pending") throw new Error("This was already answered.");
    const waiting = permissionWaits.get(messageId);
    if (!waiting) {
      message.status = "expired";
      emit(botId, message);
      throw new Error("This request expired: the run already ended.");
    }
    permissionWaits.delete(messageId);
    message.status = answer.type === "allow" ? "approved" : answer.type === "deny" ? "denied" : "answered";
    if (answer.type === "answers") message.answers = answer.answers;
    emit(botId, message);
    waiting(answer);
    return { ...message };
  },
  setComputerControl: async (botId, messageId, control) => {
    const message = conversations.get(botId)?.find((m) => m.id === messageId);
    if (!message || message.type !== "computer") throw new Error(`unknown message ${messageId}`);
    message.control = control;
    emit(botId, message);
    if (control === "agent") reply(botId, "Thanks, I've got it from here. Looking through your accounts now.");
    return { ...message };
  },
  claudeStatus: async (refresh) => {
    await new Promise((r) => setTimeout(r, 300));
    // "Check again" pretends the user signed in meanwhile.
    if (refresh) claude = { state: "ready", subscription: "max", email: "you@example.com" };
    return claude;
  },
  codexStatus: async (refresh) => {
    await new Promise((r) => setTimeout(r, 300));
    if (refresh) codex = codexReady;
    return codex;
  },
  codexModels: async () => structuredClone(CODEX_MODELS),
  runningBots: async () => [...running.keys()],
  cancelRun: async (botId) => {
    running.get(botId)?.();
    return running.has(botId);
  },
  ensureSetup: async (botId) => {
    if (bot(botId).setupState === "pending" && !steps.has(botId)) enter(botId, "kind");
  },
  answerSetup: async (botId, messageId, answer) => {
    const message = conversations.get(botId)?.find((m) => m.id === messageId);
    const step = steps.get(botId);
    if (!message || !step) throw new Error("This question was already answered.");
    switch (message.type) {
      case "setupChoice":
        if (answer.type !== "choice" || message.selected !== null) throw new Error("This question was already answered.");
        message.selected = answer.option;
        break;
      case "setupSchedule":
        if (answer.type !== "schedule" || message.submitted) throw new Error("This question was already answered.");
        validateSchedule(answer);
        checkDate(answer);
        const { time, days, everyMinutes, date, monthly, notify } = answer;
        Object.assign(message, { time, days, everyMinutes, date, monthly, notify, submitted: true });
        break;
      case "setupFolders":
        if (answer.type !== "folders" || message.submitted) throw new Error("This question was already answered.");
        Object.assign(message, { folders: answer.folders, submitted: true });
        break;
      case "setupReview":
        if (answer.type !== "review" || message.confirmed || message.discarded) throw new Error("This question was already answered.");
        message.config.instructions = answer.instructions;
        if (message.config.schedule && answer.task !== null) message.config.schedule.task = answer.task;
        message.confirmed = true;
        break;
      default:
        throw new Error("This question was already answered.");
    }
    emit(botId, message);
    advance(botId, step, message);
    return { ...message };
  },
  skipSetup: async (botId) => {
    running.get(botId)?.();
    steps.delete(botId);
    bot(botId).setupState = "skipped";
    push(botId, { type: "system", text: `Setup skipped. Type ${SETUP_COMMAND} any time to set me up.` });
  },
  exitSetup: async (botId) => {
    if (steps.get(botId) !== "edit") return;
    running.get(botId)?.();
    discardChanges(botId);
    steps.delete(botId);
    bot(botId).editing = false;
    emitBots();
    push(botId, { type: "system", text: "Setup closed. Nothing changed." });
  },
  redoSetup: async (botId) => {
    if (running.has(botId)) throw new Error(BUSY);
    bot(botId).setupState = "pending";
    emitBots();
    enter(botId, "kind");
  },
  clearChat: async (botId) => {
    if (isTeam(botId)) {
      if (running.has(botId) || live.has(botId)) throw new Error(TEAM_BUSY);
      conversations.set(botId, []);
      team(botId).preview = "";
      clearedListeners.forEach((cb) => cb(botId));
      emitTeams();
      return;
    }
    if (running.has(botId)) throw new Error(BUSY);
    conversations.set(botId, []);
    bot(botId).preview = "";
    clearedListeners.forEach((cb) => cb(botId));
    if (bot(botId).setupState === "pending") enter(botId, "kind");
    if (steps.get(botId) === "edit") {
      steps.delete(botId);
      bot(botId).editing = false;
    }
    emitBots();
  },
  deleteBot: async (botId) => {
    if (running.has(botId)) throw new Error(BUSY);
    const teamId = bot(botId).teamId;
    leaveTeam(botId);
    if (teamId) emitTeams();
    bots.splice(bots.indexOf(bot(botId)), 1);
    conversations.delete(botId);
    steps.delete(botId);
    emitBots();
  },
  renameBot: async (botId, name) => {
    const b = bot(botId);
    if (!name.trim()) throw new Error("Bot name is required");
    if (name.trim().length > MAX_NAME) throw new Error(`Bot name can be at most ${MAX_NAME} characters`);
    b.name = name.trim();
    emitBots();
    return structuredClone(b);
  },
  updateBotConfig: async (botId, config: AgentConfig) => {
    const b = bot(botId);
    const old = b.config.schedule;
    if (config.schedule) {
      validateSchedule(config.schedule);
      const s = config.schedule;
      if (!old || old.date !== s.date || old.time !== s.time || old.monthly !== s.monthly) checkDate(s);
    }
    b.config = structuredClone(config);
    emitBots();
    return structuredClone(b);
  },
  runNow: async (botId) => {
    if (running.has(botId)) throw new Error(BUSY);
    const b = bot(botId);
    b.lastRunAt = Date.now();
    if (!b.config.schedule) throw new Error("This bot has no scheduled job.");
    const s = b.config.schedule;
    const job = s.everyMinutes !== null ? `Every ${describeEvery(s.everyMinutes)}` : s.date !== null ? "Scheduled task" : "Daily job";
    push(botId, { type: "system", text: `${job} · Run now` });
    reply(botId, `Here's today's result for: ${b.config.schedule?.task || b.config.description} (Browser mock)`, () => {
      if (viewing === botId) return;
      b.unread = true;
      emitBots();
    });
  },
  listTags: async () => sortedTags(),
  createTag: async (name, botId) => {
    const used = tags.map((t) => t.color);
    const color = TAG_COLORS.find((c) => !used.includes(c)) ?? TAG_COLORS[used.length % TAG_COLORS.length];
    const t: Tag = { id: crypto.randomUUID(), name: cleanTagName(name), color };
    if (botId) bot(botId);
    tags.push(t);
    emitTags();
    if (botId) {
      bot(botId).tags.push(t.id);
      emitBots();
    }
    return { ...t };
  },
  renameTag: async (tagId, name) => {
    tag(tagId).name = cleanTagName(name, tagId);
    emitTags();
  },
  setTagColor: async (tagId, color) => {
    if (!(TAG_COLORS as readonly string[]).includes(color)) throw new Error(`unknown tag color ${color}`);
    tag(tagId).color = color;
    emitTags();
  },
  deleteTag: async (tagId) => {
    tags.splice(tags.indexOf(tag(tagId)), 1);
    bots.forEach((b) => (b.tags = b.tags.filter((id) => id !== tagId)));
    emitTags();
    emitBots();
  },
  setBotTag: async (botId, tagId, on) => {
    const b = bot(botId);
    tag(tagId);
    if (on === b.tags.includes(tagId)) return;
    b.tags = on ? [...b.tags, tagId] : b.tags.filter((id) => id !== tagId);
    emitBots();
  },
  setViewing: async (botId) => {
    viewing = botId;
    if (botId && isTeam(botId)) {
      if (team(botId).unread) {
        team(botId).unread = false;
        emitTeams();
      }
      return;
    }
    if (botId && bot(botId).unread) {
      bot(botId).unread = false;
      emitBots();
    }
  },
  getAppSettings: async () => ({ ...appSettings }),
  updateAppSettings: async (settings) => {
    const defaultModel = settings.defaultModel.trim();
    if (!defaultModel) throw new Error("Choose a model");
    const codexModel = settings.codexModel?.trim() || null;
    appSettings = { ...settings, defaultModel, codexModel };
    settingsListeners.forEach((cb) => cb({ ...appSettings }));
    return { ...appSettings };
  },
  listTeams: async () => listTeams(),
  createTeam: async (input) => {
    const name = cleanTeamName(input.name);
    checkColor(input.color);
    const lead = teamBot(input.leadName, input.leadImage, input.purpose, input.instructions);
    // Check the existing bots before changing anything.
    for (const m of input.members) {
      if (m.botId) {
        const b = bot(m.botId);
        const other = b.teamId ? team(b.teamId) : null;
        if (other?.leadId === b.id) throw new Error(`${b.name} is ${other.name}'s orchestrator and can't move.`);
        if (other && live.has(other.id)) throw new Error(`${b.name} is working in ${other.name}. Wait for it to finish.`);
      } else if (!m.name.trim()) throw new Error("Bot name is required");
    }
    addBot(lead);
    const t: Team = {
      id: crypto.randomUUID(),
      name,
      purpose: input.purpose.trim(),
      color: input.color,
      leadId: lead.id,
      mode: input.mode,
      flow: { nodes: [], skipUnneeded: input.flow.skipUnneeded },
      collapsed: false,
      updatedAt: Date.now(),
      preview: "",
      unread: false,
      members: [],
      activity: null,
    };
    teams.push(t);
    conversations.set(t.id, []);
    lead.teamId = t.id;
    const ids = new Map<string, string>();
    for (const m of input.members) {
      if (m.botId) {
        joinTeam(t.id, m.botId, m.role.trim() ? m.role : null);
        ids.set(m.key, m.botId);
      } else {
        const b = teamBot(m.name, m.image ?? "bot01", m.role, "");
        addBot(b);
        joinTeam(t.id, b.id, m.role);
        ids.set(m.key, b.id);
      }
    }
    t.flow.nodes = structuredClone(input.flow.nodes).map((n) => ({ ...n, memberId: ids.get(n.memberId) ?? "" }));
    normalizeFlow(t);
    return teamChanged(t.id);
  },
  updateTeam: async (teamId, info) => {
    const t = team(teamId);
    const name = cleanTeamName(info.name);
    checkColor(info.color);
    Object.assign(t, { name, purpose: info.purpose.trim(), color: info.color, mode: info.mode, flow: structuredClone(info.flow) });
    normalizeFlow(t);
    return teamChanged(teamId);
  },
  setTeamCollapsed: async (teamId, collapsed) => {
    team(teamId).collapsed = collapsed;
    emitTeams();
  },
  addTeamMember: async (teamId, botId, role) => {
    team(teamId);
    const old = bot(botId).teamId;
    joinTeam(teamId, botId, role ?? null);
    if (old && old !== teamId) emitTeams();
    return teamChanged(teamId);
  },
  createTeamMember: async (teamId, name, image, role) => {
    team(teamId);
    const b = teamBot(name, image, role, "");
    addBot(b);
    joinTeam(teamId, b.id, role);
    teamChanged(teamId);
    return structuredClone(b);
  },
  setMemberRole: async (botId, role) => {
    bot(botId).teamRole = role.trim();
    emitBots();
  },
  removeTeamMember: async (teamId, botId) => {
    if (bot(botId).teamId !== teamId) throw new Error("This bot isn't in the team.");
    leaveTeam(botId);
    return teamChanged(teamId);
  },
  makeLead: async (teamId, botId) => {
    if (live.has(teamId)) throw new Error(TEAM_BUSY);
    const t = team(teamId);
    if (!t.members.includes(botId)) throw new Error("Only a member of the team can be its orchestrator.");
    t.members = [...t.members.filter((m) => m !== botId), t.leadId];
    t.leadId = botId;
    normalizeFlow(t);
    return teamChanged(teamId);
  },
  disbandTeam: async (teamId) => {
    if (live.has(teamId) || running.has(teamId)) throw new Error(TEAM_BUSY);
    const t = team(teamId);
    // The team chat moves to the orchestrator's chat.
    const lead = conversations.get(t.leadId) ?? [];
    conversations.set(t.leadId, [...lead, ...(conversations.get(teamId) ?? [])].sort((a, b) => a.createdAt - b.createdAt));
    conversations.delete(teamId);
    for (const b of bots) if (b.teamId === teamId) Object.assign(b, { teamId: null, teamRole: "" });
    teams.splice(teams.indexOf(t), 1);
    push(t.leadId, { type: "system", text: `${t.name} was disbanded. Its chat is above.` });
    clearedListeners.forEach((cb) => cb(teamId));
    emitBots();
    emitTeams();
  },
  sendTeamMessage: async (teamId, text, memberId) => {
    const clean = text.trim();
    if (!clean) throw new Error("Message is empty");
    const t = team(teamId);
    if (!memberId) {
      if (running.has(teamId) || live.has(teamId)) throw new Error(TEAM_BUSY);
      const message = push(teamId, { type: "user", text: clean });
      runTeam(teamId, clean);
      return structuredClone(message);
    }
    if (!t.members.includes(memberId)) throw new Error("That bot isn't a member of this team.");
    const member = bot(memberId);
    const ask = stripMention(clean, member.name);
    if (working(teamId, memberId)) {
      const message = push(teamId, { type: "user", text: clean });
      push(memberId, { type: "user", text: ask });
      const l = live.get(teamId)!;
      l.stepIns.set(memberId, [...(l.stepIns.get(memberId) ?? []), ask]);
      push(teamId, { type: "system", text: `${member.name} will use this in its current task` });
      return structuredClone(message);
    }
    if (running.has(memberId)) throw new Error(`${member.name} is busy. Wait for it to finish, or stop it.`);
    const message = push(teamId, { type: "user", text: clean });
    push(memberId, { type: "user", text: ask });
    runDirect(teamId, member, ask);
    return structuredClone(message);
  },
  pauseTeam: async (teamId, paused) => {
    const l = live.get(teamId);
    if (!l) throw new Error(NOT_RUNNING);
    l.paused = paused;
    saveCard(l);
    if (!paused) pump(l);
    emitTeams();
  },
  editTeamPlan: async (teamId, edits: PlanEdit[]) => {
    const l = live.get(teamId);
    if (!l) throw new Error(NOT_RUNNING);
    const t = team(teamId);
    for (const edit of edits) {
      const task = l.card.tasks.find((x) => x.id === edit.taskId);
      // Only tasks that haven't started can change.
      if (!task || task.status !== "waiting" || task.run > 0) continue;
      if (edit.remove) {
        l.card.tasks = l.card.tasks.filter((x) => x !== task);
        for (const other of l.card.tasks) other.after = other.after.filter((a) => a !== task.id);
        continue;
      }
      if (edit.title.trim()) task.title = edit.title.trim();
      if (edit.brief.trim()) task.brief = edit.brief.trim();
      if (edit.memberId && t.members.includes(edit.memberId)) {
        task.memberId = edit.memberId;
        task.memberName = bot(edit.memberId).name;
      }
    }
    pump(l);
    saveCard(l);
    emitTeams();
  },
  answerTeamTask: async (teamId, taskId, action: TaskAction) => {
    const l = live.get(teamId);
    if (!l) throw new Error(NOT_RUNNING);
    const task = l.card.tasks.find((x) => x.id === taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (action === "stop") return stopRun(l);
    if (action === "skip") {
      task.status = "skipped";
      task.detail = "Skipped";
    } else {
      task.status = "waiting";
      task.run = Math.max(0, task.run - 1);
    }
    pump(l);
    saveCard(l);
    emitTeams();
  },
  onTeams: (cb) => {
    teamListeners.add(cb);
    return () => teamListeners.delete(cb);
  },
  pickFolder: async () => prompt("Folder path (browser mock)") || null,
  onBots: (cb) => {
    botListeners.add(cb);
    return () => botListeners.delete(cb);
  },
  onTags: (cb) => {
    tagListeners.add(cb);
    return () => tagListeners.delete(cb);
  },
  onMessage: (cb) => {
    messageListeners.add(cb);
    return () => messageListeners.delete(cb);
  },
  onCleared: (cb) => {
    clearedListeners.add(cb);
    return () => clearedListeners.delete(cb);
  },
  onRun: (cb) => {
    runListeners.add(cb);
    return () => runListeners.delete(cb);
  },
  onClaudeStatus: () => () => {},
  onCodexStatus: () => () => {},
  onAppSettings: (cb) => {
    settingsListeners.add(cb);
    return () => settingsListeners.delete(cb);
  },
  onOpenSettings: () => () => {},
};
