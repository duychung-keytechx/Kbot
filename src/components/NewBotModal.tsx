import { useEffect, useState } from "react";
import { backend } from "../lib/api";
import { BOT_IMAGES, type Bot, type BotImage } from "../lib/types";
import { ImageAvatar } from "./avatars/ImageAvatar";
import { CloseIcon } from "./Icons";

const rows = <T,>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));

export function NewBotModal({ onClose, onCreated }: { onClose: () => void; onCreated: (bot: Bot) => void }) {
  const [name, setName] = useState("");
  // A random picture, so new bots don't all start out looking the same.
  const [image, setImage] = useState<BotImage>(() => BOT_IMAGES[Math.floor(Math.random() * BOT_IMAGES.length)]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canCreate = name.trim().length > 0 && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await backend.createBot(name, image));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-scrim" onMouseDown={onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-bot-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
        className="flex max-h-full w-[440px] flex-col overflow-hidden rounded-2xl border border-modal-line bg-white shadow-[0_20px_50px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.06)]"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-divider pr-4 pl-5">
          <p id="new-bot-title" className="text-[15px] font-semibold text-ink">
            Create New Bot
          </p>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-lg hover:bg-bubble"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex min-h-0 flex-col items-center gap-[22px] overflow-y-auto px-5 py-6">
          <ImageAvatar image={image} size={112} />

          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name your bot"
            maxLength={60}
            spellCheck={false}
            className="h-[42px] shrink-0 self-stretch rounded-[10px] border border-composer-line bg-white px-3.5 py-2.5 text-center text-[14px] leading-[normal] text-ink"
          />

          <div role="radiogroup" aria-label="Picture" className="flex flex-col gap-3 self-stretch">
            {rows(BOT_IMAGES, 5).map((row, i) => (
              <div key={i} className="flex justify-center gap-4">
                {row.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={s === image}
                    aria-label={s}
                    onClick={() => setImage(s)}
                    className={`flex size-[52px] shrink-0 items-center justify-center rounded-full ${
                      s === image
                        ? "bg-white shadow-[inset_0_0_0_1.5px_var(--color-shape-selected),0_1px_3px_rgba(0,0,0,0.1)]"
                        : "hover:bg-bubble"
                    }`}
                  >
                    <ImageAvatar image={s} size={38} />
                  </button>
                ))}
              </div>
            ))}
          </div>

          {error && <p className="text-[12.5px] text-[#F0263E]">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2.5 border-t border-divider px-4 pt-3.5 pb-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[17px] border border-cancel-line bg-bubble px-4 py-2 text-[14px] font-medium text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canCreate}
            className="rounded-[17px] bg-ink-strong px-4 py-2 text-[14px] font-medium text-white disabled:bg-disabled disabled:text-disabled-ink"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
