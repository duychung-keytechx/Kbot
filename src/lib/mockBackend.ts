// Browser-only stand-in for the Rust backend (see api.ts). Mirrors the
// behaviour of src-tauri/src/{store,commands,agent,setup}.rs closely enough
// for UI work. `?claude=loggedOut` (or notInstalled / notSubscription) shows
// the Connect Claude screen.

import type { Backend } from "./api";
import {
  type AgentConfig,
  type AppSettings,
  type Bot,
  type ClaudeStatus,
  dateSchedule,
  DEFAULT_MODEL,
  DEFAULT_SCHEDULE,
  EMPTY_CONFIG,
  INTERVAL_SCHEDULE,
  MAX_EVERY,
  MIN_EVERY,
  type Message,
  type MessageBody,
  type MessageEvent,
  type PermissionAnswer,
  type RunEvent,
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
let appSettings: AppSettings = { defaultModel: DEFAULT_MODEL };
let viewing: string | null = null;

const wanted = new URLSearchParams(location.search).get("claude");
let claude: ClaudeStatus =
  wanted === "notInstalled" || wanted === "loggedOut"
    ? { state: wanted }
    : wanted === "notSubscription"
      ? { state: "notSubscription", authMethod: "api_key" }
      : { state: "ready", subscription: "max", email: "you@example.com" };

const bot = (botId: string) => {
  const b = bots.find((b) => b.id === botId);
  if (!b) throw new Error(`unknown bot ${botId}`);
  return b;
};
const emitBots = () => botListeners.forEach((cb) => cb(structuredClone(bots)));

function emit(botId: string, message: Message) {
  messageListeners.forEach((cb) => cb({ botId, message: { ...message } }));
  emitBots();
}

function push(botId: string, body: MessageBody): Message {
  const message = { ...body, id: crypto.randomUUID(), createdAt: Date.now() } as Message;
  conversations.get(botId)?.push(message);
  const b = bot(botId);
  b.updatedAt = message.createdAt;
  if (body.type === "user" || body.type === "agent") b.preview = body.text;
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
      bot(botId).preview = body.text;
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
  if (b.setupState !== "done") {
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
        const draft = structuredClone(config);
        draft.instructions = `${draft.instructions}\n\n${input}`;
        push(botId, { type: "setupReview", config: draft, confirmed: false, previous: structuredClone(config), discarded: false });
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
        finish(botId, true);
        break;
      }
      config.instructions = input.config.instructions;
      if (config.schedule && input.config.schedule) config.schedule.task = input.config.schedule.task;
      finish(botId);
      break;
  }
}

export const mockBackend: Backend = {
  listBots: async () => structuredClone(bots),
  getMessages: async (botId) => structuredClone(conversations.get(botId) ?? []),
  createBot: async (name, icon, color) => {
    const b: Bot = {
      id: crypto.randomUUID(),
      name: name.trim(),
      avatar: { kind: "icon", icon, color },
      pinned: false,
      updatedAt: Date.now(),
      preview: "",
      setupState: "pending",
      config: structuredClone(EMPTY_CONFIG),
      lastRunAt: null,
      editing: false,
      unread: false,
    };
    bots.splice(bots.filter((b) => b.pinned).length, 0, b);
    conversations.set(b.id, []);
    emitBots();
    enter(b.id, "kind");
    return structuredClone(b);
  },
  sendMessage: async (botId, text) => {
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
  claudeStatus: async () => {
    await new Promise((r) => setTimeout(r, 300));
    // "Check again" pretends the user signed in meanwhile.
    const status = claude;
    claude = { state: "ready", subscription: "max", email: "you@example.com" };
    return status;
  },
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
  startSetup: async (botId) => {
    if (running.has(botId)) throw new Error(BUSY);
    setupCommand(botId);
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
    bots.splice(bots.indexOf(bot(botId)), 1);
    conversations.delete(botId);
    steps.delete(botId);
    emitBots();
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
  setViewing: async (botId) => {
    viewing = botId;
    if (botId && bot(botId).unread) {
      bot(botId).unread = false;
      emitBots();
    }
  },
  getAppSettings: async () => ({ ...appSettings }),
  updateAppSettings: async (settings) => {
    const defaultModel = settings.defaultModel.trim();
    if (!defaultModel) throw new Error("Choose a model");
    appSettings = { defaultModel };
    return { ...appSettings };
  },
  pickFolder: async () => prompt("Folder path (browser mock)") || null,
  onBots: (cb) => {
    botListeners.add(cb);
    return () => botListeners.delete(cb);
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
  onOpenSettings: () => () => {},
};
