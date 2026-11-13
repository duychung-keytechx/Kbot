import { useEffect, useState } from "react";
import { backend, errorText } from "../lib/api";
import { useClaudeStatus, useCodexStatus } from "../lib/hooks";
import { applyTheme } from "../lib/theme";
import { type AppSettings, DEFAULT_MODEL, type Effort, type Provider, type Theme } from "../lib/types";
import {
  CLAUDE_MODELS,
  codexOptions,
  EFFORTS,
  ModelList,
  SectionLabel,
  Segmented,
  SettingCard,
  StatusLine,
  useCodexModels,
  withSaved,
} from "./aiFields";
import { CircleIcon, CloseIcon, MoonIcon, SparkleIcon, SunIcon } from "./Icons";

const TABS = [
  { id: "general", label: "General", icon: <CircleIcon /> },
  { id: "providers", label: "AI Providers", icon: <SparkleIcon /> },
] as const;
type Tab = (typeof TABS)[number]["id"];

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

  const codexModels = useCodexModels(provider === "codex");

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
      <StatusLine
        status={cli.status}
        checking={cli.checking}
        onCheck={cli.check}
        setupHint="Close Settings to see the setup steps."
      />
      <div className="h-2.5 shrink-0" />

      {provider === "claude" ? (
        <>
          <SectionLabel>Claude model</SectionLabel>
          <ModelList
            label="Claude model"
            options={withSaved(
              CLAUDE_MODELS.map((m) => (m.id === DEFAULT_MODEL ? { ...m, badge: "Default" } : m)),
              settings.defaultModel,
            )}
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
        Every bot runs on these, unless it picks its own in Edit &gt; AI Provider.
      </p>
    </>
  );
}

