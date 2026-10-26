// Regenerates the README screenshots in docs/screenshots from the real app.
//
// Run with `npm run screenshots`.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { button, createBot, launch, send, sidebarRow, waitForText } from "./app.ts";

const OUT = join(import.meta.dirname, "../docs/screenshots");
mkdirSync(OUT, { recursive: true });

const dataDir = mkdtempSync(join(tmpdir(), "kbot-shots-"));
const { browser, close } = await launch(dataDir);
try {
  await browser.$("//p[text()='No bots yet']").waitForDisplayed();
  await browser.saveScreenshot(join(OUT, "empty.png"));

  await createBot(browser, "Research Bot", "cyclops", "#7C3AED");
  await createBot(browser, "Recruiter", "buddy", "#16B364");
  await createBot(browser, "Sales Assistant", "happy", "#1A73F0");

  await browser.$('button[aria-label="New bot"]').click();
  await browser.$('input[placeholder="Name your bot"]').setValue("Support Bot");
  await browser.$('[aria-label="Icon"] button[aria-label="bubble"]').click();
  await browser.$('[aria-label="Color"] button[aria-label="#FF5A1F"]').click();
  await browser.saveScreenshot(join(OUT, "new-bot.png"));
  await browser.$('[role="dialog"] button[type="submit"]').click();
  await browser.$(sidebarRow("Support Bot")).waitForDisplayed();

  // A new bot sets itself up in the chat.
  await browser.$(sidebarRow("Sales Assistant")).click();
  await waitForText(browser, "Hi, I'm Sales Assistant!");
  await browser.$(button("Chat with me")).click();
  await waitForText(browser, "Describe what I should do.");
  await send(browser, "Sales Assistant", "Find new fintech leads each week and draft a short intro email for each one");
  await waitForText(browser, "Should I be able to search the web?");
  await browser.$(button("Yes")).click();
  await waitForText(browser, "Any folders I should look into?");
  await browser.saveScreenshot(join(OUT, "chat.png"));
} finally {
  await close();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log(`Screenshots written to ${OUT}`);
