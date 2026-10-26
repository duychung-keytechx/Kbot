// The only place the UI talks to Rust. Commands live in
// src-tauri/src/commands.rs, events in src-tauri/src/events.rs.
//
// Outside Tauri (plain `npm run dev` in a browser) an in-memory mock backend
// is used, so the UI can be iterated on without a Rust build.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { mockBackend } from "./mockBackend";
import type { Bot, BotIcon, Control, Message, MessageEvent } from "./types";

export interface Backend {
  listBots(): Promise<Bot[]>;
  getMessages(botId: string): Promise<Message[]>;
  createBot(name: string, icon: BotIcon, color: string): Promise<Bot>;
  sendMessage(botId: string, text: string): Promise<Message>;
  setComputerControl(botId: string, messageId: string, control: Control): Promise<Message>;
  onBots(cb: (bots: Bot[]) => void): () => void;
  onMessage(cb: (e: MessageEvent) => void): () => void;
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
  onBots: (cb) => subscribe("kbot://bots", cb),
  onMessage: (cb) => subscribe("kbot://message", cb),
};

export const backend: Backend = isTauri ? tauriBackend : mockBackend;
