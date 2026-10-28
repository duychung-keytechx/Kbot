import { useEffect, useState } from "react";
import { backend, errorText } from "../lib/api";
import type { Bot } from "../lib/types";
import { secondaryButton } from "./fields";

/** A small "are you sure?" dialog for destructive actions; shows the error if `onConfirm` fails. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim" onMouseDown={onClose}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex w-[340px] flex-col gap-2 rounded-2xl border border-modal-line bg-surface p-5 shadow-[0_20px_50px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.06)]"
      >
        <p id="confirm-title" className="text-[15px] font-semibold text-ink">
          {title}
        </p>
        <p className="text-[13.5px] leading-[20px] text-subtle">{message}</p>
        {error && <p className="text-[12.5px] leading-[18px] text-danger">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className={secondaryButton}>
            Cancel
          </button>
          <button
            type="button"
            autoFocus
            disabled={busy}
            onClick={() => void confirm()}
            className="rounded-[15px] bg-danger px-[13px] py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Clear History" from a bot's menu, or `/clear-history` in its chat. */
export function ClearHistoryDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  return (
    <ConfirmDialog
      title="Clear History"
      message={`Delete all messages with ${bot.name}? Its settings are kept. This can't be undone.`}
      confirmLabel="Clear History"
      onConfirm={() => backend.clearChat(bot.id)}
      onClose={onClose}
    />
  );
}

/** "Delete Chat" from a bot's menu, or `/delete` in its chat. */
export function DeleteBotDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  return (
    <ConfirmDialog
      title="Delete Chat"
      message={`Delete ${bot.name} with its messages and settings? This can't be undone.`}
      confirmLabel="Delete"
      onConfirm={() => backend.deleteBot(bot.id)}
      onClose={onClose}
    />
  );
}
