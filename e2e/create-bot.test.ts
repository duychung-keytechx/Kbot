// End-to-end test against the real app: React UI, Rust commands and SQLite.
//
// Run with `npm run test:e2e`.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { createBot, launch, sidebarRow } from "./app.ts";

let dataDir: string;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "kbot-e2e-"));
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test("a new bot is saved to SQLite and listed in the sidebar", async () => {
  const name = `E2E Bot ${Date.now()}`;

  let session = await launch(dataDir);
  try {
    const { browser } = session;
    await createBot(browser, name, "bot07");

    const row = browser.$(sidebarRow(name));
    assert.equal(await row.getAttribute("aria-current"), "true", "new bot is selected");
    assert.match(await row.$("img").getAttribute("src"), /bot07/);
    assert.equal(await browser.$('[role="dialog"]').isExisting(), false, "dialog closed");
  } finally {
    await session.close();
  }

  const db = new DatabaseSync(join(dataDir, "kbot.db"), { readOnly: true });
  try {
    assert.deepEqual({ ...db.prepare("SELECT name, kind, icon, color FROM bots").all()[0] }, {
      name,
      kind: "icon",
      icon: "bot07",
      color: "",
    });
  } finally {
    db.close();
  }

  // After a restart the sidebar is filled from the database.
  session = await launch(dataDir);
  try {
    await session.browser.$(sidebarRow(name)).waitForDisplayed({ timeout: 5_000 });
  } finally {
    await session.close();
  }
});
