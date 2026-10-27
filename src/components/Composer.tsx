import { useState } from "react";
import { MicIcon, SendIcon, SmallPlusIcon, StopIcon } from "./Icons";

export function Composer({
  botName,
  running,
  onSend,
  onStop,
}: {
  botName: string;
  /** The bot is replying; the button stops it instead of sending. */
  running: boolean;
  /** Resolves false if the message was refused; the text is then kept. */
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const canSend = text.trim().length > 0 && !running;

  const send = async () => {
    if (!canSend) return;
    const sent = text;
    setText("");
    if (!(await onSend(sent))) setText((t) => t || sent);
  };

  return (
    <div className="flex flex-col self-stretch px-5 pt-2 pb-[18px]">
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
          onChange={(e) => setText(e.target.value)}
          placeholder={`Message ${botName}`}
          className="min-w-0 flex-1 text-[14px] leading-[normal] text-ink"
        />
        {running ? (
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
