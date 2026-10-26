# Kbot

A desktop app for creating and chatting with your own AI bots. Built with
[Tauri 2](https://tauri.app) (Rust) and React, with all data stored locally in
SQLite.

| Create a bot | Chat |
| --- | --- |
| ![Create New Bot dialog](docs/screenshots/new-bot.png) | ![Chat with a bot](docs/screenshots/chat.png) |

<p align="center"><img src="docs/screenshots/empty.png" alt="First launch" width="49%"></p>

> The agent is still a stub (`src-tauri/src/agent.rs`): it echoes your message
> back. Plug an LLM client in there.

## Getting started

Prerequisites: [Node.js](https://nodejs.org) 22.6+ and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) (Rust toolchain
plus your platform's build tools).

```bash
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # build an installable bundle
```

`npm run dev` runs only the UI in a browser against an in-memory mock backend
(`src/lib/mockBackend.ts`), which is handy for UI work without a Rust build.

## Project layout

```
src/                     React UI
  lib/api.ts             the only place the UI talks to Rust (commands + events)
  components/            sidebar, chat view, "Create New Bot" dialog, avatars
src-tauri/
  src/commands.rs        UI -> Rust commands (list_bots, create_bot, send_message, ...)
  src/store.rs           SQLite persistence
  src/migrate.rs         migration runner
  migrations/            SQL migration scripts
  src/agent.rs           agent runtime (stub)
e2e/                     end-to-end tests and screenshot script
docs/screenshots/        README images
```

## Database and migrations

Bots and messages are stored in `kbot.db` in the OS app-data directory
(e.g. `~/Library/Application Support/com.keytechx.kbot/` on macOS).

Every `.sql` file in `src-tauri/migrations/` is compiled into the app.
On each launch, pending migrations run in order, each in its own
transaction, and are recorded in the `schema_migrations` table. A fresh install
creates the whole schema on first launch; existing installs upgrade when they
open a newer version.

To change the schema, add a new file with the next number:

```
src-tauri/migrations/0002_add_bot_description.sql
```

Never edit a migration that has already shipped. The build fails on a badly
named file or a duplicate version number.

## Testing

```bash
cd src-tauri && cargo test   # store and migration unit tests
npm run test:e2e             # end-to-end tests against the real app
```

The end-to-end tests build the app with the `e2e` cargo feature, which embeds a
WebDriver server
([tauri-plugin-wdio-webdriver](https://crates.io/crates/tauri-plugin-wdio-webdriver)),
then drive the real window with [WebdriverIO](https://webdriver.io) against a
throwaway database. That feature is never enabled in normal builds. If the app
is already built, run just the tests with `node --test "e2e/**/*.test.ts"`.

To regenerate the screenshots above: `npm run screenshots`.

## Third-party notices

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the bot icon sets and
their licenses.
