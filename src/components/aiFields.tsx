import { type ReactNode, useEffect, useState } from "react";
import { backend } from "../lib/api";
import type { ClaudeStatus, CodexModels, CodexStatus, Effort } from "../lib/types";

// The AI agent, model and effort pickers of Kbot > Settings…, also used by a
// bot's Edit > AI Provider to pick its own.

/** One radio row of a model list; `id` null = "whatever the CLI is set up to use". */
export interface ModelOption {
  id: string | null;
  name: string;
  description: string;
  /** A tag at the end of the row, like "Default". */
  badge?: string;
}

export const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", name: "Opus 5.5", description: "Most capable, for complex, long-running work" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", description: "Balanced speed and quality for everyday bots" },
  { id: "claude-haiku-5-5", name: "Haiku 5.5", description: "Fastest and cheapest, for light tasks" },
];

export const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

/** "Sonnet 5.5" for a listed Claude model, else the id as typed. */
export const claudeModelName = (id: string) => CLAUDE_MODELS.find((m) => m.id === id)?.name ?? id;

/** The models Codex offers, loaded while `enabled`. */
export function useCodexModels(enabled: boolean): CodexModels | undefined {
  const [models, setModels] = useState<CodexModels>();
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    backend
      .codexModels()
      .then((m) => alive && setModels(m))
      .catch((e) => console.error(e));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return models;
}

/** The model from the Codex config (or Codex's own pick) as the default, then the models Codex offers. */
export function codexOptions({ configured, models }: CodexModels, badge = "Default"): ModelOption[] {
  const fallback: ModelOption = configured
    ? { id: null, name: configured, description: "From your Codex config", badge }
    : { id: null, name: "Codex default", description: "The model Codex picks", badge };
  return [
    fallback,
    ...models.filter((m) => m.id !== configured).map((m) => ({ id: m.id, name: m.id, description: m.description })),
  ];
}

/** Adds a row for a saved model that isn't listed (typed in before, or no longer offered). */
export function withSaved(options: ModelOption[], saved: string | null): ModelOption[] {
  if (saved === null || options.some((o) => o.id === saved)) return options;
  return [...options, { id: saved, name: saved, description: "Custom model" }];
}

function statusText(status: ClaudeStatus | CodexStatus, setupHint: string): string {
  switch (status.state) {
    case "ready":
      if ("subscription" in status) return "Claude Code is installed and signed in";
      return status.account === "ChatGPT" || status.account === "an API key"
        ? "Codex CLI is installed and signed in"
        : `Codex CLI is installed and set up with ${status.account}`;
    case "notInstalled":
      return `Not installed yet. ${setupHint}`;
    case "loggedOut":
      return `Installed but not signed in. ${setupHint}`;
    case "notSubscription":
      return `Claude Code is signed in with ${status.authMethod}, not a Claude subscription`;
  }
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="shrink-0 text-[13px] text-icon">{children}</p>;
}

/** Whether the provider's CLI is ready; `setupHint` says where its setup steps are. */
export function StatusLine({
  status,
  checking,
  onCheck,
  setupHint,
}: {
  status: ClaudeStatus | CodexStatus | undefined;
  checking: boolean;
  onCheck: () => void;
  setupHint: string;
}) {
  const dot = !status ? "bg-muted" : status.state === "ready" ? "bg-ok" : "bg-danger";
  return (
    <div className="flex shrink-0 items-center gap-1.5 text-[12px] text-icon" data-testid="provider-status">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <p>{status ? statusText(status, setupHint) : "Checking…"}</p>
      {status && status.state !== "ready" && (
        <button type="button" disabled={checking} onClick={onCheck} className="ml-1 font-medium text-ink hover:underline disabled:opacity-50">
          {checking ? "Checking…" : "Check again"}
        </button>
      )}
    </div>
  );
}

export function SettingCard({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-4 rounded-xl border border-modal-line py-3 pr-3 pl-4">
      <div className="flex flex-col gap-0.5">
        <p className="text-[14px] font-medium text-ink">{label}</p>
        <p className="text-[12px] text-hint">{description}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * A row of mutually exclusive buttons that fills the width, or with `small`
 * the compact kind that sits at the end of a setting card.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  small,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  small?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`flex shrink-0 bg-bubble ${small ? "gap-0.5 rounded-lg p-0.5" : "gap-[3px] rounded-[10px] p-[3px]"}`}
    >
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => on || onChange(o.id)}
            className={`flex items-center justify-center gap-1.5 font-medium ${
              small ? "rounded-md px-2.5 py-[5px] text-[13px]" : "flex-1 rounded-lg px-3 py-[7px] text-[14px]"
            } ${on ? "bg-raised text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]" : "text-icon hover:text-ink"}`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ModelList({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ModelOption[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-modal-line">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id ?? ""}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => on || onChange(o.id)}
            className={`flex items-center gap-3 border-divider px-4 py-2.5 text-left not-first:border-t ${
              on ? "bg-sidebar" : "hover:bg-row-hover"
            }`}
          >
            <span
              className={`flex size-4 shrink-0 items-center justify-center rounded-full ${
                on ? "bg-ink" : "border-[1.5px] border-radio-line"
              }`}
            >
              {on && <span className="size-1.5 rounded-full bg-ink-inverse" />}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[14px] font-medium text-ink">{o.name}</span>
              <span className="text-[12px] text-hint">{o.description}</span>
            </span>
            {o.badge && (
              <span className="shrink-0 rounded-md bg-row-active px-2 py-[3px] text-[11px] font-medium text-icon">{o.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
