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
import { button, createBot, launch, send, sidebarRow, waitForText } from "./app.ts";

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

    // Sidebar shows the scheduled-job clock.
    await browser.$(`${sidebarRow(name)}//span[@title="Runs weekdays at 08:00"]`).waitForExist();

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
      everyMinutes: null,
      date: null,
      monthly: false,
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

test("a bot can run on an interval instead of daily", async () => {
  const name = "Watch Bot";
  const log = join(dataDir, "claude-calls.jsonl");
  const session = await launch(dataDir, { FAKE_CLAUDE_LOG: log });
  try {
    const { browser } = session;
    await createBot(browser, name, "happy", "#1A73F0");

    await waitForText(browser, `Hi, I'm ${name}!`);
    await browser.$(button("Run on an interval")).click();
    await waitForText(browser, "Describe the job I should do on each run.");
    await send(browser, name, "Check Hacker News for posts about Kbot");

    await waitForText(browser, "How often should I run?");
    // Custom: 2 minutes is too short, 2 hours is fine.
    await browser.$(button("Custom")).click();
    const every = browser.$('input[aria-label="Every"]');
    await every.setValue("2");
    await waitForText(browser, "Pick from 5 minutes to 24 hours.");
    assert.equal(await browser.$('//button[normalize-space()="Continue"]').isEnabled(), false);
    await browser.$(button("15 min")).click();
    await browser.$(button("Continue")).click();
    await waitForText(browser, "every 15 min, every day");

    await waitForText(browser, "Should I be able to search the web?");
    await browser.$(button("No")).click();
    await waitForText(browser, "Any folders I should look into?");
    await browser.$(button("Skip")).click();
    await waitForText(browser, "Which topics matter most to you?");
    await send(browser, name, "Anything");
    await waitForText(browser, "Scheduled job, every 15 min, every day");
    await browser.$(button("Looks good")).click();
    await waitForText(browser, "Setup complete · Runs every 15 min");
    await browser.$(`${sidebarRow(name)}//span[@title="Runs every 15 min, every day"]`).waitForExist();

    // Run now from the bot's settings, then switch it to every 2 hours.
    await browser.$(`//header//button[@title="Settings"]`).click();
    await browser.$('[data-testid="settings-panel"]').waitForDisplayed();
    await browser.$(button("Run now")).click();
    await waitForText(browser, "Every 15 min · Run now");
    await waitForText(browser, "Fake reply to: Check for new posts.");
    await browser.$(button("Custom")).click();
    await browser.$('[data-testid="settings-panel"] input[aria-label="Every"]').setValue("2");
    await browser.execute((select: HTMLSelectElement) => {
      select.value = "hours";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }, await browser.$('[data-testid="settings-panel"] select[aria-label="Unit"]'));
    await browser.$(button("Save")).click();
    await browser.$(`${sidebarRow(name)}//span[@title="Runs every 2 hours, every day"]`).waitForExist();

    // A result that comes in while another chat is open is unread until the bot is opened.
    const unread = `${sidebarRow(name)}//*[@data-testid="bot-unread"]`;
    assert.equal(await browser.$(unread).isExisting(), false, "a result seen as it came in is read");
    await createBot(browser, "Other Bot", "buddy", "#16B364");
    await waitForText(browser, "Hi, I'm Other Bot!");
    const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
    const { id } = db.prepare("SELECT id FROM bots WHERE name = ?").get(name) as { id: string };
    db.close();
    await browser.execute((botId: string) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: object) => Promise<unknown> } })
        .__TAURI_INTERNALS__;
      return internals.invoke("run_now", { botId });
    }, id);
    await browser.$(unread).waitForExist();
    await browser.$(sidebarRow(name)).click();
    await browser.$(unread).waitForExist({ reverse: true });
  } finally {
    await session.close();
  }

  const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT config, unread FROM bots WHERE name = ?").get(name) as Record<string, string>;
    assert.equal(row.unread, 0);
    const schedule = JSON.parse(row.config).schedule;
    assert.equal(schedule.everyMinutes, 120);
    assert.equal(schedule.task, "Check for new posts.");
    assert.equal(schedule.notify, false, "interval jobs don't notify by default");
  } finally {
    db.close();
  }
});

test("a bot can do a task on a date, every month", async () => {
  const name = "Rent Bot";
  const session = await launch(dataDir);
  try {
    const { browser } = session;
    await createBot(browser, name, "happy", "#1A73F0");

    await waitForText(browser, `Hi, I'm ${name}!`);
    await browser.$(button("Schedule a task")).click();
    await waitForText(browser, "Describe the task I should do.");
    await send(browser, name, "Remind me to pay rent");

    await waitForText(browser, "When should I do it?");
    // React ignores a plain `value` change, so go through the native setter.
    const setDate = async (date: string) =>
      browser.execute(
        (input: HTMLInputElement, value: string) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        },
        await browser.$('input[aria-label="Date"]'),
        date,
      );
    // A one-time task can't be in the past.
    await setDate("2020-01-31");
    await browser.$(button("Continue")).click();
    await waitForText(browser, "Pick a date and time in the future");
    await setDate("2099-01-31");
    await browser.$('//label[contains(., "Repeat every month on the 31st")]//input').click();
    await waitForText(browser, "In shorter months, I'll run on the last day of the month.");
    await browser.$(button("Continue")).click();
    await waitForText(browser, "monthly on the 31st at 08:00");

    await waitForText(browser, "Should I be able to search the web?");
    await browser.$(button("No")).click();
    await waitForText(browser, "Any folders I should look into?");
    await browser.$(button("Skip")).click();
    await waitForText(browser, "Which topics matter most to you?");
    await send(browser, name, "None");
    await waitForText(browser, "Scheduled task, monthly on the 31st at 08:00");
    await browser.$(button("Looks good")).click();
    await waitForText(browser, "Setup complete · Next run: Jan 31, 2099 at 08:00");
    await browser.$(`${sidebarRow(name)}//span[@title="Runs monthly on the 31st at 08:00"]`).waitForExist();

    // A task can be run from the chat, not only from Settings.
    await browser.$(button("Run now")).click();
    await waitForText(browser, "Scheduled task · Run now");
    await waitForText(browser, "Fake reply to: Do the task.");
  } finally {
    await session.close();
  }

  const db = new DatabaseSync(join(dataDir, "kbot.db"));
  try {
    const row = db.prepare("SELECT config FROM bots").get() as Record<string, string>;
    const config = JSON.parse(row.config);
    assert.equal(config.schedule.date, "2099-01-31");
    assert.equal(config.schedule.monthly, true);
    assert.equal(config.schedule.everyMinutes, null);
    assert.equal(config.schedule.task, "Do the task.");

    // A one-time task that was due while Kbot was closed.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    config.schedule.date = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`;
    config.schedule.monthly = false;
    db.prepare("UPDATE bots SET config = ?, last_run_at = NULL").run(JSON.stringify(config));
  } finally {
    db.close();
  }

  const reopened = await launch(dataDir);
  try {
    const { browser } = reopened;
    await browser.$(sidebarRow(name)).click();
    await waitForText(browser, "Scheduled task · Due yesterday at 08:00, running late");
    // The reply after "Run now", and this one.
    const replies = () => browser.$$('//main//p[normalize-space()="Fake reply to: Do the task."]').length;
    await browser.waitUntil(async () => (await replies()) === 2);
  } finally {
    await reopened.close();
  }
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
