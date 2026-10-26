// Launches the e2e build of the app (`npm run build:e2e`) and connects to the
// WebDriver server that the `e2e` cargo feature embeds in it.

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { remote } from "webdriverio";

const APP = join(
  import.meta.dirname,
  "../src-tauri/target/debug",
  process.platform === "win32" ? "kbot.exe" : "kbot",
);
const PORT = 4455;

/** Stands in for Claude Code; see the file for the env vars it reads. */
export const FAKE_CLAUDE = join(import.meta.dirname, "fake-claude.ts");

/**
 * Starts the app with its database in `dataDir` and opens a WebDriver session
 * to its window. Claude Code is replaced by `fake-claude.ts`; `env` adds or
 * overrides variables (e.g. FAKE_CLAUDE_STATE).
 */
export async function launch(dataDir: string, env: Record<string, string> = {}) {
  const app: ChildProcess = spawn(APP, {
    env: {
      ...process.env,
      KBOT_DATA_DIR: dataDir,
      TAURI_WEBDRIVER_PORT: String(PORT),
      KBOT_CLAUDE_BIN: FAKE_CLAUDE,
      ...env,
    },
    stdio: "inherit",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/status`)).ok) break;
    } catch {
      // Server not up yet.
    }
    if (app.exitCode !== null) throw new Error(`app exited with code ${app.exitCode}`);
    if (Date.now() > deadline) throw new Error("WebDriver server did not start; was the app built with `--features e2e`?");
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await remote({ hostname: "127.0.0.1", port: PORT, capabilities: {}, logLevel: "warn" });
  return {
    browser,
    async close() {
      await browser.deleteSession().catch(() => {});
      app.kill();
      await once(app, "exit");
    },
  };
}

export type Browser = Awaited<ReturnType<typeof launch>>["browser"];

export const sidebarRow = (name: string) => `//nav//button[.//p[normalize-space()="${name}"]]`;

/** Right-clicks the bot in the sidebar and picks `item` from its context menu. */
export async function contextMenu(browser: Browser, name: string, item: string) {
  // The embedded WebDriver has no real right button, so fire the event the click would.
  await browser.execute((xpath) => {
    const row = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
      .singleNodeValue as HTMLElement;
    const r = row.getBoundingClientRect();
    const at = { clientX: r.left + 40, clientY: r.top + 20 };
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...at }));
  }, sidebarRow(name));
  await browser.$(`//*[@role="menu"]//button[normalize-space()="${item}"]`).click();
  await browser.$('[role="menu"]').waitForExist({ reverse: true });
}

/** Fills in and submits the "Create New Bot" dialog. */
export async function createBot(browser: Browser, name: string, icon: string, color: string) {
  await browser.$('button[aria-label="New bot"]').click();
  await browser.$('input[placeholder="Name your bot"]').setValue(name);
  await browser.$(`[aria-label="Icon"] button[aria-label="${icon}"]`).click();
  await browser.$(`[aria-label="Color"] button[aria-label="${color}"]`).click();
  await browser.$('[role="dialog"] button[type="submit"]').click();
  await browser.$(sidebarRow(name)).waitForDisplayed({ timeout: 5_000 });
}

/** The last enabled button with this exact label (older setup cards keep theirs, disabled). */
export const button = (label: string) => `(//button[normalize-space()="${label}" and not(@disabled)])[last()]`;

/** Types into the composer and sends. */
export async function send(browser: Browser, botName: string, text: string) {
  await browser.$(`input[placeholder="Message ${botName}"]`).setValue(text);
  await browser.$('button[aria-label="Send"]').click();
}

/** Waits for an element containing `text` anywhere in the window. */
export async function waitForText(browser: Browser, text: string, timeout = 10_000) {
  await browser.$(`//*[contains(text(), ${JSON.stringify(text)})]`).waitForDisplayed({ timeout });
}
