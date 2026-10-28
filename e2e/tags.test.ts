// Tags from the "Tags" tab of a bot's "Edit" dialog: adding and creating them
// on a bot, renaming, recoloring and deleting them, and filtering the sidebar.
//
// Run with `npm run test:e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { type Browser, button, contextMenu, createBot, launch, sidebarRow, waitForText } from "./app.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kbot-e2e-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const query = (sql: string) => {
  const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
  try {
    // Plain objects, so `deepEqual` compares them to literals.
    return db.prepare(sql).all().map((row) => ({ ...row })) as Record<string, string>[];
  } finally {
    db.close();
  }
};

const dialog = '//*[@role="dialog"][starts-with(@aria-label, "Edit ")]';
const chip = (name: string) => `button[aria-label="Remove ${name}"]`;
const checkbox = (name: string) => `//*[@role="checkbox"][@aria-label="${name}"]`;
const filterChip = (name: string) => `//*[@aria-label="Filter by tag"]//button[normalize-space()="${name}"]`;

async function newBot(browser: Browser, name: string) {
  await createBot(browser, name);
  await waitForText(browser, `Hi, I'm ${name}!`);
  await browser.$(button("Skip setup")).click();
  await waitForText(browser, "Type /setup any time to set me up.");
}

async function openTags(browser: Browser, name: string) {
  await contextMenu(browser, name, "Edit");
  await browser.$(dialog).waitForDisplayed();
  await browser.$('//button[@role="tab"][starts-with(normalize-space(), "Tags")]').click();
  await browser.$("#edit-tag-input").waitForDisplayed();
}

async function typeTag(browser: Browser, text: string) {
  await browser.$("#edit-tag-input").setValue(text);
  await browser.$('//*[@role="option"][@aria-selected="true"]').waitForDisplayed();
  await browser.keys("Enter");
}

test("tags are made, changed and put on bots from the Edit dialog, and filter the sidebar", async () => {
  const session = await launch(dataDir);
  try {
    const { browser } = session;
    await newBot(browser, "Planner");
    await newBot(browser, "Coder");

    // Enter on text no tag has creates it, on this bot.
    await openTags(browser, "Planner");
    await typeTag(browser, "Work");
    await browser.$(chip("Work")).waitForDisplayed();
    await typeTag(browser, "Urgent");
    await browser.$(chip("Urgent")).waitForDisplayed();
    assert.equal(await browser.$(checkbox("Work")).getAttribute("aria-checked"), "true");
    assert.equal(await browser.$("#edit-tag-input").getValue(), "");

    // Rename and recolor from the "…" menu.
    await browser.$('button[aria-label="Urgent options"]').click();
    await browser.$('//*[@role="menuitem"][normalize-space()="Rename"]').click();
    await browser.$('input[aria-label="Rename Urgent"]').setValue("Soon");
    await browser.keys("Enter");
    await browser.$(chip("Soon")).waitForDisplayed();
    await browser.$('button[aria-label="Soon options"]').click();
    await browser.$('[role="radio"][aria-label="#7C3AED"]').click();
    await browser.$('[role="radio"][aria-label="#7C3AED"][aria-checked="true"]').waitForExist();
    await browser.keys("Escape");
    await browser.$('[role="menu"]').waitForExist({ reverse: true });
    await browser.$(dialog).waitForDisplayed();

    // A tag only another bot has: "New tag" makes one on no bot.
    await browser.$(button("New tag")).click();
    await browser.$('input[aria-label="New tag name"]').setValue("Later");
    await browser.keys("Enter");
    await browser.$(checkbox("Later")).waitForDisplayed();
    assert.equal(await browser.$(checkbox("Later")).getAttribute("aria-checked"), "false");
    await browser.$(button("Done")).click();
    await browser.$(dialog).waitForExist({ reverse: true });

    // On another bot, typing finds the existing tag; the checkbox adds one too.
    await openTags(browser, "Coder");
    await typeTag(browser, "wo");
    await browser.$(chip("Work")).waitForDisplayed();
    await browser.$(checkbox("Later")).click();
    await browser.$(chip("Later")).waitForDisplayed();
    await browser.$(chip("Work")).click();
    await browser.$(chip("Work")).waitForExist({ reverse: true });

    // Deleting asks first, then takes it off every bot.
    await browser.$('button[aria-label="Later options"]').click();
    await browser.$('//*[@role="menuitem"][normalize-space()="Delete tag…"]').click();
    await waitForText(browser, "It will be removed from 1 bot.");
    await browser.$(button("Delete")).click();
    await browser.$(checkbox("Later")).waitForExist({ reverse: true });
    await browser.$(chip("Later")).waitForExist({ reverse: true });
    await browser.keys("Escape");
    await browser.$(dialog).waitForExist({ reverse: true });

    // Each row and the chat header name the bot's tags.
    const tagList = (scope: string) =>
      `${scope}//*[@aria-label="Tags"][.//*[normalize-space()="Work"]][.//*[normalize-space()="Soon"]]`;
    await browser.$(tagList(sidebarRow("Planner"))).waitForExist();
    assert.equal(await browser.$$(`${sidebarRow("Coder")}//*[@aria-label="Tags"]`).length, 0);
    await browser.$(sidebarRow("Planner")).click();
    await browser.$(tagList("//header")).waitForExist();

    // A tag chip under Search shows only the bots with it; Search finds tag names.
    await browser.$(filterChip("Work")).click();
    await browser.$(sidebarRow("Coder")).waitForExist({ reverse: true });
    await browser.$(sidebarRow("Planner")).waitForDisplayed();
    await browser.$(filterChip("Work")).click();
    await browser.$(sidebarRow("Coder")).waitForDisplayed();
    await browser.$('input[placeholder="Search"]').setValue("soon");
    await browser.$(sidebarRow("Coder")).waitForExist({ reverse: true });
    await browser.$(sidebarRow("Planner")).waitForDisplayed();
  } finally {
    await session.close();
  }

  assert.deepEqual(query("SELECT name, color FROM tags ORDER BY name"), [
    { name: "Soon", color: "#7C3AED" },
    { name: "Work", color: "#141414" },
  ]);
  assert.deepEqual(
    query(
      "SELECT bots.name AS bot, tags.name AS tag FROM bot_tags JOIN bots ON bots.id = bot_id JOIN tags ON tags.id = tag_id ORDER BY added_at, bot_tags.rowid",
    ),
    [
      { bot: "Planner", tag: "Work" },
      { bot: "Planner", tag: "Soon" },
    ],
  );
});
