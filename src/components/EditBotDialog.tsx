import { type ReactNode, useEffect, useState } from "react";
import { backend, errorText } from "../lib/api";
import { type AgentConfig, type Bot, MAX_NAME } from "../lib/types";
import { FolderList, primaryButton, secondaryButton, Switch, textArea } from "./fields";
import { CloseIcon } from "./Icons";

/** The parts of `AgentConfig` that "Edit" in a bot's menu changes. */
type Draft = Pick<AgentConfig, "description" | "instructions" | "workspaceFolders" | "webAccess">;

const draftOf = ({ description, instructions, workspaceFolders, webAccess }: AgentConfig): Draft => ({
  description,
  instructions,
  workspaceFolders,
  webAccess,
});

/** "Edit" in a bot's menu: changes its name, description, instructions, folders and web search. */
export function EditBotDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [name, setName] = useState(bot.name);
  const [draft, setDraft] = useState<Draft>(() => draftOf(bot.config));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const renamed = name.trim() !== bot.name;
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(bot.config));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
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
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-bot-title"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex max-h-full w-[520px] max-w-full flex-col overflow-hidden rounded-2xl border border-modal-line bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.06)]"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-divider pr-4 pl-5">
          <p id="edit-bot-title" className="min-w-0 truncate text-[15px] font-semibold text-ink">
            Edit {bot.name}
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

        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-5 py-5">
          <Field label="Name" htmlFor="edit-name">
            <input
              id="edit-name"
              autoFocus
              value={name}
              maxLength={MAX_NAME}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              className="selectable rounded-[10px] border border-field-line bg-surface px-2.5 py-2 text-[13.5px] text-ink"
            />
          </Field>
          <Field label="Description" htmlFor="edit-description">
            <textarea
              id="edit-description"
              rows={2}
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
              className={textArea}
            />
          </Field>
          <Field
            label="Instructions"
            htmlFor="edit-instructions"
            hint="What the agent follows. Changing it starts a new conversation."
          >
            <textarea
              id="edit-instructions"
              rows={8}
              value={draft.instructions}
              onChange={(e) => set({ instructions: e.target.value })}
              className={textArea}
            />
          </Field>
          <Field label="Folders">
            <div className="rounded-[10px] bg-sidebar p-1.5">
              <FolderList folders={draft.workspaceFolders} onChange={(workspaceFolders) => set({ workspaceFolders })} />
            </div>
          </Field>
          <div className="rounded-xl border border-modal-line px-3.5">
            <Switch checked={draft.webAccess} onChange={(webAccess) => set({ webAccess })}>
              Search the web
            </Switch>
          </div>
          {error && <p className="text-[12.5px] text-danger">{error}</p>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-divider px-4 py-3">
          <button type="button" onClick={onClose} className={secondaryButton}>
            Cancel
          </button>
          <button type="submit" disabled={!(renamed || changed) || !name.trim() || busy} className={primaryButton}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-[12px] font-semibold text-subtle">
        {label}
      </label>
      {children}
      {hint && <p className="text-[12px] leading-[17px] text-hint">{hint}</p>}
    </div>
  );
}
