// Kbot > Settings… (⌘, / Ctrl+,): the default model Claude Code runs with.
//
// Run with `npm run test:e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { button, createBot, launch, send, waitForText } from "./app.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kbot-e2e-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("runs use Sonnet 5.5 until another default model is saved", async () => {
  const name = "Model Bot";
  const log = join(dataDir, "claude-calls.jsonl");
  const session = await launch(dataDir, { FAKE_CLAUDE_LOG: log });
  try {
    const { browser } = session;
    await createBot(browser, name);
    await waitForText(browser, `Hi, I'm ${name}!`);
    await browser.$(button("Skip setup")).click();
    await send(browser, name, "first");
    await waitForText(browser, "Fake reply to: first");

    await browser.keys(["Control", ","]);
    const model = browser.$('//*[@role="dialog"]//select[@id="default-model"]');
    await model.waitForDisplayed();
    assert.equal(await model.getValue(), "claude-sonnet-5-5");
    // selectByVisibleText doesn't change a <select> in the embedded WebDriver.
    await browser.execute((select: HTMLSelectElement) => {
      select.value = "claude-opus-5-5";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, await model);
    // Saved on change; there's no Save button.
    await browser.$('[aria-label="Close settings"]').click();
    await browser.$('[role="dialog"]').waitForExist({ reverse: true });

    await send(browser, name, "second");
    await waitForText(browser, "Fake reply to: second");
  } finally {
    await session.close();
  }

  const models = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[])
    .filter((a) => a[0] === "-p" && !a.includes("--json-schema"))
    .map((a) => a[a.indexOf("--model") + 1]);
  assert.deepEqual(models, ["claude-sonnet-5-5", "claude-opus-5-5"]);
});
