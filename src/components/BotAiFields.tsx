import { useClaudeStatus, useCodexStatus } from "../lib/hooks";
import type { AgentConfig, AppSettings, CodexModels, Effort, Provider } from "../lib/types";
import {
  CLAUDE_MODELS,
  claudeModelName,
  codexOptions,
  EFFORTS,
  type ModelOption,
  ModelList,
  SectionLabel,
  Segmented,
  SettingCard,
  StatusLine,
  useCodexModels,
  withSaved,
} from "./aiFields";

/** A bot's own AI agent, model and effort; null fields follow Kbot Settings. */
export type BotAi = Pick<AgentConfig, "provider" | "model" | "codexModel" | "effort">;

export const FOLLOW_APP: BotAi = { provider: null, model: null, codexModel: null, effort: null };

export const aiOf = ({ provider, model, codexModel, effort }: BotAi): BotAi => ({ provider, model, codexModel, effort });

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
];

const KBOT_DEFAULT = "Kbot default";

const effortLabel = (effort: Effort) => EFFORTS.find((e) => e.id === effort)?.label ?? effort;

/** The Codex model a `codexModel` of null leaves to Codex. */
const codexFallback = (models: CodexModels | undefined) => models?.configured ?? "Codex default";

/** "Claude · Opus 5.5 · Medium effort": what Kbot Settings run bots on. */
function appSummary(app: AppSettings, codexModels: CodexModels | undefined) {
  const model =
    app.provider === "claude" ? claudeModelName(app.defaultModel) : (app.codexModel ?? codexFallback(codexModels));
  const provider = PROVIDERS.find((p) => p.id === app.provider)?.label;
  return `${provider} · ${model} · ${effortLabel(app.effort)} effort`;
}

/** Marks the row Kbot Settings would pick. */
const markDefault = (options: ModelOption[], id: string | null) =>
  options.map((o) => (o.id === id ? { ...o, badge: KBOT_DEFAULT } : { ...o, badge: undefined }));

/**
 * The Codex rows for a bot. A bot's null `codexModel` follows Kbot Settings,
 * so when those name a model, Codex's own pick can't be a null row: it's
 * listed by name instead.
 */
function botCodexOptions(models: CodexModels, app: AppSettings, saved: string | null): ModelOption[] {
  let options = codexOptions(models);
  if (app.codexModel !== null) {
    const [, ...rest] = options;
    options = models.configured
      ? [{ id: models.configured, name: models.configured, description: "From your Codex config" }, ...rest]
      : rest;
  }
  return markDefault(withSaved(withSaved(options, app.codexModel), saved), app.codexModel);
}

/**
 * Edit > AI Provider: what this bot runs on. It shows Kbot Settings until the
 * user picks something here, which then sticks to this bot.
 */
export function BotAiFields({
  app,
  value,
  onChange,
}: {
  app: AppSettings;
  value: BotAi;
  onChange: (patch: Partial<BotAi>) => void;
}) {
  const provider = value.provider ?? app.provider;
  const claude = useClaudeStatus(provider === "claude");
  const codex = useCodexStatus(provider === "codex");
  const cli = provider === "claude" ? claude : codex;
  const codexModels = useCodexModels(provider === "codex" || app.provider === "codex");
  const own = Object.values(value).some((v) => v !== null);
  const summary = appSummary(app, codexModels);

  return (
    <>
      <div
        data-testid="bot-ai-source"
        className="flex shrink-0 items-center justify-between gap-4 rounded-xl border border-modal-line py-3 pr-3 pl-4"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-[14px] font-medium text-ink">{own ? "This bot's own choice" : "Same as Kbot Settings"}</p>
          <p className="truncate text-[12px] text-hint">{own ? `Kbot Settings: ${summary}` : summary}</p>
        </div>
        {own && (
          <button
            type="button"
            onClick={() => onChange(FOLLOW_APP)}
            className="shrink-0 rounded-[14px] border border-cancel-line bg-surface px-3 py-[5px] text-[13px] font-medium text-ink"
          >
            Use Kbot Settings
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        <SectionLabel>AI agent</SectionLabel>
        <Segmented<Provider> label="AI agent" value={provider} options={PROVIDERS} onChange={(p) => onChange({ provider: p })} />
        <StatusLine
          status={cli.status}
          checking={cli.checking}
          onCheck={cli.check}
          setupHint="Choose it in Kbot Settings to see the setup steps."
        />
      </div>

      <div className="flex flex-col gap-2.5">
        {provider === "claude" ? (
          <>
            <SectionLabel>Claude model</SectionLabel>
            <ModelList
              label="Claude model"
              options={markDefault(withSaved(withSaved(CLAUDE_MODELS, app.defaultModel), value.model), app.defaultModel)}
              value={value.model ?? app.defaultModel}
              onChange={(model) => model && onChange({ model })}
            />
          </>
        ) : (
          <>
            <SectionLabel>Codex model</SectionLabel>
            {codexModels && (
              <ModelList
                label="Codex model"
                options={botCodexOptions(codexModels, app, value.codexModel)}
                value={value.codexModel ?? app.codexModel}
                onChange={(codexModel) => onChange({ codexModel })}
              />
            )}
          </>
        )}
      </div>

      <SettingCard label="Reasoning effort" description={`Higher thinks longer. Kbot default: ${effortLabel(app.effort)}`}>
        <Segmented<Effort>
          label="Reasoning effort"
          small
          value={value.effort ?? app.effort}
          options={EFFORTS}
          onChange={(effort) => onChange({ effort })}
        />
      </SettingCard>
    </>
  );
}
