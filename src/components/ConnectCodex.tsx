import type { CodexStatus } from "../lib/types";
import { Actions, Command, Step } from "./ConnectClaude";

const INSTALL = "npm install -g @openai/codex";
const LOGIN = "codex login";

/**
 * Shown instead of the chat while Codex is the AI agent (Kbot > Settings…)
 * but isn't installed or signed in. Like `ConnectClaude`, it checks again
 * when the window regains focus.
 */
export function ConnectCodex({
  status,
  checking,
  onCheck,
  onSettings,
}: {
  status: Exclude<CodexStatus, { state: "ready" }>;
  checking: boolean;
  onCheck: () => void;
  onSettings: () => void;
}) {
  return (
    <main data-tauri-drag-region className="flex flex-1 flex-col items-center justify-center bg-main px-6">
      <div data-testid="connect-codex" className="flex w-[440px] max-w-full flex-col gap-4">
        <p className="text-[18px] font-semibold text-ink">Connect Codex</p>
        <p className="text-[14px] leading-[21px] text-subtle">
          Kbot's agents run on the Codex CLI with your ChatGPT plan, an OpenAI API key, or the model provider set in
          your Codex config.
        </p>
        <ol className="flex flex-col gap-3 text-[14px] leading-[21px] text-ink">
          {status.state === "notInstalled" ? (
            <>
              <Step n={1}>
                Install Codex. In Terminal, run:
                <Command text={INSTALL} />
              </Step>
              <Step n={2}>
                Sign in with your ChatGPT account:
                <Command text={LOGIN} />
              </Step>
              <Step n={3}>Come back here. Kbot finds Codex by itself.</Step>
            </>
          ) : (
            <>
              <Step n={1}>
                Codex is installed but not signed in. In Terminal, run:
                <Command text={LOGIN} />
              </Step>
              <Step n={2}>
                Or point Codex at your own model: set <code className="font-mono text-[12.5px]">model_provider</code> in{" "}
                <code className="font-mono text-[12.5px]">~/.codex/config.toml</code>.
              </Step>
            </>
          )}
        </ol>
        <Actions checking={checking} onCheck={onCheck} onSettings={onSettings} other="Use Claude instead" />
      </div>
    </main>
  );
}
