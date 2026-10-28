// Built-in commands typed in the composer: the "/" menu, /clear-history and /delete.
//
// Run with `npm run test:e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import type { ChainablePromiseElement } from "webdriverio";
import { type Browser, button, createBot, launch, send, sidebarRow, waitForText } from "./app.ts";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kbot-e2e-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const composer = (name: string) => `input[placeholder="Message ${name}"]`;
const menu = '[role="listbox"][aria-label="Commands"]';
// An option shows its name, then its description.
const nameOf = (option: ChainablePromiseElement) => option.$('.//span[starts-with(text(), "/")]').getText();
const options = async (browser: Browser) => browser.$$(`${menu} [role="option"]`).map(nameOf);
const selected = async (browser: Browser) => nameOf(browser.$(`${menu} [role="option"][aria-selected="true"]`));
const confirm = (label: string) => `//*[@role="alertdialog"]//button[normalize-space()="${label}"]`;

test("the / menu filters commands, and /clear-history and /delete ask before acting", async () => {
  const session = await launch(dataDir);
  try {
    const { browser } = session;
    await createBot(browser, "Keep Bot", "bot02");
    await createBot(browser, "Cmd Bot");
    await waitForText(browser, "Hi, I'm Cmd Bot!");
    await browser.$(button("Skip setup")).click();
    await send(browser, "Cmd Bot", "hello there");
    await waitForText(browser, "Fake reply to: hello there");

    // "/" lists every command; more text narrows it; arrows move; Escape closes it.
    await browser.$(composer("Cmd Bot")).setValue("/");
    await browser.$(menu).waitForDisplayed();
    assert.deepEqual(await options(browser), ["/setup", "/clear-history", "/delete"]);
    assert.equal(await selected(browser), "/setup");
    await browser.keys("ArrowDown");
    assert.equal(await selected(browser), "/clear-history");
    await browser.keys("ArrowUp");
    await browser.keys("ArrowUp");
    assert.equal(await selected(browser), "/delete");
    await browser.keys("Escape");
    await browser.$(menu).waitForExist({ reverse: true });
    await browser.$(composer("Cmd Bot")).setValue("/c");
    assert.deepEqual(await options(browser), ["/clear-history"]);
    await browser.$(composer("Cmd Bot")).setValue("/nothing");
    await browser.$(menu).waitForExist({ reverse: true });

    // Tab completes; Enter asks, and Cancel keeps the messages.
    await browser.$(composer("Cmd Bot")).setValue("/cl");
    await browser.keys("Tab");
    assert.equal(await browser.$(composer("Cmd Bot")).getValue(), "/clear-history");
    await browser.keys("Enter");
    await waitForText(browser, "Delete all messages with Cmd Bot?");
    assert.equal(await browser.$(composer("Cmd Bot")).getValue(), "");
    await browser.$(confirm("Cancel")).click();
    await browser.$('[role="alertdialog"]').waitForExist({ reverse: true });
    await waitForText(browser, "Fake reply to: hello there");

    // Confirmed, it clears the chat like the sidebar's "Clear History".
    await browser.$(composer("Cmd Bot")).setValue("/clear");
    await browser.$(`${menu} [role="option"]`).click();
    await browser.$(confirm("Clear History")).click();
    await browser.$('//*[contains(text(), "Fake reply to: hello there")]').waitForExist({ reverse: true });
    await browser.$(`${sidebarRow("Cmd Bot")}//p[normalize-space()="No messages yet"]`).waitForExist();

    // A command typed out in full and sent with the button runs too.
    await browser.$(composer("Cmd Bot")).setValue("/delete");
    await browser.keys("Escape");
    await browser.$('button[aria-label="Send"]').click();
    await waitForText(browser, "Delete Cmd Bot with its messages and settings?");
    await browser.$(confirm("Delete")).click();
    await browser.$(sidebarRow("Cmd Bot")).waitForExist({ reverse: true });
    await browser.$(`${sidebarRow("Keep Bot")}[@aria-current="true"]`).waitForExist();
  } finally {
    await session.close();
  }

  const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT name FROM bots").all().map((r) => r.name), ["Keep Bot"]);
  } finally {
    db.close();
  }
});
