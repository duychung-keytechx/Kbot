import { useEffect, useState } from "react";
import { backend } from "./api";
import type { Bot, Message } from "./types";

export function useBots(): Bot[] {
  const [bots, setBots] = useState<Bot[]>([]);
  useEffect(() => {
    let alive = true;
    backend.listBots().then((b) => alive && setBots(b));
    const off = backend.onBots(setBots);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return bots;
}

/** Messages for one bot, kept live via `kbot://message` upserts. */
export function useMessages(botId: string | undefined): Message[] {
  const [messages, setMessages] = useState<Message[]>([]);
  useEffect(() => {
    setMessages([]);
    if (!botId) return;
    let alive = true;
    backend.getMessages(botId).then((m) => alive && setMessages(m));
    const off = backend.onMessage((e) => {
      if (e.botId !== botId) return;
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === e.message.id);
        if (i === -1) return [...prev, e.message];
        const next = [...prev];
        next[i] = e.message;
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [botId]);
  return messages;
}
