import { useState, type ReactNode } from "react";
import { ClearIcon, EditIcon, MicIcon, SendIcon, SmallPlusIcon, StopIcon, TrashIcon } from "./Icons";

export type CommandName = "setup" | "clear-history" | "delete";

type Command = { name: CommandName; description: string; icon: ReactNode };

/** A team member the "@" menu offers. */
export type Mention = { id: string; name: string; avatar: ReactNode; hint?: string };

/** The "@name" being typed at the end of `text`, if any. */
const mentionQuery = (text: string) => /(?:^|\s)@([^@\n]{0,40})$/.exec(text)?.[1];

const COMMANDS: Command[] = [
  { name: "setup", description: "Set up or change this bot", icon: <EditIcon /> },
  { name: "clear-history", description: "Clear chat history", icon: <ClearIcon /> },
  { name: "delete", description: "Delete this bot", icon: <TrashIcon /> },
];

export function Composer({
  botName,
  placeholder,
  commands: allowed,
  mentions,
  running,
  sendWhileRunning,
  onSend,
  onStop,
  onCommand,
}: {
  botName: string;
  /** Defaults to "Message {botName}". */
  placeholder?: string;
  /** The "/" commands offered; all by default. */
  commands?: CommandName[];
  /** Typing "@" offers these. */
  mentions?: Mention[];
  /** The bot is replying; the button stops it instead of sending. */
  running: boolean;
  /** Typed text can still be sent while running (a team takes @mentions and step-ins). */
  sendWhileRunning?: boolean;
  /** Resolves false if the message was refused; the text is then kept. */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  /** A command picked from the "/" menu, or typed out in full and sent. */
  onCommand: (name: CommandName) => Promise<boolean> | void;
}) {
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  // Escape hides the menu until the text changes.
  const [dismissed, setDismissed] = useState(false);
  const canSend = text.trim().length > 0 && (!running || !!sendWhileRunning);

  // /setup talks to the bot, so it waits until the bot is done replying.
  const commands = COMMANDS.filter((c) => !(running && c.name === "setup") && (!allowed || allowed.includes(c.name)));
  const query = /^\/\S*$/.test(text) ? text.slice(1).toLowerCase() : undefined;
  const matches = query === undefined ? [] : commands.filter((c) => c.name.startsWith(query));
  const mention = mentions && query === undefined ? mentionQuery(text)?.toLowerCase() : undefined;
  const people =
    mention === undefined
      ? []
      : mentions!.filter((m) => m.name.toLowerCase().startsWith(mention.trimStart()) && m.name.toLowerCase() !== mention.trim());
  const listed = matches.length > 0 ? matches.length : people.length;
  const open = !dismissed && listed > 0;
  const current = Math.min(active, listed - 1);

  const pick = (m: Mention) => {
    setText((t) => t.replace(/@([^@\n]{0,40})$/, `@${m.name} `));
    setActive(0);
  };

  const run = async (command: Command) => {
    setText("");
    setActive(0);
    if ((await onCommand(command.name)) === false) setText((t) => t || `/${command.name}`);
  };

  const send = async () => {
    const typed = commands.find((c) => `/${c.name}` === text.trim());
    if (typed) return run(typed);
    if (!canSend) return;
    const sent = text;
    setText("");
    if (!(await onSend(sent))) setText((t) => t || sent);
  };

  return (
    <div className="relative flex flex-col self-stretch px-5 pt-2 pb-[18px]">
      {open && people.length > 0 && matches.length === 0 && (
        <div
          id="composer-commands"
          role="listbox"
          aria-label="Members"
          className="absolute bottom-full left-5 z-20 mb-0.5 flex max-h-[300px] w-[340px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-modal-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.06)]"
        >
          <p className="px-2.5 pt-1 pb-1.5 text-[12px] font-medium text-hint">Ask one member</p>
          {people.map((m, i) => (
            <div
              key={m.id}
              id={`command-${i}`}
              role="option"
              aria-selected={i === current}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(m)}
              className={`flex cursor-default items-center gap-3 rounded-lg px-2.5 py-2 ${i === current ? "bg-bubble" : ""}`}
            >
              {m.avatar}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px] leading-[18px] font-medium text-ink">{m.name}</span>
                {m.hint && <span className="truncate text-[12.5px] leading-4 text-subtle">{m.hint}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {open && matches.length > 0 && (
        <div
          id="composer-commands"
          role="listbox"
          aria-label="Commands"
          className="absolute bottom-full left-5 z-20 mb-0.5 flex max-h-[300px] w-[340px] flex-col gap-0.5 overflow-y-auto rounded-xl border border-modal-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.12),0_1px_3px_rgba(0,0,0,0.06)]"
        >
          <p className="px-2.5 pt-1 pb-1.5 text-[12px] font-medium text-hint">Commands</p>
          {matches.map((command, i) => (
            <div
              key={command.name}
              id={`command-${i}`}
              role="option"
              aria-selected={i === current}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => void run(command)}
              className={`flex cursor-default items-center gap-3 rounded-lg px-2.5 py-2 ${i === current ? "bg-bubble" : ""}`}
            >
              <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg border border-modal-line bg-surface">
                {command.icon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px] leading-[18px] font-medium text-ink">/{command.name}</span>
                <span className="truncate text-[12.5px] leading-4 text-subtle">{command.description}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-2.5 self-stretch rounded-[23px] border border-composer-line bg-surface py-1.5 pr-1.5 pl-2 shadow-[0_2px_6px_rgba(0,0,0,0.05)]"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {/* Attachments: not wired yet */}
        <button type="button" aria-label="Add" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-bubble">
          <SmallPlusIcon />
        </button>
        <input
          value={text}
          role="combobox"
          aria-expanded={open}
          aria-controls="composer-commands"
          aria-autocomplete="list"
          aria-activedescendant={open ? `command-${current}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
            setDismissed(false);
          }}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((current + step + listed) % listed);
            } else if (e.key === "Enter" || (e.key === "Tab" && matches.length === 0)) {
              e.preventDefault();
              if (matches.length > 0) void run(matches[current]);
              else pick(people[current]);
            } else if (e.key === "Tab") {
              e.preventDefault();
              setText(`/${matches[current].name}`);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDismissed(true);
            }
          }}
          placeholder={placeholder ?? `Message ${botName}`}
          className="min-w-0 flex-1 text-[14px] leading-[normal] text-ink"
        />
        {running && !canSend ? (
          <button
            type="button"
            aria-label="Stop"
            onClick={onStop}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink-strong"
          >
            <StopIcon />
          </button>
        ) : (
          // Voice input is not wired yet; once there is text the button sends
          <button
            type={canSend ? "submit" : "button"}
            aria-label={canSend ? "Send" : "Voice input"}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink-strong"
          >
            {canSend ? <SendIcon /> : <MicIcon />}
          </button>
        )}
      </form>
    </div>
  );
}
