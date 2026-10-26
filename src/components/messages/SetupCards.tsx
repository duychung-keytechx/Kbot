// Onboarding cards (`setup*` messages, see src-tauri/src/setup.rs). Each one
// is answered once with `answer_setup`; Rust then locks it by setting
// `selected` / `submitted` / `confirmed` on the message.

import { type ReactNode, useState } from "react";
import { backend, errorText } from "../../lib/api";
import type { AgentConfig, Message, SetupAnswer, Weekday } from "../../lib/types";
import {
  DayPicker,
  describeDays,
  FolderList,
  primaryButton,
  secondaryButton,
  textArea,
  TimeInput,
  Toggle,
} from "../fields";

type Card<T extends Message["type"]> = { botId: string; message: Extract<Message, { type: T }> };

/** Sends an answer and keeps the error, if any, for the card to show. */
function useAnswer(botId: string, messageId: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const answer = async (a: SetupAnswer) => {
    setBusy(true);
    setError(undefined);
    try {
      await backend.answerSetup(botId, messageId, a);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, answer };
}

function CardFrame({ title, error, children }: { title?: string; error?: string; children: ReactNode }) {
  return (
    <div data-testid="setup-card" className="flex w-[420px] max-w-full flex-col gap-2.5 rounded-2xl bg-bubble p-3">
      {title && <p className="text-[14px] leading-[21px] text-ink">{title}</p>}
      {children}
      {error && <p className="text-[12.5px] text-[#c4321c]">{error}</p>}
    </div>
  );
}

export function SetupChoiceCard({ botId, message }: Card<"setupChoice">) {
  const { busy, error, answer } = useAnswer(botId, message.id);
  const locked = message.selected !== null || busy;
  return (
    <CardFrame title={message.question} error={error}>
      <div className="flex flex-wrap items-center gap-2">
        {message.options.map((option, i) => {
          const chosen = message.selected === option;
          const primary = message.selected === null ? i === 0 : chosen;
          return (
            <button
              key={option}
              type="button"
              disabled={locked}
              aria-pressed={chosen}
              onClick={() => void answer({ type: "choice", option })}
              // Once answered, the choice stays solid and the others fade.
              className={`${primary ? primaryButton : secondaryButton} disabled:cursor-default ${
                chosen ? "disabled:opacity-100" : message.selected !== null ? "disabled:opacity-40" : ""
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </CardFrame>
  );
}

export function SetupScheduleCard({ botId, message }: Card<"setupSchedule">) {
  const { busy, error, answer } = useAnswer(botId, message.id);
  const [time, setTime] = useState(message.time);
  const [days, setDays] = useState<Weekday[]>(message.days);
  const [notify, setNotify] = useState(message.notify);
  const locked = message.submitted || busy;
  const shown = message.submitted ? { time: message.time, days: message.days, notify: message.notify } : { time, days, notify };
  return (
    <CardFrame title="When should I run each day?" error={error}>
      <div className="flex flex-wrap items-center gap-3">
        <TimeInput value={shown.time} onChange={setTime} disabled={locked} />
        <DayPicker days={shown.days} onChange={setDays} disabled={locked} />
      </div>
      <Toggle checked={shown.notify} onChange={setNotify} disabled={locked}>
        Notify me when it's done
      </Toggle>
      {message.submitted ? (
        <p className="text-[12.5px] text-hint">
          {describeDays(message.days)} at {message.time}
        </p>
      ) : (
        <button
          type="button"
          disabled={locked || days.length === 0}
          onClick={() => void answer({ type: "schedule", time, days, notify })}
          className={`${primaryButton} self-start`}
        >
          Continue
        </button>
      )}
    </CardFrame>
  );
}

export function SetupFoldersCard({ botId, message }: Card<"setupFolders">) {
  const { busy, error, answer } = useAnswer(botId, message.id);
  const [folders, setFolders] = useState<string[]>(message.folders);
  const locked = message.submitted || busy;
  const shown = message.submitted ? message.folders : folders;
  return (
    <CardFrame title="Any folders I should look into? I can read them, never change them." error={error}>
      {message.submitted && shown.length === 0 ? (
        <p className="text-[12.5px] text-hint">No folders</p>
      ) : (
        <FolderList folders={shown} onChange={setFolders} disabled={locked}>
          <button
            type="button"
            disabled={locked}
            onClick={() => void answer({ type: "folders", folders })}
            className={folders.length ? primaryButton : secondaryButton}
          >
            {folders.length ? "Continue" : "Skip"}
          </button>
        </FolderList>
      )}
    </CardFrame>
  );
}

export function SetupReviewCard({ botId, message }: Card<"setupReview">) {
  const { busy, error, answer } = useAnswer(botId, message.id);
  const { config } = message;
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState(config.instructions);
  const [task, setTask] = useState(config.schedule?.task ?? "");
  const locked = message.confirmed || busy;
  const confirm = (c: { instructions: string; task: string }) =>
    void answer({ type: "review", instructions: c.instructions, task: config.schedule ? c.task : null });

  return (
    <CardFrame title={message.confirmed ? undefined : "Here's my setup. Look good?"} error={error}>
      <Summary config={config} />
      {editing && !message.confirmed ? (
        <>
          <Field label="Instructions">
            <textarea rows={6} value={instructions} onChange={(e) => setInstructions(e.target.value)} className={textArea} />
          </Field>
          {config.schedule && (
            <Field label="Each run">
              <textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} className={textArea} />
            </Field>
          )}
        </>
      ) : (
        <>
          <Field label="Instructions">
            <p className="selectable text-[13.5px] leading-[20px] whitespace-pre-wrap text-ink">{config.instructions}</p>
          </Field>
          {config.schedule && (
            <Field label="Each run">
              <p className="selectable text-[13.5px] leading-[20px] whitespace-pre-wrap text-ink">{config.schedule.task}</p>
            </Field>
          )}
        </>
      )}
      {message.confirmed ? (
        <p className="text-[12.5px] text-hint">Confirmed</p>
      ) : editing ? (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={locked || !instructions.trim()}
            onClick={() => confirm({ instructions, task })}
            className={primaryButton}
          >
            Save
          </button>
          <button type="button" disabled={locked} onClick={() => setEditing(false)} className={secondaryButton}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={locked}
            onClick={() => confirm({ instructions: config.instructions, task: config.schedule?.task ?? "" })}
            className={primaryButton}
          >
            Looks good
          </button>
          <button type="button" disabled={locked} onClick={() => setEditing(true)} className={secondaryButton}>
            Edit
          </button>
        </div>
      )}
    </CardFrame>
  );
}

function Summary({ config }: { config: AgentConfig }) {
  const rows: [string, string][] = [
    ["Kind", config.schedule ? `Daily job, ${describeDays(config.schedule.days)} at ${config.schedule.time}` : "Chat"],
    ["Web", config.webAccess ? "Can search the web" : "No web access"],
    ["Folders", config.workspaceFolders.length ? config.workspaceFolders.join(", ") : "None"],
  ];
  return (
    <div className="flex flex-col gap-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[13px] leading-[19px]">
          <p className="w-[60px] shrink-0 text-hint">{k}</p>
          <p className="selectable min-w-0 flex-1 break-words text-ink">{v}</p>
        </div>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[12px] font-medium text-hint">{label}</p>
      {children}
    </div>
  );
}
