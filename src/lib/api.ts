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
  AppSettings,
  Bot,
  BotImage,
  ClaudeStatus,
  CodexModels,
  CodexStatus,
  Control,
  Message,
  MessageEvent,
  PermissionAnswer,
  RunEvent,
  SetupAnswer,
  Tag,
} from "./types";

export interface Backend {
  listBots(): Promise<Bot[]>;
  getMessages(botId: string): Promise<Message[]>;
  createBot(name: string, image: BotImage): Promise<Bot>;
  sendMessage(botId: string, text: string): Promise<Message>;
  setComputerControl(botId: string, messageId: string, control: Control): Promise<Message>;
  answerPermission(botId: string, messageId: string, answer: PermissionAnswer): Promise<Message>;
  /** `refresh` skips the 10-minute cache ("Check again"). */
  claudeStatus(refresh: boolean): Promise<ClaudeStatus>;
  /** Like `claudeStatus`, for the Codex CLI. */
  codexStatus(refresh: boolean): Promise<CodexStatus>;
  codexModels(): Promise<CodexModels>;
  runningBots(): Promise<string[]>;
  cancelRun(botId: string): Promise<boolean>;
  ensureSetup(botId: string): Promise<void>;
  answerSetup(botId: string, messageId: string, answer: SetupAnswer): Promise<Message>;
  skipSetup(botId: string): Promise<void>;
  /** Leaves `/setup` on a set-up bot without saving. */
  exitSetup(botId: string): Promise<void>;
  redoSetup(botId: string): Promise<void>;
  /** Deletes the bot's chat history; a bot still being set up starts setup over. */
  clearChat(botId: string): Promise<void>;
  /** Deletes the bot with its history and settings. */
  deleteBot(botId: string): Promise<void>;
  updateBotConfig(botId: string, config: AgentConfig): Promise<Bot>;
  renameBot(botId: string, name: string): Promise<Bot>;
  runNow(botId: string): Promise<void>;
  listTags(): Promise<Tag[]>;
  /** With `botId`, the new tag also goes on that bot. */
  createTag(name: string, botId?: string): Promise<Tag>;
  renameTag(tagId: string, name: string): Promise<void>;
  setTagColor(tagId: string, color: string): Promise<void>;
  /** Deletes the tag and takes it off every bot. */
  deleteTag(tagId: string): Promise<void>;
  setBotTag(botId: string, tagId: string, on: boolean): Promise<void>;
  /** The chat on screen while the window is focused, else null; it is marked read. */
  setViewing(botId: string | null): Promise<void>;
  getAppSettings(): Promise<AppSettings>;
  updateAppSettings(settings: AppSettings): Promise<AppSettings>;
  /** Native folder picker; null when cancelled. */
  pickFolder(): Promise<string | null>;
  onBots(cb: (bots: Bot[]) => void): () => void;
  /** All tags, after one is added, renamed, recolored or deleted (`kbot://tags`). */
  onTags(cb: (tags: Tag[]) => void): () => void;
  onMessage(cb: (e: MessageEvent) => void): () => void;
  /** A bot's chat history was cleared (`kbot://cleared`). */
  onCleared(cb: (botId: string) => void): () => void;
  onRun(cb: (e: RunEvent) => void): () => void;
  onClaudeStatus(cb: (status: ClaudeStatus) => void): () => void;
  onCodexStatus(cb: (status: CodexStatus) => void): () => void;
  /** Kbot > Settings… were saved (`kbot://settings`). */
  onAppSettings(cb: (settings: AppSettings) => void): () => void;
  /** Kbot > Settings… in the macOS menu bar (`kbot://open-settings`). */
  onOpenSettings(cb: () => void): () => void;
}

export const isTauri = "__TAURI_INTERNALS__" in window;

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  const unlisten = listen<T>(event, (e) => cb(e.payload));
  return () => void unlisten.then((off) => off());
}

const tauriBackend: Backend = {
  listBots: () => invoke("list_bots"),
  getMessages: (botId) => invoke("get_messages", { botId }),
  createBot: (name, image) => invoke("create_bot", { name, image }),
  sendMessage: (botId, text) => invoke("send_message", { botId, text }),
  setComputerControl: (botId, messageId, control) =>
    invoke("set_computer_control", { botId, messageId, control }),
  answerPermission: (botId, messageId, answer) => invoke("answer_permission", { botId, messageId, answer }),
  claudeStatus: (refresh) => invoke("claude_status", { refresh }),
  codexStatus: (refresh) => invoke("codex_status", { refresh }),
  codexModels: () => invoke("codex_models"),
  runningBots: () => invoke("running_bots"),
  cancelRun: (botId) => invoke("cancel_run", { botId }),
  ensureSetup: (botId) => invoke("ensure_setup", { botId }),
  answerSetup: (botId, messageId, answer) => invoke("answer_setup", { botId, messageId, answer }),
  skipSetup: (botId) => invoke("skip_setup", { botId }),
  exitSetup: (botId) => invoke("exit_setup", { botId }),
  redoSetup: (botId) => invoke("redo_setup", { botId }),
  clearChat: (botId) => invoke("clear_chat", { botId }),
  deleteBot: (botId) => invoke("delete_bot", { botId }),
  updateBotConfig: (botId, config) => invoke("update_bot_config", { botId, config }),
  renameBot: (botId, name) => invoke("rename_bot", { botId, name }),
  runNow: (botId) => invoke("run_now", { botId }),
  listTags: () => invoke("list_tags"),
  createTag: (name, botId) => invoke("create_tag", { name, botId: botId ?? null }),
  renameTag: (tagId, name) => invoke("rename_tag", { tagId, name }),
  setTagColor: (tagId, color) => invoke("set_tag_color", { tagId, color }),
  deleteTag: (tagId) => invoke("delete_tag", { tagId }),
  setBotTag: (botId, tagId, on) => invoke("set_bot_tag", { botId, tagId, on }),
  setViewing: (botId) => invoke("set_viewing", { botId }),
  getAppSettings: () => invoke("get_app_settings"),
  updateAppSettings: (settings) => invoke("update_app_settings", { settings }),
  pickFolder: async () => {
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  },
  onBots: (cb) => subscribe("kbot://bots", cb),
  onTags: (cb) => subscribe("kbot://tags", cb),
  onMessage: (cb) => subscribe("kbot://message", cb),
  onCleared: (cb) => subscribe("kbot://cleared", cb),
  onRun: (cb) => subscribe("kbot://run", cb),
  onClaudeStatus: (cb) => subscribe("kbot://claude", cb),
  onCodexStatus: (cb) => subscribe("kbot://codex", cb),
  onAppSettings: (cb) => subscribe("kbot://settings", cb),
  onOpenSettings: (cb) => subscribe("kbot://open-settings", cb),
};

export const backend: Backend = isTauri ? tauriBackend : mockBackend;

/** Error text from a rejected `invoke` (Rust returns `Err(String)`). */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
