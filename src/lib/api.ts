// The only place the UI talks to Rust. Commands live in
// src-tauri/src/commands.rs, events in src-tauri/src/events.rs.
//
// Outside Tauri (plain `npm run dev` in a browser) an in-memory mock backend
// is used, so the UI can be iterated on without a Rust build.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { mockBackend } from "./mockBackend";
import type {
  AgentConfig,
  Bot,
  BotIcon,
  ClaudeStatus,
  Control,
  Message,
  MessageEvent,
  RunEvent,
  SetupAnswer,
} from "./types";

export interface Backend {
  listBots(): Promise<Bot[]>;
  getMessages(botId: string): Promise<Message[]>;
  createBot(name: string, icon: BotIcon, color: string): Promise<Bot>;
  sendMessage(botId: string, text: string): Promise<Message>;
  setComputerControl(botId: string, messageId: string, control: Control): Promise<Message>;
  /** `refresh` skips the 10-minute cache ("Check again"). */
  claudeStatus(refresh: boolean): Promise<ClaudeStatus>;
  runningBots(): Promise<string[]>;
  cancelRun(botId: string): Promise<boolean>;
  ensureSetup(botId: string): Promise<void>;
  answerSetup(botId: string, messageId: string, answer: SetupAnswer): Promise<Message>;
  skipSetup(botId: string): Promise<void>;
  redoSetup(botId: string): Promise<void>;
  /** Deletes the bot's chat history; a bot still being set up starts setup over. */
  clearChat(botId: string): Promise<void>;
  /** Deletes the bot with its history and settings. */
  deleteBot(botId: string): Promise<void>;
  updateBotConfig(botId: string, config: AgentConfig): Promise<Bot>;
  runNow(botId: string): Promise<void>;
  /** Native folder picker; null when cancelled. */
  pickFolder(): Promise<string | null>;
  onBots(cb: (bots: Bot[]) => void): () => void;
  onMessage(cb: (e: MessageEvent) => void): () => void;
  /** A bot's chat history was cleared (`kbot://cleared`). */
  onCleared(cb: (botId: string) => void): () => void;
  onRun(cb: (e: RunEvent) => void): () => void;
  onClaudeStatus(cb: (status: ClaudeStatus) => void): () => void;
}

export const isTauri = "__TAURI_INTERNALS__" in window;

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  const unlisten = listen<T>(event, (e) => cb(e.payload));
  return () => void unlisten.then((off) => off());
}

const tauriBackend: Backend = {
  listBots: () => invoke("list_bots"),
  getMessages: (botId) => invoke("get_messages", { botId }),
  createBot: (name, icon, color) => invoke("create_bot", { name, icon, color }),
  sendMessage: (botId, text) => invoke("send_message", { botId, text }),
  setComputerControl: (botId, messageId, control) =>
    invoke("set_computer_control", { botId, messageId, control }),
  claudeStatus: (refresh) => invoke("claude_status", { refresh }),
  runningBots: () => invoke("running_bots"),
  cancelRun: (botId) => invoke("cancel_run", { botId }),
  ensureSetup: (botId) => invoke("ensure_setup", { botId }),
  answerSetup: (botId, messageId, answer) => invoke("answer_setup", { botId, messageId, answer }),
  skipSetup: (botId) => invoke("skip_setup", { botId }),
  redoSetup: (botId) => invoke("redo_setup", { botId }),
  clearChat: (botId) => invoke("clear_chat", { botId }),
  deleteBot: (botId) => invoke("delete_bot", { botId }),
  updateBotConfig: (botId, config) => invoke("update_bot_config", { botId, config }),
  runNow: (botId) => invoke("run_now", { botId }),
  pickFolder: async () => {
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  onBots: (cb) => subscribe("kbot://bots", cb),
  onMessage: (cb) => subscribe("kbot://message", cb),
  onCleared: (cb) => subscribe("kbot://cleared", cb),
  onRun: (cb) => subscribe("kbot://run", cb),
  onClaudeStatus: (cb) => subscribe("kbot://claude", cb),
};

export const backend: Backend = isTauri ? tauriBackend : mockBackend;

/** Error text from a rejected `invoke` (Rust returns `Err(String)`). */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
