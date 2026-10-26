import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { backend, errorText } from "../lib/api";
import { formatListTime } from "../lib/format";
import type { Bot } from "../lib/types";
import { BotAvatar } from "./avatars/BotAvatar";
import { secondaryButton } from "./fields";
import { ClockIcon, MoreIcon, PlusIcon, SearchIcon } from "./Icons";
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
  // Where the "⋯" menu opens, in viewport coordinates; unset while closed.
  const [menuAt, setMenuAt] = useState<{ top: number; right: number }>();
  const row = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const toggleMenu = () => {
    if (menuAt || !row.current) return setMenuAt(undefined);
    // Measured on the row, which is always laid out (the button is hidden until hover).
    const r = row.current.getBoundingClientRect();
    // Below the button, or above the row near the bottom of the window so the confirmation fits.
    const top = r.top + 194 > window.innerHeight ? r.top - 154 : r.top + 34;
    setMenuAt({ top, right: window.innerWidth - r.right + 6 });
  };
  return (
    <div ref={row} className="group relative shrink-0">
      <button
        type="button"
        onClick={onClick}
        aria-current={active || undefined}
        className={`flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left ${
          active ? "bg-row-active" : "hover:bg-row-hover"
        }`}
      >
        <BotAvatar avatar={bot.avatar} size={30} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <p className="min-w-0 truncate text-[14px] text-ink">{bot.name}</p>
            {bot.config.schedule && (
              <span title={`Daily job at ${bot.config.schedule.time}`}>
                <ClockIcon />
              </span>
            )}
            <div className="flex-1" />
            {/* The "⋯" button takes the time's place on hover. */}
            <p
              className={`shrink-0 text-[12px] text-muted ${
                menuAt ? "invisible" : "group-focus-within:invisible group-hover:invisible"
              }`}
            >
              {formatListTime(bot.updatedAt)}
            </p>
          </div>
          <p className="truncate text-[12.5px] text-subtle">{bot.preview || "No messages yet"}</p>
        </div>
      </button>
      <button
        type="button"
        aria-label={`More options for ${bot.name}`}
        title="More"
        aria-haspopup="menu"
        aria-expanded={!!menuAt}
        ref={more}
        onClick={toggleMenu}
        className={`absolute top-[9px] right-1.5 h-5 items-center rounded-[6px] px-1 hover:bg-black/5 ${
          menuAt ? "flex bg-black/5" : "hidden group-focus-within:flex group-hover:flex"
        }`}
      >
        <MoreIcon />
      </button>
      {menuAt && <BotMenu bot={bot} at={menuAt} anchor={more} onClose={() => setMenuAt(undefined)} />}
    </div>
  );
}

/** The sidebar row's "⋯" menu. Clearing the chat asks for confirmation first. */
function BotMenu({
  bot,
  at,
  anchor,
  onClose,
}: {
  bot: Bot;
  at: { top: number; right: number };
  /** The "⋯" button, which toggles the menu itself. */
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Close on a click elsewhere, Escape, or scrolling the list (the menu is fixed).
  useEffect(() => {
    const inside = (e: Event) => [ref.current, anchor.current].some((el) => el?.contains(e.target as Node));
    const onDown = (e: MouseEvent) => inside(e) || onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onScroll = (e: Event) => ref.current?.contains(e.target as Node) || onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor, onClose]);

  const clear = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await backend.clearChat(bot.id);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${bot.name} options`}
      style={{ top: at.top, right: at.right }}
      className="fixed z-20 w-[230px] rounded-[10px] border border-modal-line bg-white p-1 shadow-[0_6px_24px_rgb(0_0_0/0.12)]"
    >
      {confirming ? (
        <div className="flex flex-col gap-2.5 p-2">
          <p className="text-[13px] leading-[19px] text-ink">
            {`Clear all messages with ${bot.name}? This can't be undone.`}
          </p>
          {error && <p className="text-[12px] leading-[17px] text-[#c4321c]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={secondaryButton}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void clear()}
              className="rounded-[15px] bg-[#c4321c] px-[13px] py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          role="menuitem"
          autoFocus
          onClick={() => setConfirming(true)}
          className="w-full rounded-[7px] px-2.5 py-1.5 text-left text-[13px] text-ink outline-none hover:bg-row-hover focus-visible:bg-row-hover"
        >
          Clear chat history
        </button>
      )}
    </div>
  );
}
