// Onboarding and chat against the real app, with Claude Code replaced by
// e2e/fake-claude.ts.
//
// Run with `npm run test:e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { button, createBot, launch, send, waitForText } from "./app.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kbot-e2e-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("a new bot is set up in the chat, then replies through Claude Code", async () => {
  const name = "Brief Bot";
  const log = join(dataDir, "claude-calls.jsonl");
  const session = await launch(dataDir, { FAKE_CLAUDE_LOG: log });
  try {
    const { browser } = session;
    await createBot(browser, name, "happy", "#1A73F0");

    await waitForText(browser, `Hi, I'm ${name}!`);
    await browser.$(button("Run a daily job")).click();
    await waitForText(browser, "Describe the job I should do each day.");
    await send(browser, name, "Brief me on AI news every morning");

    await waitForText(browser, "When should I run each day?");
    await browser.$('button[aria-label="Saturday"]').click();
    await browser.$('button[aria-label="Sunday"]').click();
    await browser.$(button("Continue")).click();

    await waitForText(browser, "Should I be able to search the web?");
    await browser.$(button("Yes")).click();
    await waitForText(browser, "Any folders I should look into?");
    await browser.$(button("Skip")).click();

    // Clarifying question and instructions come from (fake) Claude.
    await waitForText(browser, "Which topics matter most to you?");
    await send(browser, name, "Robotics and chips");
    await waitForText(browser, "Here's my setup. Look good?");
    await waitForText(browser, "You write a short, friendly brief. Robotics and chips");
    await browser.$(button("Looks good")).click();
    await waitForText(browser, "Setup complete · Next run:");

    // Sidebar shows the daily-job clock.
    await browser.$(`//nav//button[.//p[normalize-space()="${name}"]]//span[starts-with(@title, "Daily job at 08:00")]`).waitForExist();

    await send(browser, name, "hello there");
    await waitForText(browser, "Fake reply to: hello there");
  } finally {
    await session.close();
  }

  const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT setup_state, setup_step, config, claude_session_id FROM bots").get() as Record<string, string>;
    assert.equal(row.setup_state, "done");
    assert.equal(row.setup_step, null);
    assert.ok(row.claude_session_id, "chat session saved");
    const config = JSON.parse(row.config);
    assert.deepEqual(config.schedule, {
      time: "08:00",
      days: ["mon", "tue", "wed", "thu", "fri"],
      task: "Write today's brief.",
      notify: true,
    });
    assert.equal(config.description, "Brief me on AI news every morning");
    assert.equal(config.webAccess, true);
  } finally {
    db.close();
  }

  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  const runs = calls.filter((a) => a[0] === "-p");
  assert.equal(runs.length, 3, "clarifying questions, instructions, one chat reply");
  for (const args of runs) {
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(at("--permission-mode"), "bypassPermissions");
    assert.equal(at("--setting-sources"), "");
    assert.ok(args.includes("--strict-mcp-config"));
  }
  const chat = runs[2];
  assert.equal(chat[chat.indexOf("--tools") + 1], "default", "all tools");
  assert.ok(!chat.includes("--disallowedTools"), "web access is on");
  assert.ok(chat.includes("--session-id"));
  assert.ok(runs[0].includes("--no-session-persistence") && runs[0].includes("--json-schema"));
  assert.equal(runs[0][runs[0].indexOf("--tools") + 1], "", "onboarding helpers get no tools");
});

test("Connect Claude is shown until Claude Code is signed in", async () => {
  const session = await launch(dataDir, { FAKE_CLAUDE_STATE: "loggedOut" });
  try {
    const { browser } = session;
    await browser.$('[data-testid="connect-claude"]').waitForDisplayed({ timeout: 10_000 });
    await waitForText(browser, "claude auth login");
    await waitForText(browser, "Claude Code is installed but not signed in.");
  } finally {
    await session.close();
  }
});
