import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import logo from "../assets/kbot-logo.png";
import { backend } from "../lib/api";
import { formatListTime } from "../lib/format";
import { useTags } from "../lib/hooks";
import type { Bot, Tag } from "../lib/types";
import { BotAvatar } from "./avatars/BotAvatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { EditBotDialog } from "./EditBotDialog";
import { describeSchedule } from "./fields";
import { ClearIcon, ClockIcon, EditIcon, PlusIcon, SearchIcon, SpinnerIcon, TrashIcon } from "./Icons";
import { TagLabels, tagStyle, tagsOf } from "./tags";
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
  const tags = useTags();
  const [query, setQuery] = useState("");
  // The tag chip picked under Search; forgotten if the tag is deleted.
  const [tagId, setTagId] = useState<string>();
  const filter = tags.find((t) => t.id === tagId);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const names = new Map(tags.map((t) => [t.id, t.name.toLowerCase()]));
    return bots.filter(
      (b) =>
        (!filter || b.tags.includes(filter.id)) &&
        (!q ||
          b.name.toLowerCase().includes(q) ||
          b.preview.toLowerCase().includes(q) ||
          b.tags.some((id) => names.get(id)?.includes(q))),
    );
  }, [bots, tags, query, filter]);

  const [width, setWidth] = useSidebarWidth();

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col gap-3 border-r border-sidebar-line bg-sidebar pt-4 pr-3.5 pb-3.5 pl-3.5"
    >
      <ResizeHandle width={width} onResize={setWidth} />
      <div data-tauri-drag-region className="flex items-center gap-2 px-1">
        <WindowControls />
        {/* Ignores the pointer so the title bar stays draggable. */}
        <div className="pointer-events-none ml-1 flex items-center gap-1">
          <img src={logo} alt="" draggable={false} className="h-[18px] w-auto" />
          <p className="text-[14px] font-semibold text-ink-strong">Kbot</p>
        </div>
        <div data-tauri-drag-region className="h-2.5 flex-1" />
        <button type="button" aria-label="New bot" title="New bot" onClick={onNewBot} className="flex shrink-0">
          <PlusIcon />
        </button>
      </div>

      <label className="flex items-center gap-2 rounded-lg border border-field-line bg-surface px-2.5 py-[7px]">
        <SearchIcon />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          spellCheck={false}
          className="min-w-0 flex-1 text-[13px] leading-[normal] text-ink placeholder:text-hint"
        />
      </label>

      {tags.length > 0 && <TagFilter tags={tags} selected={filter?.id} onSelect={setTagId} />}

      <nav className="-mr-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-2">
        {visible.map((bot) => (
          <BotRow
            key={bot.id}
            bot={bot}
            tags={tagsOf(bot.tags, tags)}
            active={bot.id === selectedId}
            busy={running.has(bot.id)}
            onClick={() => onSelect(bot.id)}
          />
        ))}
      </nav>
    </aside>
  );
}

/** Tag chips under Search; picking one shows only the bots with that tag. */
function TagFilter({
  tags,
  selected,
  onSelect,
}: {
  tags: Tag[];
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  return (
    <div role="group" aria-label="Filter by tag" className="-mt-1 flex flex-wrap gap-1.5 px-0.5">
      {tags.map((tag) => {
        const on = tag.id === selected;
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={on}
            onClick={() => onSelect(on ? undefined : tag.id)}
            style={on ? { background: tag.color } : tagStyle(tag.color)}
            className={`max-w-full truncate rounded-full px-2.5 py-[3px] text-[12px] font-medium ${
              on ? "text-white shadow-[inset_0_0_0_1px_var(--color-tag-ring)]" : "tag-tint hover:brightness-95"
            }`}
          >
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}

const DEFAULT_WIDTH = 290;
const MIN_WIDTH = 220;
const MAX_WIDTH = 420;
const WIDTH_KEY = "kbot.sidebarWidth";

const clampWidth = (w: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));

/** The sidebar width, remembered across launches. */
function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      return saved ? clampWidth(saved) : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // Not remembered; the width still applies for this session.
    }
  }, [width]);
  return [width, (w: number) => setWidth(clampWidth(w))] as const;
}

/** Drag the sidebar's right edge to resize it; double-click restores the default width. */
function ResizeHandle({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const [dragging, setDragging] = useState(false);
  // Where the drag began; null when not dragging. A ref, so moves that arrive before the re-render still count.
  const start = useRef<{ x: number; width: number } | null>(null);

  // Keep the resize cursor while the pointer runs ahead of the edge.
  useEffect(() => {
    if (!dragging) return;
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.cursor = "";
    };
  }, [dragging]);

  const end = () => {
    start.current = null;
    setDragging(false);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={MAX_WIDTH}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width };
        setDragging(true);
      }}
      onPointerMove={(e) => start.current && onResize(start.current.width + e.clientX - start.current.x)}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onResize(DEFAULT_WIDTH)}
      className={`absolute inset-y-0 -right-[3px] z-10 w-[6px] cursor-col-resize transition-colors ${
        dragging ? "bg-sidebar-line" : "hover:bg-sidebar-line"
      }`}
    />
  );
}

function BotRow({
  bot,
  tags,
  active,
  busy,
  onClick,
}: {
  bot: Bot;
  tags: Tag[];
  active: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  // Right-click opens the context menu at the pointer.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  const [dialog, setDialog] = useState<"edit" | "clear" | "delete">();
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
        className={`flex w-full shrink-0 items-center gap-3 rounded-[10px] px-2.5 py-3 text-left ${
          active ? "bg-row-active" : menuAt ? "bg-row-hover" : "hover:bg-row-hover"
        }`}
      >
        <BotAvatar avatar={bot.avatar} size={34} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <p className="min-w-0 truncate text-[14px] font-semibold text-ink">{bot.name}</p>
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
            {bot.unread && (
              <>
                <div className="flex-1" />
                <span data-testid="bot-unread" title="New result" className="size-2 shrink-0 rounded-full bg-unread" />
              </>
            )}
          </div>
          <TagLabels tags={tags} />
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
              onSelect: () => setDialog("edit"),
            },
            { label: "Clear History", icon: <ClearIcon />, onSelect: () => setDialog("clear") },
            { label: "Delete Chat", icon: <TrashIcon />, danger: true, onSelect: () => setDialog("delete") },
          ]}
        />
      )}
      {dialog === "edit" && <EditBotDialog bot={bot} onClose={() => setDialog(undefined)} />}
      {dialog === "clear" && (
        <ConfirmDialog
          title="Clear History"
          message={`Delete all messages with ${bot.name}? Its settings are kept. This can't be undone.`}
          confirmLabel="Clear History"
          onConfirm={() => backend.clearChat(bot.id)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title="Delete Chat"
          message={`Delete ${bot.name} with its messages and settings? This can't be undone.`}
          confirmLabel="Delete"
          onConfirm={() => backend.deleteBot(bot.id)}
          onClose={() => setDialog(undefined)}
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
      className="fixed z-40 flex w-[200px] flex-col rounded-[10px] border border-modal-line bg-surface/95 p-1 shadow-[0_8px_28px_rgb(0_0_0/0.14)] backdrop-blur"
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
              item.danger ? "text-danger" : "text-ink"
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
