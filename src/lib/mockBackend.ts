// Browser-only stand-in for the Rust backend (see api.ts). Mirrors the
// behaviour of src-tauri/src/{store,commands,agent}.rs closely enough for UI work.

import type { Backend } from "./api";
import type { Bot, Message, MessageBody, MessageEvent } from "./types";

const bots: Bot[] = [];
const conversations = new Map<string, Message[]>();
const botListeners = new Set<(bots: Bot[]) => void>();
const messageListeners = new Set<(e: MessageEvent) => void>();

function emit(botId: string, message: Message) {
  messageListeners.forEach((cb) => cb({ botId, message }));
  botListeners.forEach((cb) => cb([...bots]));
}

function push(botId: string, body: MessageBody): Message {
  const message = { ...body, id: crypto.randomUUID(), createdAt: Date.now() } as Message;
  conversations.get(botId)?.push(message);
  const bot = bots.find((b) => b.id === botId);
  if (bot) {
    bot.updatedAt = message.createdAt;
    if (body.type === "user" || body.type === "agent") bot.preview = body.text;
  }
  emit(botId, message);
  return message;
}

function agentReply(botId: string, text: string) {
  setTimeout(() => push(botId, { type: "agent", text }), 700);
}

export const mockBackend: Backend = {
  listBots: async () => [...bots],
  getMessages: async (botId) => [...(conversations.get(botId) ?? [])],
  createBot: async (name, icon, color) => {
    const bot: Bot = {
      id: crypto.randomUUID(),
      name: name.trim(),
      avatar: { kind: "icon", icon, color },
      pinned: false,
      updatedAt: Date.now(),
      preview: "",
    };
    bots.splice(bots.filter((b) => b.pinned).length, 0, bot);
    conversations.set(bot.id, []);
    botListeners.forEach((cb) => cb([...bots]));
    return bot;
  },
  sendMessage: async (botId, text) => {
    const message = push(botId, { type: "user", text: text.trim() });
    agentReply(botId, `On it: “${text.trim()}”. (Browser mock, run \`npm run tauri dev\` for Rust.)`);
    return message;
  },
  setComputerControl: async (botId, messageId, control) => {
    const message = conversations.get(botId)?.find((m) => m.id === messageId);
    if (!message || message.type !== "computer") throw new Error(`unknown message ${messageId}`);
    message.control = control;
    emit(botId, { ...message });
    if (control === "agent") agentReply(botId, "Thanks, I've got it from here. Looking through your accounts now.");
    return { ...message };
  },
  onBots: (cb) => {
    botListeners.add(cb);
    return () => botListeners.delete(cb);
  },
  onMessage: (cb) => {
    messageListeners.add(cb);
    return () => messageListeners.delete(cb);
  },
};
