// "Clear History" and "Delete Chat" from a bot's right-click menu in the sidebar.
//
// Run with `npm run test:e2e`.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { type Browser, button, contextMenu, createBot, launch, send, sidebarRow, waitForText } from "./app.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kbot-e2e-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function clearChat(browser: Browser, name: string) {
  await contextMenu(browser, name, "Clear History");
  await waitForText(browser, `Delete all messages with ${name}?`);
  await browser.$('//*[@role="alertdialog"]//button[normalize-space()="Clear History"]').click();
  await browser.$('[role="alertdialog"]').waitForExist({ reverse: true });
}

test("clearing a chat deletes its messages and starts a new Claude session", async () => {
  const name = "Clear Bot";
  const log = join(dataDir, "claude-calls.jsonl");
  const session = await launch(dataDir, { FAKE_CLAUDE_LOG: log });
  try {
    const { browser } = session;
    await createBot(browser, name, "happy", "#1A73F0");
    await waitForText(browser, `Hi, I'm ${name}!`);
    await browser.$(button("Skip setup")).click();
    await send(browser, name, "hello there");
    await waitForText(browser, "Fake reply to: hello there");

    await clearChat(browser, name);
    await browser.$('//*[contains(text(), "Fake reply to: hello there")]').waitForExist({ reverse: true });
    await browser.$(`${sidebarRow(name)}//p[normalize-space()="No messages yet"]`).waitForExist();

    await send(browser, name, "again");
    await waitForText(browser, "Fake reply to: again");

    // A bot still being set up starts its setup over.
    const pending = "Pending Bot";
    await createBot(browser, pending, "buddy", "#16B364");
    await waitForText(browser, `Hi, I'm ${pending}!`);
    await browser.$(button("Chat with me")).click();
    await waitForText(browser, "Describe what I should do.");
    await clearChat(browser, pending);
    await browser.$('//*[contains(text(), "Describe what I should do.")]').waitForExist({ reverse: true });
    await browser.$(button("Chat with me")).waitForDisplayed();
  } finally {
    await session.close();
  }

  const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
  try {
    const bodies = db
      .prepare("SELECT m.body FROM messages m JOIN bots b ON b.id = m.bot_id WHERE b.name = ? ORDER BY m.created_at")
      .all(name)
      .map((r) => JSON.parse(r.body as string));
    assert.deepEqual(
      bodies.map((b) => b.text),
      ["again", "Fake reply to: again"],
    );
  } finally {
    db.close();
  }

  const chats = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[])
    .filter((a) => a[0] === "-p" && !a.includes("--json-schema"));
  assert.equal(chats.length, 2);
  const sessionOf = (args: string[]) => args[args.indexOf("--session-id") + 1];
  assert.ok(chats.every((a) => a.includes("--session-id") && !a.includes("--resume")), "both chats start a session");
  assert.notEqual(sessionOf(chats[0]), sessionOf(chats[1]));
});

test("deleting a chat removes the bot, its Claude Code state, and opens another one", async () => {
  const log = join(dataDir, "claude-calls.jsonl");
  const purges = () =>
    (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [])
      .map((l) => JSON.parse(l) as string[])
      .filter((a) => a[0] === "purge");
  let deletedId = "";
  const session = await launch(dataDir, { FAKE_CLAUDE_LOG: log });
  try {
    const { browser } = session;
    await createBot(browser, "Keep Bot", "buddy", "#16B364");
    await createBot(browser, "Delete Bot", "happy", "#1A73F0");
    await waitForText(browser, "Hi, I'm Delete Bot!");

    // Cancel keeps it.
    await contextMenu(browser, "Delete Bot", "Delete Chat");
    await browser.$('//*[@role="alertdialog"]//button[normalize-space()="Cancel"]').click();
    await browser.$(sidebarRow("Delete Bot")).waitForDisplayed();

    await browser.$(button("Skip setup")).click();
    await send(browser, "Delete Bot", "hello there");
    await waitForText(browser, "Fake reply to: hello there");
    const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
    deletedId = (db.prepare("SELECT id FROM bots WHERE name = 'Delete Bot'").get() as { id: string }).id;
    db.close();
    assert.ok(existsSync(join(dataDir, "agents", deletedId)));

    await contextMenu(browser, "Delete Bot", "Delete Chat");
    await waitForText(browser, "Delete Delete Bot with its messages and settings?");
    await browser.$('//*[@role="alertdialog"]//button[normalize-space()="Delete"]').click();
    await browser.$(sidebarRow("Delete Bot")).waitForExist({ reverse: true });
    await browser.$(`${sidebarRow("Keep Bot")}[@aria-current="true"]`).waitForExist();
    await waitForText(browser, "Hi, I'm Keep Bot!");
    // The purge runs in the background.
    await browser.waitUntil(() => purges().length > 0, { timeoutMsg: "claude purge was not run" });
  } finally {
    await session.close();
  }

  const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT name FROM bots").all().map((r) => r.name), ["Keep Bot"]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages m LEFT JOIN bots b ON b.id = m.bot_id WHERE b.id IS NULL").get() as { n: number }).n, 0);
  } finally {
    db.close();
  }
  assert.ok(!existsSync(join(dataDir, "agents", deletedId)));
  assert.deepEqual(purges(), [["purge", "--yes", join(dataDir, "agents", deletedId)]]);
});
