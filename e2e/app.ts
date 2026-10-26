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

/** Starts the app with its database in `dataDir` and opens a WebDriver session to its window. */
export async function launch(dataDir: string) {
  const app: ChildProcess = spawn(APP, {
    env: { ...process.env, KBOT_DATA_DIR: dataDir, TAURI_WEBDRIVER_PORT: String(PORT) },
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

/** Fills in and submits the "Create New Bot" dialog. */
export async function createBot(browser: Browser, name: string, icon: string, color: string) {
  await browser.$('button[aria-label="New bot"]').click();
  await browser.$('input[placeholder="Name your bot"]').setValue(name);
  await browser.$(`[aria-label="Icon"] button[aria-label="${icon}"]`).click();
  await browser.$(`[aria-label="Color"] button[aria-label="${color}"]`).click();
  await browser.$('[role="dialog"] button[type="submit"]').click();
  await browser.$(sidebarRow(name)).waitForDisplayed({ timeout: 5_000 });
}
