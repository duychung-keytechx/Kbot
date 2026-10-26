import { useState } from "react";
import { MicIcon, SendIcon, SmallPlusIcon } from "./Icons";

export function Composer({ botName, onSend }: { botName: string; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const canSend = text.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    onSend(text);
    setText("");
  };

  return (
    <div className="flex flex-col self-stretch px-5 pt-2 pb-[18px]">
      <form
        className="flex items-center gap-2.5 self-stretch rounded-[23px] border border-composer-line bg-white py-1.5 pr-1.5 pl-2 shadow-[0_2px_6px_rgba(0,0,0,0.05)]"
        onSubmit={(e) => {
          e.preventDefault();
          send();
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
        {/* Voice input is not wired yet; once there is text the button sends */}
        <button
          type={canSend ? "submit" : "button"}
          aria-label={canSend ? "Send" : "Voice input"}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ink-strong"
        >
          {canSend ? <SendIcon /> : <MicIcon />}
        </button>
      </form>
    </div>
  );
}
