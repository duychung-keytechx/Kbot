// `permission` messages: Claude Code asks before using a tool, or asks the user
// something with AskUserQuestion. Answered once with `answer_permission`; the
// run waits until then. Rust locks the card by setting `status`.

import { useState } from "react";
import { backend, errorText } from "../../lib/api";
import type { Message, PermissionAnswer, Question } from "../../lib/types";
import { primaryButton, secondaryButton } from "../fields";

type PermissionMessage = Extract<Message, { type: "permission" }>;

export function PermissionCard({ botId, message }: { botId: string; message: PermissionMessage }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const answer = async (a: PermissionAnswer) => {
    setBusy(true);
    setError(undefined);
    try {
      await backend.answerPermission(botId, message.id, a);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const locked = message.status !== "pending" || busy;
  const asking = message.questions.length > 0;

  return (
    <div
      data-testid="permission-card"
      className={`flex w-[420px] max-w-full flex-col gap-2.5 rounded-2xl bg-bubble p-3 ${
        message.status === "expired" ? "opacity-60" : ""
      }`}
    >
      {asking ? (
        <Questions
          questions={message.questions}
          picked={message.status === "pending" ? null : message.answers}
          locked={locked}
          onAnswer={answer}
        />
      ) : (
        <>
          <p className="text-[14px] leading-[21px] text-ink">
            May I use <span className="font-medium">{message.tool}</span>?
          </p>
          {message.summary && <p className="selectable text-[13px] leading-[19px] text-subtle">{message.summary}</p>}
          {message.detail && (
            <pre className="selectable max-h-[160px] overflow-auto rounded-[10px] bg-white px-2.5 py-2 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap text-ink">
              {message.detail}
            </pre>
          )}
          {message.status === "pending" && (
            <div className="flex gap-2">
              <button type="button" disabled={locked} onClick={() => void answer({ type: "allow" })} className={primaryButton}>
                Approve
              </button>
              <button type="button" disabled={locked} onClick={() => void answer({ type: "deny" })} className={secondaryButton}>
                Deny
              </button>
            </div>
          )}
        </>
      )}
      {message.status !== "pending" && (
        <p className="text-[12.5px] text-hint">
          {asking && message.status === "denied" ? "Skipped" : STATUS[message.status]}
        </p>
      )}
      {error && <p className="text-[12.5px] text-[#c4321c]">{error}</p>}
    </div>
  );
}

const STATUS = {
  approved: "Approved",
  denied: "Denied",
  answered: "Answered",
  expired: "Not answered in time: the run ended.",
} as const;

/** AskUserQuestion: one block of options per question. A single
 *  single-choice question is answered with one click; otherwise Submit. */
function Questions({
  questions,
  picked,
  locked,
  onAnswer,
}: {
  questions: Question[];
  /** Saved answers, once the card is answered. */
  picked: Record<string, string> | null;
  locked: boolean;
  onAnswer: (a: PermissionAnswer) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const oneClick = questions.length === 1 && !questions[0].multiSelect;
  const chosen = (q: Question) => (picked ? (picked[q.question]?.split(", ") ?? []) : (choices[q.question] ?? []));
  const toggle = (q: Question, label: string) => {
    if (oneClick) return onAnswer({ type: "answers", answers: { [q.question]: label } });
    const current = choices[q.question] ?? [];
    const next = q.multiSelect
      ? current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label]
      : [label];
    setChoices({ ...choices, [q.question]: next });
  };
  const complete = questions.every((q) => (choices[q.question] ?? []).length > 0);

  return (
    <>
      {questions.map((q) => (
        <div key={q.question} className="flex flex-col gap-1.5">
          {q.header && <p className="text-[12px] font-medium text-hint">{q.header}</p>}
          <p className="selectable text-[14px] leading-[21px] text-ink">{q.question}</p>
          <div className="flex flex-col gap-1.5">
            {q.options.map((o) => {
              const on = chosen(q).includes(o.label);
              return (
                <button
                  key={o.label}
                  type="button"
                  disabled={locked}
                  aria-pressed={on}
                  onClick={() => toggle(q, o.label)}
                  className={`flex flex-col items-start rounded-[10px] border px-2.5 py-1.5 text-left disabled:cursor-default ${
                    on ? "border-ink-strong bg-white" : "border-button-line bg-white/60 hover:bg-white"
                  } ${locked && !on ? "opacity-40" : ""}`}
                >
                  <span className="text-[13px] font-medium text-ink">{o.label}</span>
                  {o.description && <span className="text-[12px] leading-[17px] text-subtle">{o.description}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {!locked && (
        <div className="flex gap-2">
          {!oneClick && (
            <button
              type="button"
              disabled={!complete}
              onClick={() =>
                onAnswer({
                  type: "answers",
                  answers: Object.fromEntries(questions.map((q) => [q.question, choices[q.question].join(", ")])),
                })
              }
              className={primaryButton}
            >
              Submit
            </button>
          )}
          <button type="button" onClick={() => onAnswer({ type: "deny" })} className={secondaryButton}>
            Skip
          </button>
        </div>
      )}
    </>
  );
}
