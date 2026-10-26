// Browser-only stand-in for the Rust backend (see api.ts). Mirrors the
// behaviour of src-tauri/src/{store,commands,agent,setup}.rs closely enough
// for UI work. `?claude=loggedOut` (or notInstalled / notSubscription) shows
// the Connect Claude screen.

import type { Backend } from "./api";
import {
  type AgentConfig,
  type Bot,
  type ClaudeStatus,
  DEFAULT_SCHEDULE,
  EMPTY_CONFIG,
  type Message,
  type MessageBody,
  type MessageEvent,
  type RunEvent,
} from "./types";

type Step = "kind" | "description" | "schedule" | "web" | "workspace" | "clarify" | "review";

const CHAT = "Chat with me";
const DAILY = "Run a daily job";
const BUSY = "Wait for the current reply to finish, or stop it.";

const bots: Bot[] = [];
const conversations = new Map<string, Message[]>();
const steps = new Map<string, Step>();
const running = new Map<string, () => void>();
const botListeners = new Set<(bots: Bot[]) => void>();
const messageListeners = new Set<(e: MessageEvent) => void>();
const runListeners = new Set<(e: RunEvent) => void>();
const clearedListeners = new Set<(botId: string) => void>();

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
  emit(botId, message);
  return message;
}

function setRunning(botId: string, stop: (() => void) | null) {
  if (stop) running.set(botId, stop);
  else running.delete(botId);
  runListeners.forEach((cb) => cb({ botId, running: !!stop }));
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
        options: [CHAT, DAILY],
        selected: null,
      });
      break;
    case "description":
      push(botId, {
        type: "agent",
        text: config.schedule
          ? "Describe the job I should do each day.\n\nFor example: “Give me a morning brief of AI news and anything due today in my notes.”"
          : "Describe what I should do.\n\nFor example: “Help me write replies to customer emails in a friendly, professional tone.”",
      });
      break;
    case "schedule": {
      const s = config.schedule ?? DEFAULT_SCHEDULE;
      push(botId, { type: "setupSchedule", time: s.time, days: s.days, notify: s.notify, submitted: false });
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
      push(botId, { type: "setupReview", config: structuredClone(config), confirmed: false });
      break;
  }
}

function finish(botId: string) {
  const b = bot(botId);
  steps.delete(botId);
  b.setupState = "done";
  const s = b.config.schedule;
  push(botId, { type: "system", text: s ? `Setup complete · Next run: ${s.time}` : "Setup complete" });
}

function advance(botId: string, step: Step, input: string | Extract<Message, { type: `setup${string}` }>) {
  const { config } = bot(botId);
  if (typeof input === "string") {
    if (step === "description") {
      config.description = input;
      enter(botId, config.schedule ? "schedule" : "web");
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
        config.schedule = input.selected === DAILY ? { ...DEFAULT_SCHEDULE } : null;
        enter(botId, "description");
      } else {
        config.webAccess = input.selected === "Yes";
        enter(botId, "workspace");
      }
      break;
    case "setupSchedule":
      config.schedule = { ...(config.schedule ?? DEFAULT_SCHEDULE), time: input.time, days: input.days, notify: input.notify };
      enter(botId, "web");
      break;
    case "setupFolders":
      config.workspaceFolders = input.folders;
      think(botId, () => enter(botId, "clarify"));
      break;
    case "setupReview":
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
    if (bot(botId).setupState === "pending" && step) advance(botId, step, text.trim());
    else reply(botId, `On it: “${text.trim()}”. (Browser mock, run \`npm run tauri dev\` for Claude.)`);
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
        if (answer.days.length === 0) throw new Error("Pick at least one day");
        Object.assign(message, { time: answer.time, days: answer.days, notify: answer.notify, submitted: true });
        break;
      case "setupFolders":
        if (answer.type !== "folders" || message.submitted) throw new Error("This question was already answered.");
        Object.assign(message, { folders: answer.folders, submitted: true });
        break;
      case "setupReview":
        if (answer.type !== "review" || message.confirmed) throw new Error("This question was already answered.");
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
    push(botId, { type: "system", text: "Setup skipped. You can set me up any time from Settings." });
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
    emitBots();
  },
  updateBotConfig: async (botId, config: AgentConfig) => {
    if (config.schedule && config.schedule.days.length === 0) throw new Error("Pick at least one day");
    const b = bot(botId);
    b.config = structuredClone(config);
    emitBots();
    return structuredClone(b);
  },
  runNow: async (botId) => {
    if (running.has(botId)) throw new Error(BUSY);
    const b = bot(botId);
    b.lastRunAt = Date.now();
    push(botId, { type: "system", text: "Daily job · Run now" });
    reply(botId, `Here's today's result for: ${b.config.schedule?.task || b.config.description} (Browser mock)`);
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
};
