// Inputs shared by the onboarding cards and the Settings panel.

import type { ReactNode } from "react";
import { backend } from "../lib/api";
import { WEEKDAYS, type Weekday } from "../lib/types";
import { CloseIcon } from "./Icons";

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
