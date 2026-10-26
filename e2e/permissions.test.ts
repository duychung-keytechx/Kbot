// Questions and approvals from Claude Code (`--permission-prompt-tool stdio`)
// against the real app, with Claude Code replaced by e2e/fake-claude.ts, plus
// the sidebar's working spinner.
//
// Run with `npm run test:e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { button, createBot, launch, send, sidebarRow, waitForText } from "./app.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kbot-e2e-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("questions and tool approvals are answered in the chat", async () => {
  const name = "Helper";
  const log = join(dataDir, "claude-calls.jsonl");
  const session = await launch(dataDir, { FAKE_CLAUDE_LOG: log });
  try {
    const { browser } = session;
    const spinner = `${sidebarRow(name)}//*[@data-testid="bot-working"]`;
    const status = (text: string) => `//*[@data-testid="permission-card"]//p[normalize-space()="${text}"]`;
    await createBot(browser, name);
    await waitForText(browser, `Hi, I'm ${name}!`);
    await browser.$(button("Skip setup")).click();
    await waitForText(browser, "Type /setup any time to set me up.");

    // AskUserQuestion: the options are buttons; one click answers.
    await send(browser, name, "Please ask me");
    await waitForText(browser, "Coffee or tea?");
    await browser.$(spinner).waitForExist();
    await browser.$(`${sidebarRow(name)}//p[normalize-space()="Coffee or tea?"]`).waitForExist();
    assert.equal(await browser.$$('[data-testid="typing"]').length, 0, "waiting on the user, not typing");
    await browser.$('//button[span[normalize-space()="Tea"]]').click();
    await waitForText(browser, "You picked Tea.");
    await browser.$(status("Answered")).waitForExist();
    await browser.$(spinner).waitForExist({ reverse: true });

    // A tool approval: Approve, then Deny.
    await send(browser, name, "This needs approval");
    await waitForText(browser, "rm -rf build");
    await waitForText(browser, "Delete the build folder");
    await browser.$(button("Approve")).click();
    await waitForText(browser, "Approved, build folder deleted.");
    await browser.$(status("Approved")).waitForExist();

    await send(browser, name, "Again needs approval");
    await browser.$(button("Deny")).waitForDisplayed();
    await browser.$(button("Deny")).click();
    await waitForText(browser, "Denied, I left it alone.");
    await browser.$(status("Denied")).waitForExist();

    // Stopping the run while it waits expires the card.
    await send(browser, name, "Once more needs approval");
    await browser.$(button("Approve")).waitForDisplayed();
    await browser.$('button[aria-label="Stop"]').click();
    await browser.$(status("Not answered in time: the run ended.")).waitForExist({ timeout: 10_000 });
    assert.equal(await browser.$$(button("Approve")).length, 0);
    await browser.$(spinner).waitForExist({ reverse: true });
  } finally {
    await session.close();
  }

  const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
  try {
    const cards = (db.prepare("SELECT body FROM messages ORDER BY created_at").all() as { body: string }[])
      .map((r) => JSON.parse(r.body))
      .filter((b) => b.type === "permission");
    assert.deepEqual(
      cards.map((c) => c.status),
      ["answered", "approved", "denied", "expired"],
    );
    assert.deepEqual(cards[0].answers, { "Coffee or tea?": "Tea" });
  } finally {
    db.close();
  }

  const runs = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[])
    .filter((a) => a[0] === "-p");
  assert.equal(runs.length, 4);
  for (const args of runs) {
    assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "stdio");
    assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
  }
});
