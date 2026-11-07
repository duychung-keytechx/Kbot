import { Fragment, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import logo from "../assets/kbot-logo.png";
import { formatListTime } from "../lib/format";
import { backend, errorText } from "../lib/api";
import { useTags } from "../lib/hooks";
import type { Bot, Tag, Team } from "../lib/types";
import { BotAvatar } from "./avatars/BotAvatar";
import { ClearHistoryDialog, ConfirmDialog, DeleteBotDialog } from "./ConfirmDialog";
import { EditBotDialog } from "./EditBotDialog";
import { describeSchedule } from "./fields";
import {
  ChevronDownIcon,
  ClearIcon,
  ClockIcon,
  EditIcon,
  GearIcon,
  PlusIcon,
  SearchIcon,
  SpinnerIcon,
  TrashIcon,
} from "./Icons";
import { TagLabels, tagStyle, tagsOf } from "./tags";
import { LeadAvatar, StatusLabel, TeamAvatar } from "./teams/parts";
import { WindowControls } from "./WindowControls";

/** What the sidebar lists: bots on their own, and teams with their bots. */
type Entry = { kind: "bot"; bot: Bot } | { kind: "team"; team: Team; lead: Bot | undefined; members: Bot[] };

export function Sidebar({
  bots,
  teams,
  running,
  selectedId,
  onSelect,
  onNewBot,
  onNewTeam,
  onTeamSettings,
}: {
  bots: Bot[];
  teams: Team[];
  /** Bots and teams with a reply or job in progress; their "Edit" is disabled. */
  running: Set<string>;
  /** A bot or team id. */
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onNewBot: () => void;
  /** "New team", or "New team with this bot…" with `botId`. */
  onNewTeam: (botId?: string) => void;
  onTeamSettings: (teamId: string) => void;
}) {
  const tags = useTags();
  const [query, setQuery] = useState("");
  // The tag chip picked under Search; forgotten if the tag is deleted.
  const [tagId, setTagId] = useState<string>();
  const filter = tags.find((t) => t.id === tagId);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const names = new Map(tags.map((t) => [t.id, t.name.toLowerCase()]));
    const matches = (b: Bot) =>
      (!filter || b.tags.includes(filter.id)) &&
      (!q ||
        b.name.toLowerCase().includes(q) ||
        b.preview.toLowerCase().includes(q) ||
        b.tags.some((id) => names.get(id)?.includes(q)));
    const byId = new Map(bots.map((b) => [b.id, b]));
    const teamIds = new Set(teams.map((t) => t.id));
    const entries: (Entry & { at: number })[] = [];
    for (const team of teams) {
      const lead = byId.get(team.leadId);
      const members = team.members.map((id) => byId.get(id)).filter((b): b is Bot => !!b);
      const all = lead ? [lead, ...members] : members;
      const own = (!filter || !!lead?.tags.includes(filter.id)) && (!q || team.name.toLowerCase().includes(q) || team.preview.toLowerCase().includes(q));
      if (own || all.some(matches)) entries.push({ kind: "team", team, lead, members, at: team.updatedAt });
    }
    for (const bot of bots) {
      if (bot.teamId && teamIds.has(bot.teamId)) continue;
      if (matches(bot)) entries.push({ kind: "bot", bot, at: bot.updatedAt });
    }
    // Teams sit among the bots by their latest activity.
    return entries.sort((a, b) => b.at - a.at);
  }, [bots, teams, tags, query, filter]);
  const [plusOpen, setPlusOpen] = useState(false);

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
        <div className="relative flex shrink-0">
          <button
            type="button"
            aria-label="New"
            title="New bot or team"
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            onClick={() => setPlusOpen((o) => !o)}
            className="flex"
          >
            <PlusIcon />
          </button>
          {plusOpen && (
            <PlusMenu
              onClose={() => setPlusOpen(false)}
              onNewBot={onNewBot}
              onNewTeam={() => onNewTeam()}
            />
          )}
        </div>
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
        {visible.map((entry) =>
          entry.kind === "bot" ? (
            <BotRow
              key={entry.bot.id}
              bot={entry.bot}
              tags={tagsOf(entry.bot.tags, tags)}
              teams={teams}
              active={entry.bot.id === selectedId}
              busy={running.has(entry.bot.id)}
              onClick={() => onSelect(entry.bot.id)}
              onNewTeam={() => onNewTeam(entry.bot.id)}
            />
          ) : (
            <TeamGroup
              key={entry.team.id}
              team={entry.team}
              lead={entry.lead}
              members={entry.members}
              tags={tags}
              running={running}
              selectedId={selectedId}
              onSelect={onSelect}
              onSettings={() => onTeamSettings(entry.team.id)}
            />
          ),
        )}
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

/** The + menu: a bot of its own, or a team. */
function PlusMenu({ onClose, onNewBot, onNewTeam }: { onClose: () => void; onNewBot: () => void; onNewTeam: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (e: Event) => ref.current?.parentElement?.contains(e.target as Node) || onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const items = [
    { label: "New bot", hint: "One agent with its own chat", icon: <PlusIcon />, onSelect: onNewBot },
    { label: "New team", hint: "An orchestrator + agents working together", icon: <TeamAvatar color="var(--color-ink)" size={18} />, onSelect: onNewTeam },
  ];
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="New"
      className="absolute top-full -left-2 z-40 mt-1.5 flex w-[264px] flex-col gap-0.5 rounded-xl border border-modal-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.06)]"
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          autoFocus={i === 0}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-bubble focus-visible:bg-bubble"
        >
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg border border-modal-line bg-surface">
            {item.icon}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-[14px] leading-[18px] font-medium text-ink">{item.label}</span>
            <span className="truncate text-[12.5px] leading-4 text-subtle">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * A team: its row opens the team chat (the orchestrator), and its members
 * are listed underneath with what they're doing, unless it's collapsed.
 */
function TeamGroup({
  team,
  lead,
  members,
  tags,
  running,
  selectedId,
  onSelect,
  onSettings,
}: {
  team: Team;
  lead: Bot | undefined;
  members: Bot[];
  tags: Tag[];
  running: Set<string>;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onSettings: () => void;
}) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  const [dialog, setDialog] = useState<"clear" | "disband">();
  const busy = running.has(team.id) || !!team.activity;
  const active = selectedId === team.id;
  const collapsed = team.collapsed;
  const toggle = () => void backend.setTeamCollapsed(team.id, !collapsed).catch((e) => console.error(e));
  // Collapsed, the row tells what the team is doing.
  const line = collapsed && team.activity ? team.activity.summary : team.preview;
  const status = (id: string) => team.activity?.statuses[id];
  const unreadMember = collapsed && members.some((m) => m.unread);

  return (
    <div className="flex shrink-0 flex-col">
      <div
        role="button"
        tabIndex={0}
        onClick={() => onSelect(team.id)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(team.id))}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        aria-current={active || undefined}
        className={`flex w-full items-center gap-3 rounded-[10px] px-2.5 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring,rgb(20_20_20/0.25))] ${
          active ? "bg-row-active" : menuAt ? "bg-row-hover" : "hover:bg-row-hover"
        }`}
      >
        <TeamAvatar color={team.color} size={34} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-1">
            <p className="min-w-0 truncate text-[14px] font-semibold text-ink">{team.name}</p>
            <button
              type="button"
              aria-label={collapsed ? `Show ${team.name} members` : `Hide ${team.name} members`}
              aria-expanded={!collapsed}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
              className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-row-active"
            >
              <ChevronDownIcon className={`scale-75 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
            </button>
            <div className="flex-1" />
            <p className="shrink-0 text-[12px] text-muted">{formatListTime(team.updatedAt)}</p>
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            {busy && (
              <span title="Working" className="flex shrink-0">
                <SpinnerIcon className="animate-[spin_2.4s_linear_infinite]" />
              </span>
            )}
            <p className="truncate text-[12.5px] text-subtle">{line || (busy ? "Working…" : "No messages yet")}</p>
            {(team.unread || unreadMember) && (
              <>
                <div className="flex-1" />
                <span title="New result" className="size-2 shrink-0 rounded-full bg-unread" />
              </>
            )}
          </div>
          {lead && <TagLabels tags={tagsOf(lead.tags, tags)} />}
        </div>
      </div>
      {!collapsed && (
        <div className="flex pb-0.5 pl-6">
          <div className="flex min-w-0 flex-1 flex-col gap-px border-l border-thread-line py-0.5 pl-2">
            {lead && (
              <MemberRow
                name={lead.name}
                avatar={<LeadAvatar color={team.color} size={22} />}
                active={active}
                onClick={() => onSelect(team.id)}
              >
                <span className="shrink-0 text-[12px] text-hint">Lead</span>
              </MemberRow>
            )}
            {members.map((bot) => (
              <TeamMemberRow
                key={bot.id}
                bot={bot}
                team={team}
                active={selectedId === bot.id}
                busy={running.has(bot.id)}
                onClick={() => onSelect(bot.id)}
              >
                {status(bot.id) ? (
                  <StatusLabel status={status(bot.id)!} />
                ) : bot.unread ? (
                  <span title="New result" className="size-2 shrink-0 rounded-full bg-unread" />
                ) : running.has(bot.id) ? (
                  <SpinnerIcon className="animate-[spin_2.4s_linear_infinite]" />
                ) : null}
              </TeamMemberRow>
            ))}
          </div>
        </div>
      )}
      {menuAt && (
        <ContextMenu
          at={menuAt}
          label={`${team.name} options`}
          onClose={() => setMenuAt(undefined)}
          items={[
            { label: "Open chat", icon: <EditIcon />, onSelect: () => onSelect(team.id) },
            { label: "Team settings", icon: <GearIcon />, onSelect: onSettings },
            { label: collapsed ? "Show members" : "Hide members", icon: <ChevronDownIcon />, onSelect: toggle },
            { label: "Clear History", icon: <ClearIcon />, disabled: busy, onSelect: () => setDialog("clear") },
            { label: "Disband team", icon: <TrashIcon />, danger: true, disabled: busy, onSelect: () => setDialog("disband") },
          ]}
        />
      )}
      {dialog === "clear" && (
        <ConfirmDialog
          title="Clear History"
          message={`Delete all messages in ${team.name}'s chat? Members keep their own chats. This can't be undone.`}
          confirmLabel="Clear History"
          onConfirm={() => backend.clearChat(team.id)}
          onClose={() => setDialog(undefined)}
        />
      )}
      {dialog === "disband" && <DisbandDialog team={team} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

/** "Disband team": members go back to the bot list. */
export function DisbandDialog({ team, onClose, onDone }: { team: Team; onClose: () => void; onDone?: () => void }) {
  return (
    <ConfirmDialog
      title="Disband team"
      message={`Members of ${team.name} go back to your bots with their chats. The team chat is archived in the orchestrator's chat.`}
      confirmLabel="Disband"
      onConfirm={async () => {
        await backend.disbandTeam(team.id);
        onDone?.();
      }}
      onClose={onClose}
    />
  );
}

function MemberRow({
  name,
  avatar,
  active,
  onClick,
  onContextMenu,
  highlighted,
  children,
}: {
  name: string;
  avatar: ReactNode;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  highlighted?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-current={active || undefined}
      className={`flex w-full items-center gap-[9px] rounded-lg px-2.5 py-1.5 text-left ${
        active ? "bg-row-active" : highlighted ? "bg-row-hover" : "hover:bg-row-hover"
      }`}
    >
      {avatar}
      <p className="min-w-0 flex-1 truncate text-[13px] text-ink">{name}</p>
      {children}
    </button>
  );
}

/** A member under its team; right-click for Edit, Remove from team and Delete. */
function TeamMemberRow({
  bot,
  team,
  active,
  busy,
  onClick,
  children,
}: {
  bot: Bot;
  team: Team;
  active: boolean;
  busy: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  const [dialog, setDialog] = useState<"edit" | "clear" | "delete">();
  const [error, setError] = useState<string>();
  const live = !!team.activity;
  return (
    <>
      <MemberRow
        name={bot.name}
        avatar={<BotAvatar avatar={bot.avatar} size={22} />}
        active={active}
        highlighted={!!menuAt}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
      >
        {children}
      </MemberRow>
      {error && <p className="px-2.5 pb-1 text-[12px] text-danger">{error}</p>}
      {menuAt && (
        <ContextMenu
          at={menuAt}
          label={`${bot.name} options`}
          onClose={() => setMenuAt(undefined)}
          items={[
            { label: "Edit", icon: <EditIcon />, disabled: busy, onSelect: () => setDialog("edit") },
            {
              label: "Remove from team",
              icon: <ClearIcon />,
              disabled: live,
              onSelect: () => {
                setError(undefined);
                backend.removeTeamMember(team.id, bot.id).catch((e) => setError(errorText(e)));
              },
            },
            { label: "Clear History", icon: <ClearIcon />, onSelect: () => setDialog("clear") },
            { label: "Delete Chat", icon: <TrashIcon />, danger: true, disabled: live, onSelect: () => setDialog("delete") },
          ]}
        />
      )}
      {dialog === "edit" && <EditBotDialog bot={bot} onClose={() => setDialog(undefined)} />}
      {dialog === "clear" && <ClearHistoryDialog bot={bot} onClose={() => setDialog(undefined)} />}
      {dialog === "delete" && <DeleteBotDialog bot={bot} onClose={() => setDialog(undefined)} />}
    </>
  );
}

function BotRow({
  bot,
  tags,
  teams,
  active,
  busy,
  onClick,
  onNewTeam,
}: {
  bot: Bot;
  tags: Tag[];
  teams: Team[];
  active: boolean;
  busy: boolean;
  onClick: () => void;
  onNewTeam: () => void;
}) {
  // Right-click opens the context menu at the pointer.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  const [dialog, setDialog] = useState<"edit" | "clear" | "delete">();
  const [error, setError] = useState<string>();
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
          {error && <p className="text-[12px] text-danger">{error}</p>}
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
            {
              label: "Move to team",
              icon: <TeamAvatar color="var(--color-icon)" size={14} />,
              disabled: busy,
              onSelect: () => {},
              submenu: [
                ...teams.map((team) => ({
                  label: team.name,
                  icon: <TeamAvatar color={team.color} size={14} />,
                  disabled: !!team.activity,
                  onSelect: () => {
                    setError(undefined);
                    backend.addTeamMember(team.id, bot.id).catch((e) => setError(errorText(e)));
                  },
                })),
                { label: "New team with this bot…", icon: <PlusIcon />, divided: teams.length > 0, onSelect: onNewTeam },
              ],
            },
            { label: "Clear History", icon: <ClearIcon />, onSelect: () => setDialog("clear") },
            { label: "Delete Chat", icon: <TrashIcon />, danger: true, onSelect: () => setDialog("delete") },
          ]}
        />
      )}
      {dialog === "edit" && <EditBotDialog bot={bot} onClose={() => setDialog(undefined)} />}
      {dialog === "clear" && <ClearHistoryDialog bot={bot} onClose={() => setDialog(undefined)} />}
      {dialog === "delete" && <DeleteBotDialog bot={bot} onClose={() => setDialog(undefined)} />}
    </>
  );
}

type MenuItem = {
  label: string;
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Draws a divider above it. */
  divided?: boolean;
  onSelect: () => void;
  /** Opens to the side on hover, like "Move to team ›". */
  submenu?: MenuItem[];
};

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

  const [open, setOpen] = useState<string>();
  // Submenus open to the left when the menu is near the right edge.
  const flip = pos.x + 200 * 2 + 16 > window.innerWidth;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-40 flex w-[200px] flex-col rounded-[10px] border border-modal-line bg-surface/95 p-1 shadow-[0_8px_28px_rgb(0_0_0/0.14)] backdrop-blur"
    >
      <MenuItems items={items} onClose={onClose} open={open} setOpen={setOpen} flip={flip} autoFocus />
    </div>
  );
}

function MenuItems({
  items,
  onClose,
  open,
  setOpen,
  flip,
  autoFocus,
}: {
  items: MenuItem[];
  onClose: () => void;
  open?: string;
  setOpen?: (label: string | undefined) => void;
  flip?: boolean;
  autoFocus?: boolean;
}) {
  return items.map((item, i) => (
    <Fragment key={item.label}>
      {/* Destructive items sit below a divider, as in macOS menus. */}
      {(item.danger || item.divided) && i > 0 && <div className="mx-2 my-1 h-px bg-divider" />}
      <div className="relative" onMouseEnter={() => setOpen?.(item.submenu ? item.label : undefined)}>
        <button
          type="button"
          role="menuitem"
          disabled={item.disabled}
          autoFocus={autoFocus && i === 0}
          aria-haspopup={item.submenu ? "menu" : undefined}
          aria-expanded={item.submenu ? open === item.label : undefined}
          onClick={() => {
            if (item.submenu) return setOpen?.(open === item.label ? undefined : item.label);
            onClose();
            item.onSelect();
          }}
          onKeyDown={(e) => item.submenu && e.key === "ArrowRight" && setOpen?.(item.label)}
          className={`flex w-full items-center gap-2.5 rounded-[7px] px-2.5 py-[7px] text-left text-[13.5px] outline-none enabled:hover:bg-row-hover focus-visible:bg-row-hover disabled:opacity-40 ${
            item.danger ? "text-danger" : "text-ink"
          } ${item.submenu && open === item.label ? "bg-row-hover" : ""}`}
        >
          <span className="flex w-4 justify-center">{item.icon}</span>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.submenu && <span className="text-[12px] text-hint">›</span>}
        </button>
        {item.submenu && open === item.label && !item.disabled && (
          <div
            role="menu"
            aria-label={item.label}
            className={`absolute -top-1 z-10 flex w-[220px] flex-col rounded-[10px] border border-modal-line bg-surface p-1 shadow-[0_8px_28px_rgb(0_0_0/0.14)] ${
              flip ? "right-full mr-1" : "left-full ml-1"
            }`}
          >
            <MenuItems items={item.submenu} onClose={onClose} />
          </div>
        )}
      </div>
    </Fragment>
  ));
}
