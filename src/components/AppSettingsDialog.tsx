import { type ReactNode, useEffect, useState } from "react";
import { backend, errorText } from "../lib/api";
import type { AppSettings } from "../lib/types";
import { ChevronDownIcon, CloseIcon, GearIcon } from "./Icons";

const TABS = [{ id: "general", label: "General", icon: <GearIcon /> }] as const;
type Tab = (typeof TABS)[number]["id"];

/** Models offered in the picker; anything else is typed in under "Other…". */
const MODELS = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
];
const OTHER = "other";

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

  const save = async (patch: Partial<AppSettings>) => {
    if (!settings) return;
    setError(undefined);
    try {
      setSettings(await backend.updateAppSettings({ ...settings, ...patch }));
    } catch (e) {
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
        className="relative flex h-[700px] max-h-full w-[900px] max-w-full overflow-hidden rounded-2xl border border-modal-line bg-white shadow-[0_20px_50px_rgba(0,0,0,0.2),0_2px_6px_rgba(0,0,0,0.06)]"
      >
        <nav role="tablist" aria-orientation="vertical" className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-sidebar-line bg-sidebar p-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              onClick={() => setTab(t.id)}
              className={`flex h-[30px] items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-ink ${
                t.id === tab ? "bg-row-active" : "hover:bg-row-hover"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>

        <div role="tabpanel" aria-labelledby="settings-tab-title" className="min-w-0 flex-1 overflow-y-auto px-8 pt-7 pb-8">
          <h2 id="settings-tab-title" className="mb-6 px-2 text-[17px] font-medium text-ink">
            {TABS.find((t) => t.id === tab)?.label}
          </h2>
          {tab === "general" && settings && (
            <Section label="Claude" hint="The model Kbot asks Claude Code to use. A bot can pick its own in its settings.">
              <ModelRows model={settings.defaultModel} onChange={(defaultModel) => void save({ defaultModel })} />
            </Section>
          )}
          {error && <p className="mt-3 px-2 text-[12.5px] text-[#c4321c]">{error}</p>}
        </div>

        <button
          type="button"
          aria-label="Close settings"
          onClick={onClose}
          className="absolute top-4 right-4 flex size-7 items-center justify-center rounded-lg hover:bg-bubble"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

/** "Model" picker, plus a text row for a model name that isn't listed. */
function ModelRows({ model, onChange }: { model: string; onChange: (model: string) => void }) {
  // "Other…" stays picked while its text happens to match a listed model.
  const [other, setOther] = useState(!MODELS.some((m) => m.id === model));
  const [typed, setTyped] = useState(model);
  useEffect(() => setTyped(model), [model]);

  const commit = () => {
    const name = typed.trim();
    if (name && name !== model) onChange(name);
    else setTyped(model);
  };

  return (
    <>
      <Row label="Model" htmlFor="default-model">
        <span className="relative flex items-center">
          <select
            id="default-model"
            value={other ? OTHER : model}
            onChange={(e) => {
              const picked = e.target.value;
              setOther(picked === OTHER);
              if (picked !== OTHER) onChange(picked);
            }}
            className="h-[26px] appearance-none rounded-md border border-field-line bg-white pr-6 pl-2 text-[13px] text-ink"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value={OTHER}>Other…</option>
          </select>
          <ChevronDownIcon className="pointer-events-none absolute right-2" />
        </span>
      </Row>
      {other && (
        <Row label="Model name" htmlFor="custom-model">
          <input
            id="custom-model"
            autoFocus
            value={typed}
            placeholder="e.g. opus"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
            className="h-[26px] w-[220px] rounded-md border border-field-line bg-white px-2 text-right text-[13px] text-ink"
          />
        </Row>
      )}
    </>
  );
}

function Section({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-7 flex flex-col gap-2.5">
      <p className="px-2 text-[13px] text-subtle">{label}</p>
      <div className="flex flex-col rounded-xl border border-modal-line px-3.5 py-1.5">{children}</div>
      {hint && <p className="px-2 text-[12px] leading-[17px] text-hint">{hint}</p>}
    </section>
  );
}

function Row({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[46px] items-center justify-between gap-4">
      <label htmlFor={htmlFor} className="text-[13.5px] text-ink">
        {label}
      </label>
      {children}
    </div>
  );
}
