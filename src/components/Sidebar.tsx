import { useMemo, useState } from "react";
import { formatListTime } from "../lib/format";
import type { Bot } from "../lib/types";
import { BotAvatar } from "./avatars/BotAvatar";
import { PlusIcon, SearchIcon } from "./Icons";
import { WindowControls } from "./WindowControls";

export function Sidebar({
  bots,
  selectedId,
  onSelect,
  onNewBot,
}: {
  bots: Bot[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onNewBot: () => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bots;
    return bots.filter((b) => b.name.toLowerCase().includes(q) || b.preview.toLowerCase().includes(q));
  }, [bots, query]);

  return (
    <aside className="flex w-[290px] shrink-0 flex-col gap-3 border-r border-sidebar-line bg-sidebar pt-4 pr-3.5 pb-3.5 pl-3.5">
      <div data-tauri-drag-region className="flex items-center gap-2 px-1">
        <WindowControls />
        <p data-tauri-drag-region className="text-[13px] font-semibold text-placeholder">
          Kbot
        </p>
        <div data-tauri-drag-region className="h-2.5 flex-1" />
        <button type="button" aria-label="New bot" title="New bot" onClick={onNewBot} className="flex shrink-0">
          <PlusIcon />
        </button>
      </div>

      <label className="flex items-center gap-2 rounded-lg border border-field-line bg-white px-2.5 py-[7px]">
        <SearchIcon />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          spellCheck={false}
          className="min-w-0 flex-1 text-[13px] leading-[normal] text-ink placeholder:text-hint"
        />
      </label>

      <nav className="-mr-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-2">
        {visible.map((bot) => (
          <BotRow key={bot.id} bot={bot} active={bot.id === selectedId} onClick={() => onSelect(bot.id)} />
        ))}
      </nav>
    </aside>
  );
}

function BotRow({ bot, active, onClick }: { bot: Bot; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active || undefined}
      className={`flex w-full shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left ${
        active ? "bg-row-active" : "hover:bg-row-hover"
      }`}
    >
      <BotAvatar avatar={bot.avatar} size={30} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <p className="min-w-0 flex-1 truncate text-[14px] text-ink">{bot.name}</p>
          <p className="shrink-0 text-[12px] text-muted">{formatListTime(bot.updatedAt)}</p>
        </div>
        <p className="truncate text-[12.5px] text-subtle">{bot.preview || "No messages yet"}</p>
      </div>
    </button>
  );
}
