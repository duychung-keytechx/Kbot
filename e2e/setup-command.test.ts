// `/setup` (and "Edit" in a bot's menu) against the real app, with Claude Code
// replaced by e2e/fake-claude.ts: changing a set-up bot, closing without
// saving, and starting onboarding over for a bot that skipped it.
//
// Run with `npm run test:e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const readBot = () => {
  const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
  try {
    return db.prepare("SELECT setup_state, setup_step, config, claude_session_id FROM bots").get() as Record<
      string,
      string | null
    >;
  } finally {
    db.close();
  }
};

/** Onboards `name` as a chat bot with web access and no folders. */
async function onboardChatBot(browser: Browser, name: string) {
  await waitForText(browser, `Hi, I'm ${name}!`);
  await browser.$(button("Chat with me")).click();
  await waitForText(browser, "Describe what I should do.");
  await send(browser, name, "Help me plan my week");
  await waitForText(browser, "Should I be able to search the web?");
  await browser.$(button("Yes")).click();
  await waitForText(browser, "Any folders I should look into?");
  await browser.$(button("Skip")).click();
  await waitForText(browser, "Which topics matter most to you?");
  await send(browser, name, "Work and gym");
  await waitForText(browser, "Here's my setup. Look good?");
  await browser.$(button("Looks good")).click();
  await waitForText(browser, "Setup complete");
}

test("/setup shows the current setup and saves a change made in words", async () => {
  const name = "Planner";
  const log = join(dataDir, "claude-calls.jsonl");
  const session = await launch(dataDir, { FAKE_CLAUDE_LOG: log });
  let savedSession: string | null;
  try {
    const { browser } = session;
    await createBot(browser, name, "happy", "#1A73F0");
    await onboardChatBot(browser, name);
    await send(browser, name, "hello there");
    await waitForText(browser, "Fake reply to: hello there");
    savedSession = readBot().claude_session_id;
    assert.ok(savedSession, "chat session saved");

    // The current setup, with a short how-to.
    await send(browser, name, "/setup");
    await waitForText(browser, "Here's my current setup.");
    await waitForText(browser, "You write a short, friendly brief. Work and gym");
    await waitForText(browser, "To change anything, just tell me what you want");
    await browser.$(button("Exit setup")).waitForDisplayed();

    // A change in words comes back for review, marked, and is saved.
    await send(browser, name, "Keep answers under 5 bullets");
    await waitForText(browser, "Updated as you asked.");
    await waitForText(browser, "Here's my updated setup. Save it?");
    await browser.$('//span[normalize-space()="changed"]').waitForDisplayed();
    await waitForText(browser, "You write a short, friendly brief. Work and gym Keep answers under 5 bullets");
    await browser.$(button("Save")).click();
    await waitForText(browser, "Setup updated");
    await browser.$(button("Exit setup")).waitForDisplayed({ reverse: true });

    let row = readBot();
    assert.equal(row.setup_state, "done");
    assert.equal(row.setup_step, null);
    assert.equal(row.claude_session_id, null, "a new setup starts a new chat session");
    const config = JSON.parse(row.config!);
    assert.equal(config.instructions, "You write a short, friendly brief. Work and gym Keep answers under 5 bullets");
    assert.equal(config.description, "Help me plan my week");
    assert.equal(config.webAccess, true);
    assert.equal(config.schedule, null);

    // Closing without saving keeps the setup, and chat works again.
    await send(browser, name, "/SETUP");
    await browser.$(button("Exit setup")).waitForDisplayed();
    assert.ok(readBot().setup_step, "editing is saved, so it survives a restart");
    await send(browser, name, "Turn off web search");
    await waitForText(browser, "Here's my updated setup. Save it?");
    await browser.$(button("Exit setup")).click();
    await waitForText(browser, "Setup closed. Nothing changed.");
    await waitForText(browser, "Not saved");
    assert.equal(await browser.$$(button("Save")).length, 0, "the unsaved change can't be saved later");
    row = readBot();
    assert.equal(row.setup_step, null);
    assert.equal(JSON.parse(row.config!).instructions, config.instructions);

    await send(browser, name, "hi again");
    await waitForText(browser, "Fake reply to: hi again");
  } finally {
    await session.close();
  }

  const runs = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as string[])
    .filter((a) => a[0] === "-p");
  // Clarifying questions, instructions, hello, two changes, hi again; `/setup` itself never reaches Claude.
  assert.equal(runs.length, 6);
  const edits = runs.filter((a) => a.join(" ").includes('"note"'));
  assert.equal(edits.length, 2);
  for (const args of edits) assert.ok(args.includes("--no-session-persistence"));
  const last = runs.at(-1)!;
  const sessionId = last[last.indexOf("--session-id") + 1];
  assert.ok(last.includes("--session-id") && sessionId !== savedSession, "new session after the update");
});

test("/setup on a bot that skipped setup starts onboarding", async () => {
  const name = "Skipper";
  const session = await launch(dataDir);
  try {
    const { browser } = session;
    await createBot(browser, name, "buddy", "#1A73F0");
    await waitForText(browser, `Hi, I'm ${name}!`);
    await browser.$(button("Skip setup")).click();
    await waitForText(browser, "Type /setup any time to set me up.");

    await send(browser, name, "/setup");
    await browser.$(`(//*[contains(text(), "Hi, I'm ${name}!")])[2]`).waitForDisplayed({ timeout: 10_000 });
    await browser.$(button("Skip setup")).waitForDisplayed();
    assert.equal(readBot().setup_state, "pending");
  } finally {
    await session.close();
  }
});

test("Edit in a bot's menu opens its chat and works like /setup", async () => {
  const session = await launch(dataDir);
  try {
    const { browser } = session;
    await createBot(browser, "Planner", "happy", "#1A73F0");
    await onboardChatBot(browser, "Planner");
    await createBot(browser, "Skipper", "buddy", "#16B364");
    await waitForText(browser, "Hi, I'm Skipper!");
    await browser.$(button("Skip setup")).click();
    await waitForText(browser, "Type /setup any time to set me up.");

    // From another bot's chat: opens Planner and shows its setup, with no "/setup" message.
    await contextMenu(browser, "Planner", "Edit");
    await browser.$(`${sidebarRow("Planner")}[@aria-current="true"]`).waitForExist();
    await waitForText(browser, "Here's my current setup.");
    assert.equal(await browser.$$('//*[normalize-space()="/setup"]').length, 0);
    await send(browser, "Planner", "Keep answers under 5 bullets");
    await browser.$(button("Save")).click();
    await waitForText(browser, "Setup updated");

    // A bot that skipped setup starts it over.
    await contextMenu(browser, "Skipper", "Edit");
    await browser.$(`${sidebarRow("Skipper")}[@aria-current="true"]`).waitForExist();
    await browser.$(`(//*[contains(text(), "Hi, I'm Skipper!")])[2]`).waitForDisplayed({ timeout: 10_000 });
  } finally {
    await session.close();
  }

  const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT name, setup_state, config FROM bots ORDER BY name").all() as Record<string, string>[];
    assert.equal(rows[0].name, "Planner");
    assert.equal(rows[0].setup_state, "done");
    assert.match(JSON.parse(rows[0].config).instructions, /Keep answers under 5 bullets$/);
    assert.equal(rows[1].setup_state, "pending");
  } finally {
    db.close();
  }
});
