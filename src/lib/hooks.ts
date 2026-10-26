import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "./api";
import type { Bot, ClaudeStatus, Message } from "./types";

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

/** Messages for one bot, kept live via `kbot://message` upserts and `kbot://cleared`. */
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
    const offCleared = backend.onCleared((id) => id === botId && setMessages([]));
    return () => {
      alive = false;
      off();
      offCleared();
    };
  }, [botId]);
  return messages;
}

/** Ids of bots with a reply, daily job or setup step in progress (`kbot://run`). */
export function useRunning(): Set<string> {
  const [running, setRunning] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const off = backend.onRun(({ botId, running }) =>
      setRunning((prev) => {
        const next = new Set(prev);
        if (running) next.add(botId);
        else next.delete(botId);
        return next;
      }),
    );
    backend.runningBots().then((ids) => alive && setRunning(new Set(ids)));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return running;
}

/**
 * Claude Code's install/sign-in state; `undefined` until the first check.
 * `check()` re-runs `claude auth status` ("Check again").
 */
export function useClaudeStatus(): { status: ClaudeStatus | undefined; checking: boolean; check: () => void } {
  const [status, setStatus] = useState<ClaudeStatus>();
  const [checking, setChecking] = useState(true);
  const load = useCallback((refresh: boolean) => {
    setChecking(true);
    backend
      .claudeStatus(refresh)
      .then(setStatus)
      .finally(() => setChecking(false));
  }, []);
  const ready = status?.state === "ready";
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useEffect(() => {
    load(false);
    const off = backend.onClaudeStatus(setStatus);
    // Signing in happens in Terminal; look again when the user comes back.
    const onFocus = () => readyRef.current || load(true);
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);
  return { status, checking, check: () => load(true) };
}
