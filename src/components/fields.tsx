// Inputs shared by the onboarding cards and the Settings panel.

import { type ReactNode, useState } from "react";
import { backend } from "../lib/api";
import { isoDate, MAX_EVERY, MIN_EVERY, type Schedule, WEEKDAYS, type Weekday } from "../lib/types";
import { ChevronDownIcon, CloseIcon } from "./Icons";

const DAY_LETTERS: Record<Weekday, string> = { mon: "M", tue: "T", wed: "W", thu: "T", fri: "F", sat: "S", sun: "S" };
const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export const primaryButton =
  "rounded-[15px] bg-ink-strong px-[13px] py-1.5 text-[13px] font-medium text-white disabled:opacity-50";
export const secondaryButton =
  "rounded-[15px] border border-button-line bg-white px-[13px] py-1.5 text-[13px] font-medium text-ink disabled:opacity-50";
export const textArea =
  "selectable w-full resize-none rounded-[10px] border border-field-line bg-white px-2.5 py-2 text-[13.5px] leading-[20px] text-ink";

/** Same wording as `agent::describe_days` in Rust. */
export function describeDays(days: Weekday[]): string {
  if (WEEKDAYS.every((d) => days.includes(d))) return "every day";
  const weekdays = WEEKDAYS.slice(0, 5);
  if (weekdays.every((d) => days.includes(d)) && !days.includes("sat") && !days.includes("sun")) return "weekdays";
  return WEEKDAYS.filter((d) => days.includes(d))
    .map((d) => d[0].toUpperCase() + d.slice(1))
    .join(", ");
}

/** Same wording as `agent::describe_every` in Rust: "15 min", "1 hour", "90 min". */
export function describeEvery(minutes: number): string {
  if (minutes === 60) return "1 hour";
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} min`;
}

/** Same wording as `agent::ordinal` in Rust: "1st", "2nd", "11th", "23rd". */
export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** "YYYY-MM-DD" as a local date. */
const parseDate = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d);
};

/** Same wording as `agent::describe_date` in Rust: "once on Fri, Oct 30, 2026" or "monthly on the 30th". */
export function describeDate(date: string, monthly: boolean): string {
  const d = parseDate(date);
  return monthly
    ? `monthly on the ${ordinal(d.getDate())}`
    : `once on ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}`;
}

/** "every day at 08:00", "every 15 min, weekdays" or "monthly on the 1st at 09:00". */
export function describeSchedule(s: Pick<Schedule, "time" | "days" | "everyMinutes" | "date" | "monthly">): string {
  if (s.everyMinutes !== null) return `every ${describeEvery(s.everyMinutes)}, ${describeDays(s.days)}`;
  if (s.date !== null) return `${describeDate(s.date, s.monthly)} at ${s.time}`;
  return `${describeDays(s.days)} at ${s.time}`;
}

export const validEvery = (minutes: number) => Number.isInteger(minutes) && minutes >= MIN_EVERY && minutes <= MAX_EVERY;

const PRESETS = [15, 30, 60];

const chip = (on: boolean) =>
  `h-7 rounded-full px-3 text-[12.5px] font-medium disabled:opacity-60 ${
    on ? "bg-ink-strong text-white" : "border border-button-line bg-white text-subtle"
  }`;

/** How often an interval job runs: 15 min, 30 min, 1 hour or a custom number of minutes or hours. */
export function IntervalPicker({
  minutes,
  onChange,
  disabled,
}: {
  minutes: number;
  onChange: (minutes: number) => void;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState(!PRESETS.includes(minutes));
  const [hours, setHours] = useState(minutes >= 60 && minutes % 60 === 0);
  const [amount, setAmount] = useState(String(hours ? minutes / 60 : minutes));
  // 1.5 hours is 90 minutes; an empty or bad amount gives 0 or NaN, which `validEvery` rejects.
  const toMinutes = (amount: string, hours: boolean) => Math.round(Number(amount || NaN) * (hours ? 60 : 1));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Interval">
        {PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={!custom && minutes === n}
            disabled={disabled}
            onClick={() => {
              setCustom(false);
              onChange(n);
            }}
            className={chip(!custom && minutes === n)}
          >
            {describeEvery(n)}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={custom}
          disabled={disabled}
          onClick={() => {
            setCustom(true);
            onChange(toMinutes(amount, hours));
          }}
          className={chip(custom)}
        >
          Custom
        </button>
      </div>
      {custom && (
        <div className="flex items-center gap-2 text-[13.5px] text-ink">
          Every
          <input
            type="number"
            aria-label="Every"
            min={hours ? 1 : MIN_EVERY}
            step={hours ? 0.5 : 1}
            value={amount}
            disabled={disabled}
            onChange={(e) => {
              setAmount(e.target.value);
              onChange(toMinutes(e.target.value, hours));
            }}
            className="w-[70px] rounded-[8px] border border-field-line bg-white px-2 py-1 text-[13.5px] text-ink disabled:opacity-60"
          />
          <span className="relative flex items-center">
            <select
              aria-label="Unit"
              value={hours ? "hours" : "minutes"}
              disabled={disabled}
              onChange={(e) => {
                const h = e.target.value === "hours";
                setHours(h);
                onChange(toMinutes(amount, h));
              }}
              className="appearance-none rounded-[8px] border border-field-line bg-white py-1 pr-6 pl-2 text-[13.5px] text-ink disabled:opacity-60"
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-2" />
          </span>
        </div>
      )}
      {!validEvery(minutes) && !disabled && (
        <p className="text-[12px] text-[#c4321c]">{`Pick from ${MIN_EVERY} minutes to 24 hours.`}</p>
      )}
    </div>
  );
}

export function TimeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (time: string) => void;
  disabled?: boolean;
}) {
  return (
    <input
      type="time"
      aria-label="Time"
      value={value}
      disabled={disabled}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="rounded-[8px] border border-field-line bg-white px-2 py-1 text-[13.5px] text-ink disabled:opacity-60"
    />
  );
}

/** The date of a task on a date and whether it repeats monthly; `children` (the time) go next to the date. */
export function DatePicker({
  date,
  monthly,
  onChange,
  disabled,
  children,
}: {
  date: string;
  monthly: boolean;
  onChange: (patch: { date?: string; monthly?: boolean }) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const day = date ? parseDate(date).getDate() : 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="date"
          aria-label="Date"
          value={date}
          min={isoDate(new Date())}
          disabled={disabled}
          onChange={(e) => e.target.value && onChange({ date: e.target.value })}
          className="rounded-[8px] border border-field-line bg-white px-2 py-1 text-[13.5px] text-ink disabled:opacity-60"
        />
        {children}
      </div>
      <Toggle checked={monthly} onChange={(monthly) => onChange({ monthly })} disabled={disabled}>
        {day ? `Repeat every month on the ${ordinal(day)}` : "Repeat every month"}
      </Toggle>
      {monthly && day > 28 && (
        <p className="text-[12px] text-hint">In shorter months, I'll run on the last day of the month.</p>
      )}
    </div>
  );
}

export function DayPicker({
  days,
  onChange,
  disabled,
}: {
  days: Weekday[];
  onChange: (days: Weekday[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-1">
      {WEEKDAYS.map((d) => {
        const on = days.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-label={DAY_NAMES[d]}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? days.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || days.includes(x)))}
            className={`size-7 rounded-full text-[12px] font-medium disabled:opacity-60 ${
              on ? "bg-ink-strong text-white" : "border border-button-line bg-white text-subtle"
            }`}
          >
            {DAY_LETTERS[d]}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-[13.5px] text-ink">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-[15px] accent-ink-strong"
      />
      {children}
    </label>
  );
}

/** An on/off switch at the end of a labelled row, as in macOS settings. */
export function Switch({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex min-h-[46px] items-center justify-between gap-4 text-[13.5px] text-ink">
      {children}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-[22px] w-[36px] shrink-0 rounded-full transition-colors ${
          checked ? "bg-switch-on" : "bg-switch-off"
        }`}
      >
        <span
          className={`absolute top-[2px] left-[2px] size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform ${
            checked ? "translate-x-[14px]" : ""
          }`}
        />
      </button>
    </label>
  );
}

/** Folder list with remove buttons and a native "Add folder" picker; `children` go next to it. */
export function FolderList({
  folders,
  onChange,
  disabled,
  children,
}: {
  folders: string[];
  onChange: (folders: string[]) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const add = async () => {
    const folder = await backend.pickFolder();
    if (folder && !folders.includes(folder)) onChange([...folders, folder]);
  };
  return (
    <div className="flex flex-col gap-1.5">
      {folders.map((f) => (
        <div key={f} className="flex items-center gap-2 rounded-[8px] bg-white px-2.5 py-1.5">
          <p className="selectable min-w-0 flex-1 truncate text-[13px] text-ink" title={f}>
            {f}
          </p>
          {!disabled && (
            <button type="button" aria-label={`Remove ${f}`} onClick={() => onChange(folders.filter((x) => x !== f))}>
              <CloseIcon />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void add()} className={secondaryButton}>
            Add folder
          </button>
          {children}
        </div>
      )}
    </div>
  );
}
