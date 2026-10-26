// Onboarding cards (`setup*` messages, see src-tauri/src/setup.rs). Each one
// is answered once with `answer_setup`; Rust then locks it by setting
// `selected` / `submitted` / `confirmed` on the message. `/setup` on a set-up
// bot shows `SetupCurrentCard`, then a review card for each change.

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

function CardFrame({
  title,
  error,
  faded,
  children,
}: {
  title?: string;
  error?: string;
  faded?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid="setup-card"
      className={`flex w-[420px] max-w-full flex-col gap-2.5 rounded-2xl bg-bubble p-3 ${faded ? "opacity-60" : ""}`}
    >
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
    <CardFrame title="Any folders I should look into?" error={error}>
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
  const { config, previous } = message;
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState(config.instructions);
  const [task, setTask] = useState(config.schedule?.task ?? "");
  const closed = message.confirmed || message.discarded;
  const locked = closed || busy;
  const confirm = (c: { instructions: string; task: string }) =>
    void answer({ type: "review", instructions: c.instructions, task: config.schedule ? c.task : null });
  // A `/setup` change marks what differs from the saved setup.
  const changed = (f: (c: AgentConfig) => unknown) => !!previous && JSON.stringify(f(config)) !== JSON.stringify(f(previous));
  const title = previous ? "Here's my updated setup. Save it?" : "Here's my setup. Look good?";

  return (
    <CardFrame title={closed ? undefined : title} error={error} faded={message.discarded}>
      <Summary config={config} previous={previous} />
      {previous && (
        <Field label="Description" changed={changed((c) => c.description)}>
          <p className="selectable text-[13.5px] leading-[20px] whitespace-pre-wrap text-ink">{config.description}</p>
        </Field>
      )}
      {editing && !closed ? (
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
          <Field label="Instructions" changed={changed((c) => c.instructions)}>
            <p className="selectable text-[13.5px] leading-[20px] whitespace-pre-wrap text-ink">{config.instructions}</p>
          </Field>
          {config.schedule && (
            <Field label="Each run" changed={changed((c) => c.schedule?.task)}>
              <p className="selectable text-[13.5px] leading-[20px] whitespace-pre-wrap text-ink">{config.schedule.task}</p>
            </Field>
          )}
        </>
      )}
      {message.confirmed ? (
        <p className="text-[12.5px] text-hint">{previous ? "Saved" : "Confirmed"}</p>
      ) : message.discarded ? (
        <p className="text-[12.5px] text-hint">Not saved</p>
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
            {previous ? "Save" : "Looks good"}
          </button>
          <button type="button" disabled={locked} onClick={() => setEditing(true)} className={secondaryButton}>
            Edit
          </button>
        </div>
      )}
    </CardFrame>
  );
}

/** `/setup` on a set-up bot: everything it runs with, and how to change it. */
export function SetupCurrentCard({ config }: { config: AgentConfig }) {
  return (
    <CardFrame title="Here's my current setup.">
      <Summary config={config} />
      <Field label="Description">
        <p className="selectable text-[13.5px] leading-[20px] whitespace-pre-wrap text-ink">
          {config.description || "None"}
        </p>
      </Field>
      <Field label="Instructions">
        <p className="selectable text-[13.5px] leading-[20px] whitespace-pre-wrap text-ink">
          {config.instructions || "None"}
        </p>
      </Field>
      {config.schedule && (
        <Field label="Each run">
          <p className="selectable text-[13.5px] leading-[20px] whitespace-pre-wrap text-ink">{config.schedule.task}</p>
        </Field>
      )}
      <div className="flex flex-col gap-1 border-t border-line pt-2.5 text-[13px] leading-[19px] text-ink">
        <p className="font-medium">To change anything, just tell me what you want, for example:</p>
        <ul className="list-disc pl-5 text-subtle">
          <li>Run at 7:00 on weekdays only</li>
          <li>Keep answers under 5 bullet points</li>
          <li>Turn off web search, and also read ~/Documents/reports</li>
        </ul>
        <p className="text-hint">I'll show you the change before I save it.</p>
      </div>
    </CardFrame>
  );
}

function Summary({ config, previous }: { config: AgentConfig; previous?: AgentConfig | null }) {
  const describe = (c: AgentConfig): [string, string][] => [
    ["Kind", c.schedule ? `Daily job, ${describeDays(c.schedule.days)} at ${c.schedule.time}` : "Chat"],
    ["Notify", c.schedule ? (c.schedule.notify ? "When a run is done" : "Off") : ""],
    ["Web", c.webAccess ? "Can search the web" : "No web access"],
    ["Folders", c.workspaceFolders.length ? c.workspaceFolders.join(", ") : "None"],
  ];
  const before = previous ? describe(previous) : null;
  return (
    <div className="flex flex-col gap-1">
      {describe(config).map(([k, v], i) =>
        v ? (
          <div key={k} className="flex gap-2 text-[13px] leading-[19px]">
            <p className="w-[60px] shrink-0 text-hint">{k}</p>
            <p className="selectable min-w-0 flex-1 break-words text-ink">
              {v}
              {before && before[i][1] !== v && <Changed />}
            </p>
          </div>
        ) : null,
      )}
    </div>
  );
}

function Field({ label, changed, children }: { label: string; changed?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[12px] font-medium text-hint">
        {label}
        {changed && <Changed />}
      </p>
      {children}
    </div>
  );
}

function Changed() {
  return (
    <span className="ml-1.5 rounded-full bg-white px-1.5 py-px text-[11px] font-medium text-ink-strong">changed</span>
  );
}
