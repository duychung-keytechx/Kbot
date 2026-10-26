import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import mark from "../assets/kbot-mark.png";
import wordmark from "../assets/kbot-wordmark.png";
import { backend } from "../lib/api";
import { formatListTime } from "../lib/format";
import type { Bot } from "../lib/types";
import { BotAvatar } from "./avatars/BotAvatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { describeSchedule } from "./fields";
import { ClearIcon, ClockIcon, EditIcon, PlusIcon, SearchIcon, SpinnerIcon, TrashIcon } from "./Icons";
import { WindowControls } from "./WindowControls";

export function Sidebar({
  bots,
  running,
  selectedId,
  onSelect,
  onNewBot,
}: {
  bots: Bot[];
  /** Bots with a reply or job in progress; their "Edit" is disabled. */
  running: Set<string>;
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
        {/* Ignores the pointer so the title bar stays draggable. */}
        <div className="pointer-events-none ml-1 flex items-center gap-1">
          <img src={mark} alt="" draggable={false} className="h-[17px] w-auto" />
          <img src={wordmark} alt="Kbot" draggable={false} className="h-[13px] w-auto" />
        </div>
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
          <BotRow
            key={bot.id}
            bot={bot}
            active={bot.id === selectedId}
            busy={running.has(bot.id)}
            onClick={() => onSelect(bot.id)}
          />
        ))}
      </nav>
    </aside>
  );
}

function BotRow({ bot, active, busy, onClick }: { bot: Bot; active: boolean; busy: boolean; onClick: () => void }) {
  // Right-click opens the context menu at the pointer.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  const [confirm, setConfirm] = useState<"clear" | "delete">();
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        aria-current={active || undefined}
        className={`flex w-full shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left ${
          active ? "bg-row-active" : menuAt ? "bg-row-hover" : "hover:bg-row-hover"
        }`}
      >
        <BotAvatar avatar={bot.avatar} size={30} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <p className="min-w-0 truncate text-[14px] text-ink">{bot.name}</p>
            {bot.config.schedule && (
              <span title={`Runs ${describeSchedule(bot.config.schedule)}`}>
                <ClockIcon />
              </span>
            )}
            <div className="flex-1" />
            <p className="shrink-0 text-[12px] text-muted">{formatListTime(bot.updatedAt)}</p>
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            {busy && (
              <span data-testid="bot-working" title="Working" className="flex shrink-0">
                <SpinnerIcon className="animate-[spin_2.4s_linear_infinite]" />
              </span>
            )}
            <p className="truncate text-[12.5px] text-subtle">{bot.preview || (busy ? "Working…" : "No messages yet")}</p>
          </div>
        </div>
      </button>
      {menuAt && (
        <ContextMenu
          at={menuAt}
          label={`${bot.name} options`}
          onClose={() => setMenuAt(undefined)}
          items={[
            {
              label: "Edit",
              icon: <EditIcon />,
              disabled: busy,
              // Opens the chat, where the setup is shown and changed as with `/setup`.
              onSelect: () => {
                onClick();
                backend.startSetup(bot.id).catch((e) => console.error(e));
              },
            },
            { label: "Clear History", icon: <ClearIcon />, onSelect: () => setConfirm("clear") },
            { label: "Delete Chat", icon: <TrashIcon />, danger: true, onSelect: () => setConfirm("delete") },
          ]}
        />
      )}
      {confirm === "clear" && (
        <ConfirmDialog
          title="Clear History"
          message={`Delete all messages with ${bot.name}? Its settings are kept. This can't be undone.`}
          confirmLabel="Clear History"
          onConfirm={() => backend.clearChat(bot.id)}
          onClose={() => setConfirm(undefined)}
        />
      )}
      {confirm === "delete" && (
        <ConfirmDialog
          title="Delete Chat"
          message={`Delete ${bot.name} with its messages and settings? This can't be undone.`}
          confirmLabel="Delete"
          onConfirm={() => backend.deleteBot(bot.id)}
          onClose={() => setConfirm(undefined)}
        />
      )}
    </>
  );
}

type MenuItem = { label: string; icon: ReactNode; danger?: boolean; disabled?: boolean; onSelect: () => void };

/** A right-click menu at the pointer, kept inside the window. Closes on a click elsewhere, Escape or scroll. */
function ContextMenu({
  at,
  label,
  items,
  onClose,
}: {
  at: { x: number; y: number };
  label: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  // Flip left/up when the menu would run off the window.
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({
      x: at.x + r.width + 8 > window.innerWidth ? Math.max(8, at.x - r.width) : at.x,
      y: at.y + r.height + 8 > window.innerHeight ? Math.max(8, at.y - r.height) : at.y,
    });
  }, [at]);

  useEffect(() => {
    const outside = (e: Event) => ref.current?.contains(e.target as Node) || onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Next tick, so the right-click that opened the menu doesn't also close it.
    const id = setTimeout(() => {
      document.addEventListener("mousedown", outside);
      document.addEventListener("contextmenu", outside);
      document.addEventListener("scroll", outside, true);
      document.addEventListener("keydown", onKey);
      window.addEventListener("blur", onClose);
    });
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("contextmenu", outside);
      document.removeEventListener("scroll", outside, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-40 flex w-[200px] flex-col rounded-[10px] border border-modal-line bg-white/95 p-1 shadow-[0_8px_28px_rgb(0_0_0/0.14)] backdrop-blur"
    >
      {items.map((item, i) => (
        <Fragment key={item.label}>
          {/* Destructive items sit below a divider, as in macOS menus. */}
          {item.danger && i > 0 && <div className="mx-2 my-1 h-px bg-divider" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            autoFocus={i === 0}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`flex items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-left text-[13.5px] outline-none enabled:hover:bg-row-hover focus-visible:bg-row-hover disabled:opacity-40 ${
              item.danger ? "text-[#e5322d]" : "text-ink"
            }`}
          >
            <span className="flex w-4 justify-center">{item.icon}</span>
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
