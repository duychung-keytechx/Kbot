import { useLayoutEffect, useRef } from "react";
import { backend } from "../lib/api";
import { useMessages } from "../lib/hooks";
import type { Bot, Message } from "../lib/types";
import { BotAvatar } from "./avatars/BotAvatar";
import { Composer } from "./Composer";
import { ComputerCard } from "./messages/ComputerCard";

export function ChatView({ bot }: { bot: Bot }) {
  const messages = useMessages(bot.id);
  const scroller = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-main">
      <header data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-main px-4">
        <BotAvatar avatar={bot.avatar} size={18} />
        <p data-tauri-drag-region className="truncate text-[13.5px] font-medium text-ink">
          {bot.name}
        </p>
        <div data-tauri-drag-region className="flex-1 self-stretch" />
      </header>

      <div ref={scroller} className="flex min-h-0 flex-1 flex-col items-start gap-3 overflow-y-auto px-6 pt-5 pb-4">
        {messages.length === 0 ? (
          <EmptyState bot={bot} />
        ) : (
          messages.map((m) => <MessageItem key={m.id} botId={bot.id} message={m} />)
        )}
      </div>

      <Composer key={bot.id} botName={bot.name} onSend={(text) => void backend.sendMessage(bot.id, text)} />
    </main>
  );
}

function MessageItem({ botId, message }: { botId: string; message: Message }) {
  switch (message.type) {
    case "user":
      return (
        <div className="flex justify-end self-stretch">
          <div className="rounded-2xl bg-ink-strong px-3.5 py-[11px]">
            <p className="selectable max-w-[400px] text-[14px] leading-[21px] break-words whitespace-pre-wrap text-white">
              {message.text}
            </p>
          </div>
        </div>
      );
    case "system":
      return (
        <div className="flex justify-center self-stretch py-1.5">
          <p className="text-[12.5px] text-hint">{message.text}</p>
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
  }
}

function EmptyState({ bot }: { bot: Bot }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 self-stretch pb-10">
      <BotAvatar avatar={bot.avatar} size={52} />
      <p className="text-[14px] text-hint">Say hello to {bot.name}</p>
    </div>
  );
}
