import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { backend, errorText } from "../lib/api";
import { useMessages, useTags } from "../lib/hooks";
import type { Bot, Message } from "../lib/types";
import { BotAvatar } from "./avatars/BotAvatar";
import { Composer, type CommandName } from "./Composer";
import { ClearHistoryDialog, DeleteBotDialog } from "./ConfirmDialog";
import { secondaryButton } from "./fields";
import { ComputerCard } from "./messages/ComputerCard";
import { PermissionCard } from "./messages/PermissionCard";
import {
  SetupChoiceCard,
  SetupCurrentCard,
  SetupFoldersCard,
  SetupReviewCard,
  SetupScheduleCard,
} from "./messages/SetupCards";
import { SettingsPanel } from "./SettingsPanel";
import { TagPills, tagsOf } from "./tags";

export function ChatView({ bot, running }: { bot: Bot; running: boolean }) {
  const messages = useMessages(bot.id);
  const tags = useTags();
  const scroller = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState<"clear-history" | "delete">();
  const onboarding = bot.setupState === "pending";
  const inSetup = onboarding || bot.editing;
  // The run is paused on a question or approval card, not working.
  const waiting = messages.some((m) => m.type === "permission" && m.status === "pending");
  // Only a task on a date gets "Run now" here; other jobs have it in Settings.
  const isTask = !inSetup && bot.config.schedule?.date != null;

  // A new bot greets the user and starts asking how to set it up.
  useEffect(() => {
    if (inSetup) backend.ensureSetup(bot.id).catch((e) => setError(errorText(e)));
  }, [bot.id, inSetup]);

  useEffect(() => {
    setSettingsOpen(false);
    setError(undefined);
    setDialog(undefined);
  }, [bot.id]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, running]);

  const send = async (text: string) => {
    setError(undefined);
    try {
      await backend.sendMessage(bot.id, text);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };

  // /setup is handled by the backend like any message; the rest ask first, as in the sidebar menu.
  const runCommand = (name: CommandName) => (name === "setup" ? send("/setup") : setDialog(name));

  return (
    <div className="flex min-w-0 flex-1">
      <main className="flex min-w-0 flex-1 flex-col bg-main">
        <header data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-main px-4">
          <button
            type="button"
            title="Settings"
            onClick={() => setSettingsOpen((o) => !o)}
            className="-ml-1.5 flex min-w-0 items-center gap-2 rounded-[8px] px-1.5 py-1 hover:bg-row-hover"
          >
            <BotAvatar avatar={bot.avatar} size={18} />
            <p className="truncate text-[13.5px] font-semibold text-ink">{bot.name}</p>
          </button>
          <TagPills tags={tagsOf(bot.tags, tags)} max={5} />
          <div data-tauri-drag-region className="flex-1 self-stretch" />
          {isTask && (
            <button
              type="button"
              disabled={running}
              title="Do the scheduled task now"
              onClick={() => {
                setError(undefined);
                backend.runNow(bot.id).catch((e) => setError(errorText(e)));
              }}
              className={secondaryButton}
            >
              Run now
            </button>
          )}
        </header>

        <div ref={scroller} className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-y-auto px-6 pt-5 pb-4">
          {messages.length === 0 && !running ? (
            <EmptyState bot={bot} />
          ) : (
            messages.map((m) => <MessageItem key={m.id} botId={bot.id} message={m} />)
          )}
          {running && !waiting && <Typing />}
        </div>

        {(inSetup || error) && (
          <div className="flex items-center gap-3 px-6">
            {error && <p className="min-w-0 flex-1 text-[12.5px] text-danger">{error}</p>}
            {inSetup && (
              <button
                type="button"
                onClick={() =>
                  (onboarding ? backend.skipSetup(bot.id) : backend.exitSetup(bot.id)).catch((e) => setError(errorText(e)))
                }
                className="ml-auto shrink-0 text-[12.5px] text-subtle underline"
              >
                {onboarding ? "Skip setup" : "Exit setup"}
              </button>
            )}
          </div>
        )}

        <Composer
          key={bot.id}
          botName={bot.name}
          running={running}
          onSend={send}
          onStop={() => void backend.cancelRun(bot.id)}
          onCommand={runCommand}
        />
      </main>
      {dialog === "clear-history" && <ClearHistoryDialog bot={bot} onClose={() => setDialog(undefined)} />}
      {dialog === "delete" && <DeleteBotDialog bot={bot} onClose={() => setDialog(undefined)} />}
      {settingsOpen && <SettingsPanel bot={bot} running={running} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function MessageItem({ botId, message }: { botId: string; message: Message }) {
  switch (message.type) {
    case "user":
      return (
        <div className="flex justify-end self-stretch">
          <div className="rounded-2xl bg-user-bubble px-3.5 py-[11px]">
            <p className="selectable max-w-[400px] text-[14px] leading-[21px] break-words whitespace-pre-wrap text-white">
              {message.text}
            </p>
          </div>
        </div>
      );
    case "system":
      return (
        <div className="flex justify-center self-stretch py-1.5">
          <p className="selectable max-w-[530px] text-center text-[12.5px] text-hint">{message.text}</p>
        </div>
      );
    case "agent":
      return (
        <div className="rounded-2xl bg-bubble px-3.5 py-[11px]">
          <p className="selectable max-w-[530px] text-[14px] leading-[21px] break-words whitespace-pre-wrap text-ink">
            {message.text}
          </p>
        </div>
      );
    case "computer":
      return (
        <ComputerCard
          prompt={message.prompt}
          control={message.control}
          onControl={(control) => void backend.setComputerControl(botId, message.id, control)}
        />
      );
    case "setupChoice":
      return <SetupChoiceCard botId={botId} message={message} />;
    case "setupSchedule":
      return <SetupScheduleCard botId={botId} message={message} />;
    case "setupFolders":
      return <SetupFoldersCard botId={botId} message={message} />;
    case "setupReview":
      return <SetupReviewCard botId={botId} message={message} />;
    case "setupCurrent":
      return <SetupCurrentCard config={message.config} />;
    case "permission":
      return <PermissionCard botId={botId} message={message} />;
  }
}

/** Shown while the bot is busy (`kbot://run`). */
function Typing() {
  return (
    <div data-testid="typing" aria-label="Working" className="flex gap-1 rounded-2xl bg-bubble px-3.5 py-[15px]">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-[6px] animate-bounce rounded-full bg-hint"
          style={{ animationDelay: `${delay}ms`, animationDuration: "1s" }}
        />
      ))}
    </div>
  );
}

function EmptyState({ bot }: { bot: Bot }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 self-stretch pb-10">
      <BotAvatar avatar={bot.avatar} size={52} />
      <p className="text-[14px] text-hint">Say hello to {bot.name}</p>
    </div>
  );
}
