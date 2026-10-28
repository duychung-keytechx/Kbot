import { Fragment, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { backend, errorText } from "../lib/api";
import { useBots, useTags } from "../lib/hooks";
import { type AgentConfig, type Bot, MAX_NAME, MAX_TAG_NAME, type Tag, TAG_COLORS } from "../lib/types";
import { BotAvatar } from "./avatars/BotAvatar";
import { FolderList, Switch } from "./fields";
import {
  CheckIcon,
  CloseIcon,
  InfoIcon,
  PencilIcon,
  SmallTrashIcon,
  TagIcon,
  TinyCloseIcon,
  TinyPlusIcon,
} from "./Icons";
import { TagDot, tagStyle, tagsOf } from "./tags";

/** The parts of `AgentConfig` that "Edit" in a bot's menu changes. */
type Draft = Pick<AgentConfig, "description" | "instructions" | "workspaceFolders" | "webAccess">;

const draftOf = ({ description, instructions, workspaceFolders, webAccess }: AgentConfig): Draft => ({
  description,
  instructions,
  workspaceFolders,
  webAccess,
});

type Tab = "info" | "tags";
type RowMode = "menu" | "rename" | "delete";

const cancelButton =
  "rounded-[17px] border border-cancel-line bg-bubble px-4 py-2 text-[14px] font-medium text-ink disabled:opacity-50";
const saveButton =
  "rounded-[17px] bg-ink px-[18px] py-[9px] text-[14px] font-medium text-ink-inverse disabled:opacity-50";
const field =
  "selectable w-full rounded-[10px] border border-composer-line bg-surface px-3.5 py-2.5 text-[14px] text-ink focus:border-ink focus:shadow-[0_0_0_0.5px_var(--color-ink)]";
const popover =
  "absolute z-20 flex flex-col gap-0.5 rounded-xl border border-modal-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.06)]";

/** "3 bots", "1 bot" or "Unused". */
const usageText = (n: number) => (n === 0 ? "Unused" : n === 1 ? "1 bot" : `${n} bots`);

/**
 * "Edit" in a bot's menu. "Agent Info" changes its name, description,
 * instructions, folders and web search, kept until Save; "Tags" saves as you go.
 */
export function EditBotDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("info");
  const [name, setName] = useState(bot.name);
  const [draft, setDraft] = useState<Draft>(() => draftOf(bot.config));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const renamed = name.trim() !== bot.name;
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(bot.config));
  const dirty = renamed || changed;

  // Escape closes, unless a menu or field inside used it (`preventDefault`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (renamed) await backend.renameBot(bot.id, name);
      // The schedule and model are kept as they are now.
      if (changed) await backend.updateBotConfig(bot.id, { ...bot.config, ...draft });
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${bot.name}`}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-[760px] max-h-full w-[760px] max-w-full overflow-hidden rounded-2xl border border-modal-line bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.06)]"
      >
        <div
          role="tablist"
          aria-orientation="vertical"
          className="flex w-[200px] shrink-0 flex-col gap-0.5 bg-sidebar px-3 py-4"
        >
          <div className="flex items-center gap-2.5 px-2 pt-0.5 pb-3.5">
            <BotAvatar avatar={bot.avatar} size={32} />
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <p className="truncate text-[14px] font-semibold text-ink">{bot.name}</p>
              <p className="text-[12px] text-hint">Bot settings</p>
            </div>
          </div>
          <NavItem active={tab === "info"} icon={<InfoIcon />} onClick={() => setTab("info")}>
            Agent Info
            {dirty && <span title="Unsaved changes" className="ml-auto size-1.5 rounded-full bg-unsaved" />}
          </NavItem>
          <NavItem active={tab === "tags"} icon={<TagIcon />} onClick={() => setTab("tags")}>
            Tags
            {bot.tags.length > 0 && (
              <span className="ml-auto text-[12px] font-normal text-hint">{bot.tags.length}</span>
            )}
          </NavItem>
        </div>

        {tab === "info" ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            className="flex min-w-0 flex-1 flex-col"
          >
            <Body title="Agent Info" onClose={onClose}>
              <Field label="Name" htmlFor="edit-name">
                <input
                  id="edit-name"
                  autoFocus
                  value={name}
                  maxLength={MAX_NAME}
                  spellCheck={false}
                  onChange={(e) => setName(e.target.value)}
                  className={`${field} h-10`}
                />
              </Field>
              <Field label="Description" htmlFor="edit-description">
                <textarea
                  id="edit-description"
                  rows={2}
                  value={draft.description}
                  onChange={(e) => set({ description: e.target.value })}
                  className={`${field} resize-none leading-[20px]`}
                />
              </Field>
              <Field
                label="Instructions"
                htmlFor="edit-instructions"
                hint="What the bot follows. Changing it starts a new conversation."
              >
                <textarea
                  id="edit-instructions"
                  rows={5}
                  value={draft.instructions}
                  onChange={(e) => set({ instructions: e.target.value })}
                  className={`${field} resize-none leading-[20px]`}
                />
              </Field>
              <Field label="Folders">
                <div className="rounded-xl bg-sidebar p-2">
                  <FolderList folders={draft.workspaceFolders} onChange={(workspaceFolders) => set({ workspaceFolders })} />
                </div>
              </Field>
              <div className="rounded-xl border border-modal-line py-0.5 pr-3.5 pl-4">
                <Switch checked={draft.webAccess} onChange={(webAccess) => set({ webAccess })}>
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[14px] text-ink">Search the web</span>
                    <span className="text-[12px] text-hint">Let the bot look things up online</span>
                  </span>
                </Switch>
              </div>
              {error && <p className="text-[12.5px] text-danger">{error}</p>}
            </Body>
            <Footer
              status={
                dirty && (
                  <>
                    <span className="size-1.5 rounded-full bg-unsaved" />
                    Unsaved changes
                  </>
                )
              }
            >
              <button type="button" onClick={onClose} className={cancelButton}>
                Cancel
              </button>
              <button type="submit" disabled={!dirty || !name.trim() || busy} className={saveButton}>
                Save
              </button>
            </Footer>
          </form>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col">
            <TagsTab bot={bot} onClose={onClose} />
          </div>
        )}
      </div>
    </div>
  );
}

function NavItem({
  active,
  icon,
  onClick,
  children,
}: {
  active: boolean;
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[14px] font-medium text-ink ${
        active ? "bg-row-active" : "hover:bg-row-hover"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

/** The scrolling part of a tab: its title and close button, then `children`. */
function Body({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      aria-label={title}
      className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto pt-6 pr-7 pb-6 pl-8"
    >
      <div className="flex items-center justify-between pb-1">
        <p className="text-[18px] font-semibold text-ink">{title}</p>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="-mr-1 flex size-7 items-center justify-center rounded-lg hover:bg-bubble"
        >
          <CloseIcon />
        </button>
      </div>
      {subtitle && <p className="text-[13px] text-hint">{subtitle}</p>}
      {children}
    </div>
  );
}

function Footer({ status, children }: { status: ReactNode; children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2.5 border-t border-divider pt-3.5 pr-4 pb-4 pl-8">
      <p className="flex items-center gap-1.5 text-[12px] text-hint">{status}</p>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] text-subtle">
        {label}
      </label>
      {children}
      {hint && <p className="text-[12px] leading-[17px] text-hint">{hint}</p>}
    </div>
  );
}

/** The "Tags" tab. Every change is saved right away. */
function TagsTab({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const tags = useTags();
  const bots = useBots();
  const [error, setError] = useState<string>();
  // At most one row shows its menu, a rename field or the delete confirmation.
  const [row, setRow] = useState<{ id: string; mode: RowMode }>();
  const [adding, setAdding] = useState(false);

  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of bots) for (const id of b.tags) counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts;
  }, [bots]);
  const onBot = new Set(bot.tags);
  const chips = tagsOf(bot.tags, tags);

  /** Runs a backend call and shows its error; returns whether it worked. */
  const run = async (call: Promise<unknown>) => {
    try {
      await call;
      setError(undefined);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };
  const setOnBot = (tagId: string, on: boolean) => void run(backend.setBotTag(bot.id, tagId, on));

  return (
    <>
      <Body title="Tags" subtitle="Group and filter your bots. Tags are shared by all bots." onClose={onClose}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="edit-tag-input" className="text-[13px] text-subtle">
            On this bot
          </label>
          <TagInput
            chips={chips}
            tags={tags}
            onBot={onBot}
            usage={usage}
            onAdd={(id) => setOnBot(id, true)}
            onRemove={(id) => setOnBot(id, false)}
            onCreate={(name) => run(backend.createTag(name, bot.id))}
          />
          <p className="text-[12px] leading-[17px] text-hint">Type to find a tag, or press Enter to create a new one.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <p className="text-[13px] text-subtle">All tags</p>
            <button
              type="button"
              onClick={() => {
                setRow(undefined);
                setAdding(true);
              }}
              className="-my-1 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-ink hover:bg-bubble"
            >
              <TinyPlusIcon />
              New tag
            </button>
          </div>
          {error && <p className="text-[12.5px] text-danger">{error}</p>}
          <div className="rounded-xl border border-modal-line">
            {adding && (
              <div className={`${rowClass} gap-2.5 py-[9px] pr-2 pl-3.5`}>
                <span className="size-4 shrink-0" />
                <TagDot color="var(--color-disabled-ink)" />
                <NameInput
                  label="New tag name"
                  initial=""
                  onDone={async (name) => {
                    if (name && !(await run(backend.createTag(name)))) return;
                    setAdding(false);
                  }}
                />
              </div>
            )}
            {tags.map((tag) => (
              <TagRow
                key={tag.id}
                tag={tag}
                checked={onBot.has(tag.id)}
                usage={usage.get(tag.id) ?? 0}
                mode={row?.id === tag.id ? row.mode : undefined}
                setMode={(mode) => setRow(mode && { id: tag.id, mode })}
                onCheck={(on) => setOnBot(tag.id, on)}
                run={run}
              />
            ))}
            {tags.length === 0 && !adding && (
              <p className="px-3.5 py-3 text-[13px] text-hint">No tags yet. Type one above, or use New tag.</p>
            )}
          </div>
        </div>
      </Body>
      <Footer
        status={
          <>
            <span className="size-1.5 rounded-full bg-saved" />
            Tag changes save automatically
          </>
        }
      >
        <button type="button" onClick={onClose} className={saveButton}>
          Done
        </button>
      </Footer>
    </>
  );
}

type Option = { kind: "tag"; tag: Tag } | { kind: "create"; name: string };

/** The bot's tags as chips, then a field that finds more or creates one. */
function TagInput({
  chips,
  tags,
  onBot,
  usage,
  onAdd,
  onRemove,
  onCreate,
}: {
  chips: Tag[];
  tags: Tag[];
  onBot: Set<string>;
  usage: Map<string, number>;
  onAdd: (tagId: string) => void;
  onRemove: (tagId: string) => void;
  onCreate: (name: string) => Promise<boolean>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);

  // Tags not on the bot that contain the text, those starting with it first,
  // then "Create tag" unless a tag already has that name.
  const query = text.trim().toLowerCase();
  const options: Option[] = [];
  if (query) {
    const starts = (t: Tag) => (t.name.toLowerCase().startsWith(query) ? 0 : 1);
    const matches = tags
      .filter((t) => !onBot.has(t.id) && t.name.toLowerCase().includes(query))
      .sort((a, b) => starts(a) - starts(b))
      .slice(0, 6);
    options.push(...matches.map((tag): Option => ({ kind: "tag", tag })));
    if (!tags.some((t) => t.name.toLowerCase() === query)) options.push({ kind: "create", name: text.trim() });
  }
  const open = focused && options.length > 0;
  const current = Math.min(active, options.length - 1);

  const choose = async (option: Option) => {
    if (option.kind === "tag") onAdd(option.tag.id);
    else if (!(await onCreate(option.name))) return;
    setText("");
    setActive(0);
  };

  return (
    <div className="relative">
      <div
        onMouseDown={(e) => {
          // A click on the box, not on a chip, puts the cursor in the field.
          if (e.target === e.currentTarget) {
            e.preventDefault();
            input.current?.focus();
          }
        }}
        className={`flex min-h-10 flex-wrap items-center gap-1.5 rounded-[10px] border bg-surface py-2 pr-2.5 pl-2 ${
          focused ? "border-ink shadow-[0_0_0_0.5px_var(--color-ink)]" : "border-composer-line"
        }`}
      >
        {chips.map((tag) => (
          <span
            key={tag.id}
            style={tagStyle(tag.color)}
            className="tag-tint flex items-center gap-1.5 rounded-md py-1 pr-[7px] pl-2"
          >
            <span className="text-[13px] leading-4 font-medium">{tag.name}</span>
            <button
              type="button"
              aria-label={`Remove ${tag.name}`}
              onClick={() => onRemove(tag.id)}
              className="-m-1 flex p-1 opacity-60 hover:opacity-100"
            >
              <TinyCloseIcon color="currentColor" />
            </button>
          </span>
        ))}
        <input
          ref={input}
          id="edit-tag-input"
          role="combobox"
          aria-expanded={open}
          aria-controls="edit-tag-options"
          aria-autocomplete="list"
          value={text}
          maxLength={MAX_TAG_NAME}
          spellCheck={false}
          autoComplete="off"
          placeholder="Add a tag…"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              if (open) setActive((current + step + options.length) % options.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (open) void choose(options[current]);
            } else if (e.key === "Escape" && text) {
              e.preventDefault();
              setText("");
            } else if (e.key === "Backspace" && !text && chips.length) {
              onRemove(chips[chips.length - 1].id);
            }
          }}
          className="h-6 min-w-[100px] flex-1 pl-1 text-[14px] text-ink placeholder:text-disabled-ink"
        />
      </div>

      {open && (
        <div id="edit-tag-options" role="listbox" className={`${popover} top-full left-0 mt-1.5 w-[300px]`}>
          {options.map((option, i) => (
            <Fragment key={option.kind === "tag" ? option.tag.id : "create"}>
              {option.kind === "create" && i > 0 && <div className="my-0.5 h-px shrink-0 bg-divider" />}
              <div
                role="option"
                aria-selected={i === current}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => void choose(option)}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] text-ink ${
                  i === current ? "bg-bubble" : ""
                }`}
              >
                {option.kind === "tag" ? (
                  <>
                    <TagDot color={option.tag.color} />
                    <span className="min-w-0 flex-1 truncate">
                      <Highlight name={option.tag.name} query={query} />
                    </span>
                    <span className="text-[12px] text-hint">{usageText(usage.get(option.tag.id) ?? 0)}</span>
                  </>
                ) : (
                  <>
                    <TinyPlusIcon />
                    <span className="min-w-0 flex-1 truncate">Create tag “{option.name}”</span>
                  </>
                )}
                {i === current && (
                  <span className="rounded bg-row-active px-[5px] py-px text-[11px] font-medium text-icon">Enter</span>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** `name` with the part matching `query` in bold. */
function Highlight({ name, query }: { name: string; query: string }) {
  const at = name.toLowerCase().indexOf(query);
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <span className="font-semibold">{name.slice(at, at + query.length)}</span>
      {name.slice(at + query.length)}
    </>
  );
}

const rowClass =
  "relative flex items-center border-b border-divider last:border-b-0 first:rounded-t-[11px] last:rounded-b-[11px]";

/** A row of "All tags": whether this bot has it, how many bots do, and its "…" menu. */
function TagRow({
  tag,
  checked,
  usage,
  mode,
  setMode,
  onCheck,
  run,
}: {
  tag: Tag;
  checked: boolean;
  usage: number;
  mode: RowMode | undefined;
  setMode: (mode: RowMode | undefined) => void;
  onCheck: (on: boolean) => void;
  run: (call: Promise<unknown>) => Promise<boolean>;
}) {
  const more = useRef<HTMLButtonElement>(null);

  if (mode === "delete") {
    return (
      <div className={`${rowClass} gap-2.5 bg-danger-bg py-2.5 pr-2.5 pl-3.5`}>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="truncate text-[14px] font-medium text-ink">Delete “{tag.name}”?</p>
          <p className="text-[12px] text-subtle">
            {usage === 0 ? "It isn't on any bot." : `It will be removed from ${usageText(usage)}.`}
          </p>
        </div>
        <button
          type="button"
          autoFocus
          onClick={() => setMode(undefined)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setMode(undefined);
            }
          }}
          className="rounded-[14px] border border-cancel-line bg-surface px-3 py-[5px] text-[13px] font-medium text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void run(backend.deleteTag(tag.id)).then((ok) => ok && setMode(undefined))}
          className="rounded-[14px] bg-danger-fill px-3 py-1.5 text-[13px] font-medium text-white"
        >
          Delete
        </button>
      </div>
    );
  }

  return (
    <div className={`${rowClass} gap-2.5 py-[9px] pr-2 pl-3.5 ${mode === "menu" ? "bg-row-open" : ""}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={tag.name}
        onClick={() => onCheck(!checked)}
        className={`flex size-4 shrink-0 items-center justify-center rounded-[4px] ${
          checked ? "bg-ink" : "border-[1.5px] border-checkbox-line bg-surface"
        }`}
      >
        {checked && <CheckIcon />}
      </button>
      <TagDot color={tag.color} />
      {mode === "rename" ? (
        <NameInput
          label={`Rename ${tag.name}`}
          initial={tag.name}
          onDone={async (name) => {
            if (name && name !== tag.name && !(await run(backend.renameTag(tag.id, name)))) return;
            setMode(undefined);
          }}
        />
      ) : (
        <p onClick={() => onCheck(!checked)} className="min-w-0 flex-1 truncate text-[14px] text-ink">
          {tag.name}
        </p>
      )}
      <p className="shrink-0 text-[12px] text-hint">{usageText(usage)}</p>
      <button
        ref={more}
        type="button"
        aria-label={`${tag.name} options`}
        aria-haspopup="menu"
        aria-expanded={mode === "menu"}
        onClick={() => setMode(mode === "menu" ? undefined : "menu")}
        className={`flex size-6 shrink-0 items-center justify-center gap-[2.5px] rounded-md ${
          mode === "menu" ? "bg-row-active" : "hover:bg-row-hover"
        }`}
      >
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-[3px] rounded-full bg-hint" />
        ))}
      </button>
      {mode === "menu" && <TagMenu tag={tag} anchor={more} setMode={setMode} run={run} />}
    </div>
  );
}

/** A tag's "…" menu: Rename, Color and Delete tag…. */
function TagMenu({
  tag,
  anchor,
  setMode,
  run,
}: {
  tag: Tag;
  /** The "…" button, which toggles the menu itself. */
  anchor: RefObject<HTMLButtonElement | null>;
  setMode: (mode: RowMode | undefined) => void;
  run: (call: Promise<unknown>) => Promise<boolean>;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Closes on a click elsewhere or Escape. Listens in the capture phase, since
  // the dialog stops mousedown from bubbling out of it.
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      setMode(undefined);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMode(undefined);
    };
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", outside, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, setMode]);

  const item =
    "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-[14px] outline-none hover:bg-bubble focus-visible:bg-bubble";
  return (
    <div ref={ref} role="menu" aria-label={`${tag.name} options`} className={`${popover} top-full right-1 -mt-1 w-[200px]`}>
      <button type="button" role="menuitem" autoFocus onClick={() => setMode("rename")} className={`${item} text-ink`}>
        <span className="flex w-3 justify-center">
          <PencilIcon />
        </span>
        Rename
      </button>
      <div className="flex flex-col gap-2 px-2.5 pt-1.5 pb-2">
        <p className="text-[12px] text-hint">Color</p>
        <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-1">
          {TAG_COLORS.map((color) => {
            const selected = color === tag.color;
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={color}
                onClick={() => selected || void run(backend.setTagColor(tag.id, color))}
                className={`flex size-[18px] items-center justify-center rounded-full ${
                  selected ? "shadow-[inset_0_0_0_1.5px_var(--color-ink)]" : ""
                }`}
              >
                <TagDot color={color} size={selected ? 10 : 12} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="mx-1 h-px shrink-0 bg-divider" />
      <button type="button" role="menuitem" onClick={() => setMode("delete")} className={`${item} text-danger`}>
        <span className="flex w-3 justify-center">
          <SmallTrashIcon />
        </span>
        Delete tag…
      </button>
    </div>
  );
}

/** An inline field for a tag's name. Enter or leaving it saves; Escape gives up (`onDone("")`). */
function NameInput({
  label,
  initial,
  onDone,
}: {
  label: string;
  initial: string;
  onDone: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  // So the blur that follows Enter doesn't save a second time.
  const saving = useRef(false);
  const finish = (value: string) => {
    if (saving.current) return;
    saving.current = true;
    void onDone(value.trim()).finally(() => (saving.current = false));
  };
  return (
    <input
      autoFocus
      aria-label={label}
      value={name}
      maxLength={MAX_TAG_NAME}
      spellCheck={false}
      placeholder="Tag name"
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => finish(name)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(name);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish("");
        }
      }}
      className="selectable -my-1 h-7 min-w-0 flex-1 rounded-md border border-ink bg-surface px-1.5 text-[14px] text-ink"
    />
  );
}
