import { type ReactNode, useEffect, useState } from "react";
import { backend, errorText } from "../lib/api";
import { useClaudeStatus, useCodexStatus } from "../lib/hooks";
import { applyTheme } from "../lib/theme";
import type { AppSettings, ClaudeStatus, CodexModels, CodexStatus, Effort, Provider, Theme } from "../lib/types";
import { CircleIcon, CloseIcon, MoonIcon, SparkleIcon, SunIcon } from "./Icons";

const TABS = [
  { id: "general", label: "General", icon: <CircleIcon /> },
  { id: "providers", label: "AI Providers", icon: <SparkleIcon /> },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** One radio row of a model list; `id` null = "whatever the CLI is set up to use". */
interface ModelOption {
  id: string | null;
  name: string;
  description: string;
  isDefault?: boolean;
}

const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-opus-5-5", name: "Opus 5.5", description: "Most capable, for complex, long-running work" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", description: "Balanced speed and quality for everyday bots", isDefault: true },
  { id: "claude-haiku-5-5", name: "Haiku 5.5", description: "Fastest and cheapest, for light tasks" },
];

const EFFORTS: { id: Effort; label: string }[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

/** Kbot > Settings… (⌘,): app-wide preferences, saved as soon as they change. */
export function AppSettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<AppSettings>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    backend
      .getAppSettings()
      .then((s) => alive && setSettings(s))
      .catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Shows the change at once and puts it back if saving fails.
  const save = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setError(undefined);
    setSettings(next);
    applyTheme(next.theme);
    try {
      setSettings(await backend.updateAppSettings(next));
    } catch (e) {
      setSettings(settings);
      applyTheme(settings.theme);
      setError(errorText(e));
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-scrim p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onMouseDown={(e) => e.stopPropagation()}
        className="relative flex h-[660px] max-h-full w-[720px] max-w-full overflow-hidden rounded-2xl border border-modal-line bg-surface shadow-[0_20px_50px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.06)]"
      >
        <nav role="tablist" aria-orientation="vertical" className="flex w-[200px] shrink-0 flex-col gap-0.5 bg-sidebar px-3 py-4">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[14px] font-medium text-ink ${
                t.id === tab ? "bg-row-active" : "hover:bg-row-hover"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>

        <div
          role="tabpanel"
          aria-labelledby="settings-tab-title"
          className="flex min-w-0 flex-1 flex-col gap-2.5 overflow-y-auto pt-6 pr-7 pb-7 pl-8"
        >
          <div className="flex shrink-0 items-center justify-between pb-3.5">
            <h2 id="settings-tab-title" className="text-[18px] font-semibold text-ink">
              {TABS.find((t) => t.id === tab)?.label}
            </h2>
            <button
              type="button"
              aria-label="Close settings"
              onClick={onClose}
              className="flex size-7 items-center justify-center rounded-lg hover:bg-bubble"
            >
              <CloseIcon />
            </button>
          </div>
          {settings && tab === "general" && <General settings={settings} save={save} />}
          {settings && tab === "providers" && <Providers settings={settings} save={save} />}
          {error && <p className="text-[12.5px] text-danger">{error}</p>}
        </div>
      </div>
    </div>
  );
}

type TabProps = { settings: AppSettings; save: (patch: Partial<AppSettings>) => Promise<void> };

function General({ settings, save }: TabProps) {
  return (
    <>
      <SectionLabel>Appearance</SectionLabel>
      <SettingCard label="Theme" description="Choose how Kbot looks">
        <Segmented<Theme>
          label="Theme"
          small
          value={settings.theme}
          options={[
            { id: "light", label: "Light", icon: <SunIcon /> },
            { id: "dark", label: "Dark", icon: <MoonIcon /> },
          ]}
          onChange={(theme) => void save({ theme })}
        />
      </SettingCard>
    </>
  );
}

function Providers({ settings, save }: TabProps) {
  const { provider } = settings;
  const claude = useClaudeStatus(provider === "claude");
  const codex = useCodexStatus(provider === "codex");
  const cli = provider === "claude" ? claude : codex;

  const [codexModels, setCodexModels] = useState<CodexModels>();
  useEffect(() => {
    if (provider !== "codex") return;
    let alive = true;
    backend
      .codexModels()
      .then((m) => alive && setCodexModels(m))
      .catch((e) => console.error(e));
    return () => {
      alive = false;
    };
  }, [provider]);

  return (
    <>
      <SectionLabel>AI agent</SectionLabel>
      <Segmented<Provider>
        label="AI agent"
        value={provider}
        options={[
          { id: "claude", label: "Claude" },
          { id: "codex", label: "Codex" },
        ]}
        onChange={(provider) => void save({ provider })}
      />
      <StatusLine status={cli.status} checking={cli.checking} onCheck={cli.check} />
      <div className="h-2.5 shrink-0" />

      {provider === "claude" ? (
        <>
          <SectionLabel>Claude model</SectionLabel>
          <ModelList
            label="Claude model"
            options={withSaved(CLAUDE_MODELS, settings.defaultModel)}
            value={settings.defaultModel}
            onChange={(defaultModel) => defaultModel && void save({ defaultModel })}
          />
        </>
      ) : (
        <>
          <SectionLabel>Codex model</SectionLabel>
          {codexModels && (
            <ModelList
              label="Codex model"
              options={withSaved(codexOptions(codexModels), settings.codexModel)}
              value={settings.codexModel}
              onChange={(codexModel) => void save({ codexModel })}
            />
          )}
        </>
      )}

      <SettingCard label="Reasoning effort" description="Higher thinks longer before acting">
        <Segmented<Effort>
          label="Reasoning effort"
          small
          value={settings.effort}
          options={EFFORTS}
          onChange={(effort) => void save({ effort })}
        />
      </SettingCard>
      <p className="text-[12px] leading-[17px] text-hint">
        The model Kbot asks {provider === "claude" ? "Claude Code" : "Codex"} to use. A bot can pick its own in its
        settings.
      </p>
    </>
  );
}

function statusText(status: ClaudeStatus | CodexStatus): string {
  switch (status.state) {
    case "ready":
      if ("subscription" in status) return "Claude Code is installed and signed in";
      return status.account === "ChatGPT" || status.account === "an API key"
        ? "Codex CLI is installed and signed in"
        : `Codex CLI is installed and set up with ${status.account}`;
    case "notInstalled":
      return "Not installed yet. Close Settings to see the setup steps.";
    case "loggedOut":
      return "Installed but not signed in. Close Settings to see the setup steps.";
    case "notSubscription":
      return `Claude Code is signed in with ${status.authMethod}, not a Claude subscription`;
  }
}

/** The model from the Codex config (or Codex's own pick) as the default, then the models Codex offers. */
function codexOptions({ configured, models }: CodexModels): ModelOption[] {
  const fallback: ModelOption = configured
    ? { id: null, name: configured, description: "From your Codex config", isDefault: true }
    : { id: null, name: "Codex default", description: "The model Codex picks", isDefault: true };
  return [
    fallback,
    ...models.filter((m) => m.id !== configured).map((m) => ({ id: m.id, name: m.id, description: m.description })),
  ];
}

/** Adds a row for a saved model that isn't listed (typed in before, or no longer offered). */
function withSaved(options: ModelOption[], saved: string | null): ModelOption[] {
  if (saved === null || options.some((o) => o.id === saved)) return options;
  return [...options, { id: saved, name: saved, description: "Custom model" }];
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="shrink-0 text-[13px] text-icon">{children}</p>;
}

function StatusLine({
  status,
  checking,
  onCheck,
}: {
  status: ClaudeStatus | CodexStatus | undefined;
  checking: boolean;
  onCheck: () => void;
}) {
  const dot = !status ? "bg-muted" : status.state === "ready" ? "bg-ok" : "bg-danger";
  return (
    <div className="flex shrink-0 items-center gap-1.5 text-[12px] text-icon" data-testid="provider-status">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <p>{status ? statusText(status) : "Checking…"}</p>
      {status && status.state !== "ready" && (
        <button type="button" disabled={checking} onClick={onCheck} className="ml-1 font-medium text-ink hover:underline disabled:opacity-50">
          {checking ? "Checking…" : "Check again"}
        </button>
      )}
    </div>
  );
}

function SettingCard({ label, description, children }: { label: string; description: string; children: ReactNode }) {
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
function Segmented<T extends string>({
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

function ModelList({
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
            {o.isDefault && (
              <span className="shrink-0 rounded-md bg-row-active px-2 py-[3px] text-[11px] font-medium text-icon">Default</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
