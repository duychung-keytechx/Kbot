import { type ReactNode, useState } from "react";
import type { ClaudeStatus } from "../lib/types";

const INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const LOGIN = "claude auth login";

/**
 * Shown instead of the chat until Claude Code is installed and signed in
 * with a Claude subscription. Signing in happens in Terminal; the window
 * checks again when it regains focus, or on "Check again".
 */
export function ConnectClaude({
  status,
  checking,
  onCheck,
  onSettings,
}: {
  status: Exclude<ClaudeStatus, { state: "ready" }>;
  checking: boolean;
  onCheck: () => void;
  /** Opens Kbot > Settings…, where Codex can be picked instead. */
  onSettings: () => void;
}) {
  return (
    <main data-tauri-drag-region className="flex flex-1 flex-col items-center justify-center bg-main px-6">
      <div data-testid="connect-claude" className="flex w-[440px] max-w-full flex-col gap-4">
        <p className="text-[18px] font-semibold text-ink">Connect Claude</p>
        <p className="text-[14px] leading-[21px] text-subtle">
          Kbot's agents run on Claude Code with your Claude subscription (Pro, Max, Team or Enterprise). Nothing is
          sent anywhere else, and API keys are never used.
        </p>
        <Steps status={status} />
        <Actions checking={checking} onCheck={onCheck} onSettings={onSettings} other="Use Codex instead" />
      </div>
    </main>
  );
}

/** "Check again", plus a link to Settings to switch provider. */
export function Actions({
  checking,
  onCheck,
  onSettings,
  other,
}: {
  checking: boolean;
  onCheck: () => void;
  onSettings: () => void;
  other: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onCheck}
        disabled={checking}
        className="rounded-[15px] bg-ink-strong px-[13px] py-1.5 text-[13px] font-medium text-ink-inverse disabled:opacity-60"
      >
        {checking ? "Checking…" : "Check again"}
      </button>
      <button type="button" onClick={onSettings} className="text-[13px] text-subtle hover:text-ink">
        {other}
      </button>
    </div>
  );
}

function Steps({ status }: { status: Exclude<ClaudeStatus, { state: "ready" }> }) {
  switch (status.state) {
    case "notInstalled":
      return (
        <ol className="flex flex-col gap-3 text-[14px] leading-[21px] text-ink">
          <Step n={1}>
            Install Claude Code. In Terminal, run:
            <Command text={INSTALL} />
          </Step>
          <Step n={2}>
            Sign in with your Claude account:
            <Command text={LOGIN} />
          </Step>
          <Step n={3}>Come back here. Kbot finds Claude Code by itself.</Step>
        </ol>
      );
    case "loggedOut":
      return (
        <ol className="flex flex-col gap-3 text-[14px] leading-[21px] text-ink">
          <Step n={1}>
            Claude Code is installed but not signed in. In Terminal, run:
            <Command text={LOGIN} />
          </Step>
          <Step n={2}>Choose your Claude account (not the Console / API option) and finish in the browser.</Step>
        </ol>
      );
    case "notSubscription":
      return (
        <ol className="flex flex-col gap-3 text-[14px] leading-[21px] text-ink">
          <Step n={1}>
            Claude Code is signed in with <b className="font-semibold">{status.authMethod}</b>, which is billed per use.
            Kbot only runs on a Claude subscription. In Terminal, run:
            <Command text={LOGIN} />
          </Step>
          <Step n={2}>Choose your Claude account (not the Console / API option).</Step>
        </ol>
      );
  }
}

export function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="flex size-[21px] shrink-0 items-center justify-center rounded-full bg-bubble text-[12px] font-medium text-subtle">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </li>
  );
}

export function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-[10px] bg-bubble py-1.5 pr-1.5 pl-3">
      <code className="selectable min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{text}</code>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
        className="shrink-0 rounded-[12px] border border-button-line bg-surface px-2.5 py-1 text-[12px] font-medium text-ink"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
