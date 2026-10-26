import { type ReactNode, useEffect, useState } from "react";
import { backend, errorText } from "../lib/api";
import { type AgentConfig, type Bot, dateSchedule, DEFAULT_EVERY, DEFAULT_SCHEDULE, type Schedule } from "../lib/types";
import {
  DatePicker,
  DayPicker,
  FolderList,
  IntervalPicker,
  primaryButton,
  secondaryButton,
  textArea,
  TimeInput,
  Toggle,
  validEvery,
} from "./fields";
import { CloseIcon } from "./Icons";

const KINDS = ["Daily", "Interval", "On a date"] as const;

const kindOf = (s: Schedule): (typeof KINDS)[number] =>
  s.everyMinutes !== null ? "Interval" : s.date !== null ? "On a date" : "Daily";

/** What switching a job to `kind` changes. */
const switchTo = (kind: (typeof KINDS)[number]): Partial<Schedule> =>
  kind === "Interval"
    ? { everyMinutes: DEFAULT_EVERY, date: null, monthly: false }
    : kind === "On a date"
      ? { everyMinutes: null, date: dateSchedule().date, monthly: false }
      : { everyMinutes: null, date: null, monthly: false };

/** Edits a bot's `AgentConfig`; opened by clicking the chat header. */
export function SettingsPanel({ bot, running, onClose }: { bot: Bot; running: boolean; onClose: () => void }) {
  const [draft, setDraft] = useState<AgentConfig>(bot.config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const dirty = JSON.stringify(draft) !== JSON.stringify(bot.config);

  // Another change (e.g. setup finishing) replaces an untouched draft;
  // `dirty` is left out of the deps so typing doesn't reset it.
  useEffect(() => {
    if (!dirty) setDraft(bot.config);
  }, [bot.config]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await f();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<AgentConfig>) => setDraft((d) => ({ ...d, ...patch }));
  const schedule = draft.schedule;
  const setSchedule = (patch: Partial<NonNullable<AgentConfig["schedule"]>>) =>
    schedule && set({ schedule: { ...schedule, ...patch } });

  return (
    <aside
      data-testid="settings-panel"
      className="flex w-[340px] shrink-0 flex-col border-l border-line bg-main"
      aria-label={`${bot.name} settings`}
    >
      <div data-tauri-drag-region className="flex h-11 shrink-0 items-center justify-between border-b border-line px-4">
        <p className="text-[13.5px] font-medium text-ink">Settings</p>
        <button type="button" aria-label="Close settings" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        <Section label="Description">
          <textarea
            rows={3}
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
            className={textArea}
          />
        </Section>
        <Section label="Instructions" hint="What the agent follows. Changing it starts a new conversation with Claude.">
          <textarea
            rows={7}
            value={draft.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            className={textArea}
          />
        </Section>

        <Section label="Scheduled job">
          <Toggle
            checked={!!schedule}
            onChange={(on) => set({ schedule: on ? { ...DEFAULT_SCHEDULE, task: draft.description } : null })}
          >
            Run a job by itself while Kbot is open
          </Toggle>
          {schedule && (
            <>
              <div className="flex gap-1.5" role="group" aria-label="Runs">
                {KINDS.map((kind) => {
                  const on = kindOf(schedule) === kind;
                  return (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={on}
                      onClick={() => !on && setSchedule(switchTo(kind))}
                      className={`h-7 rounded-full px-3 text-[12.5px] font-medium ${
                        on ? "bg-ink-strong text-white" : "border border-button-line bg-white text-subtle"
                      }`}
                    >
                      {kind}
                    </button>
                  );
                })}
              </div>
              {schedule.date !== null ? (
                <DatePicker date={schedule.date} monthly={schedule.monthly} onChange={setSchedule}>
                  <TimeInput value={schedule.time} onChange={(time) => setSchedule({ time })} />
                </DatePicker>
              ) : schedule.everyMinutes === null ? (
                <div className="flex flex-wrap items-center gap-3">
                  <TimeInput value={schedule.time} onChange={(time) => setSchedule({ time })} />
                  <DayPicker days={schedule.days} onChange={(days) => setSchedule({ days })} />
                </div>
              ) : (
                <>
                  {/* Keyed so a reset draft doesn't keep the picker's custom amount. */}
                  <IntervalPicker
                    key={`${bot.id}:${bot.config.schedule?.everyMinutes}`}
                    minutes={schedule.everyMinutes}
                    onChange={(everyMinutes) => setSchedule({ everyMinutes })}
                  />
                  <DayPicker days={schedule.days} onChange={(days) => setSchedule({ days })} />
                </>
              )}
              <Toggle checked={schedule.notify} onChange={(notify) => setSchedule({ notify })}>
                Notify me when it's done
              </Toggle>
              <textarea
                rows={3}
                aria-label="Each run"
                placeholder="What to do on each run"
                value={schedule.task}
                onChange={(e) => setSchedule({ task: e.target.value })}
                className={textArea}
              />
              {bot.lastRunAt && (
                <p className="text-[12px] text-hint">Last run: {new Date(bot.lastRunAt).toLocaleString()}</p>
              )}
            </>
          )}
        </Section>

        <Section label="Access">
          <Toggle checked={draft.webAccess} onChange={(webAccess) => set({ webAccess })}>
            Search the web
          </Toggle>
          <p className="text-[12px] text-hint">Folders it works with:</p>
          <FolderList folders={draft.workspaceFolders} onChange={(workspaceFolders) => set({ workspaceFolders })} />
        </Section>

        <Section label="Model" hint="A Claude Code model name, like sonnet or opus. Empty uses the default model from Kbot Settings.">
          <input
            value={draft.model ?? ""}
            placeholder="Default"
            spellCheck={false}
            onChange={(e) => set({ model: e.target.value || null })}
            className="rounded-[8px] border border-field-line bg-white px-2.5 py-1.5 text-[13.5px] text-ink"
          />
        </Section>

        {error && <p className="text-[12.5px] text-[#c4321c]">{error}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <button
          type="button"
          disabled={
            !dirty ||
            busy ||
            (schedule?.everyMinutes != null && !validEvery(schedule.everyMinutes)) ||
            schedule?.date === ""
          }
          onClick={() => void act(() => backend.updateBotConfig(bot.id, draft))}
          className={primaryButton}
        >
          Save
        </button>
        {bot.config.schedule && (
          <button
            type="button"
            disabled={busy || running || dirty}
            title={dirty ? "Save first" : undefined}
            onClick={() => void act(() => backend.runNow(bot.id))}
            className={secondaryButton}
          >
            Run now
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          disabled={busy || running}
          onClick={() =>
            void act(async () => {
              await backend.redoSetup(bot.id);
              onClose();
            })
          }
          className="text-[12.5px] text-subtle underline disabled:opacity-50"
        >
          Redo setup
        </button>
      </div>
    </aside>
  );
}

function Section({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <p className="text-[12px] font-semibold text-subtle">{label}</p>
      {children}
      {hint && <p className="text-[12px] leading-[17px] text-hint">{hint}</p>}
    </section>
  );
}
