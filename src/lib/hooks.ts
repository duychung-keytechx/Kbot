import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "./api";
import type { AppSettings, Bot, ClaudeStatus, CodexStatus, Message } from "./types";

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

/** Whether the app window has focus. */
export function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  return focused;
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

/** A CLI's install/sign-in state; `undefined` until the first check or while `enabled` is false. */
interface CliStatus<T> {
  status: T | undefined;
  checking: boolean;
  /** Re-runs the check, skipping the cache ("Check again"). */
  check: () => void;
}

function useCliStatus<T extends { state: string }>(
  enabled: boolean,
  fetch: (refresh: boolean) => Promise<T>,
  subscribe: (cb: (status: T) => void) => () => void,
): CliStatus<T> {
  const [status, setStatus] = useState<T>();
  const [checking, setChecking] = useState(enabled);
  const load = useCallback(
    (refresh: boolean) => {
      setChecking(true);
      fetch(refresh)
        .then(setStatus)
        .finally(() => setChecking(false));
    },
    [fetch],
  );
  const ready = status?.state === "ready";
  const readyRef = useRef(ready);
  readyRef.current = ready;
  useEffect(() => {
    if (!enabled) return;
    load(false);
    const off = subscribe(setStatus);
    // Signing in happens in Terminal; look again when the user comes back.
    const onFocus = () => readyRef.current || load(true);
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, load, subscribe]);
  return { status: enabled ? status : undefined, checking, check: () => load(true) };
}

/** Claude Code's state (`claude auth status`). */
export function useClaudeStatus(enabled = true): CliStatus<ClaudeStatus> {
  return useCliStatus(enabled, backend.claudeStatus, backend.onClaudeStatus);
}

/** The Codex CLI's state (`codex login status`, or a model provider in its config). */
export function useCodexStatus(enabled = true): CliStatus<CodexStatus> {
  return useCliStatus(enabled, backend.codexStatus, backend.onCodexStatus);
}

/** Kbot > Settings…, kept live via `kbot://settings`; `undefined` until loaded. */
export function useAppSettings(): AppSettings | undefined {
  const [settings, setSettings] = useState<AppSettings>();
  useEffect(() => {
    let alive = true;
    backend
      .getAppSettings()
      .then((s) => alive && setSettings(s))
      .catch((e) => console.error(e));
    const off = backend.onAppSettings(setSettings);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return settings;
}
