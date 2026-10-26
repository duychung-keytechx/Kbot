<h1 align="center">Kbot</h1>

<p align="center"><b>Don't just chat with AI. Put it to work.</b></p>

<p align="center">
Kbot is more than a chatbot. It lets anyone build <b>personal agents</b> shaped
around their own needs: a sales assistant that finds leads, a recruiter that
screens candidates, a researcher that digs through the web. Each one is yours to
name, style and put to work, right from your desktop.
</p>

| Build your agent | Put it to work |
| --- | --- |
| ![Create New Bot dialog](docs/screenshots/new-bot.png) | ![Chat with a bot](docs/screenshots/chat.png) |

<p align="center"><img src="docs/screenshots/empty.png" alt="First launch" width="49%"></p>

## Why Kbot

- **Agents, not just answers.** A chatbot tells you what to do; a Kbot agent
  does it. Agents are built to use tools and even take over the computer, and
  hand control back to you whenever you want it.
- **Built around you.** Spin up as many agents as you need, one per job, each
  with its own name, look and conversation history.
- **Your data stays on your machine.** Kbot is a native desktop app. Your
  agents and conversations are stored in a local database on your computer and
  are never stored in the cloud.

Agents run on [Claude Code](https://docs.claude.com/en/docs/claude-code),
using your own Claude subscription. Built with [Tauri 2](https://tauri.app)
(Rust) and React, with all data stored locally in SQLite.

## How it works

- **Setup in the chat.** A new agent asks what it should do: chat with you, or
  run a daily job. It asks for a description, a schedule, whether it may search
  the web and which folders it may read, asks Claude a few clarifying questions,
  then shows the instructions it wrote for itself for you to confirm or edit.
- **Daily jobs.** A job runs at its set time on the chosen days and posts the
  result in the chat (with a notification if you want one). Jobs only run while
  Kbot is open; a missed run is not caught up later.
- **Settings.** Click the agent's name above the chat to change its
  instructions, schedule, web access, folders or model, run the job now, or redo
  the setup.
- **Read-only folders.** Agents can read the folders you give them but have no
  tools to write files or run commands.

## Getting started

To use Kbot you need a Claude subscription (Pro or Max) and Claude Code
installed and signed in with it:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude auth login
```

Kbot shows a "Connect Claude" screen until it finds a signed-in `claude`. It
looks for the binary in the usual install locations, then on your `PATH`; set
`KBOT_CLAUDE_BIN` to use a specific one.

To build it you also need [Node.js](https://nodejs.org) 22.6+ and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) (Rust toolchain
plus your platform's build tools).

```bash
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # build an installable bundle
```

`npm run dev` runs only the UI in a browser against an in-memory mock backend
(`src/lib/mockBackend.ts`), which is handy for UI work without a Rust build.
Add `?claude=loggedOut` (or `notInstalled`, `notSubscription`) to the URL to see
the Connect Claude screen.

## Project layout

```
src/                     React UI
  lib/api.ts             the only place the UI talks to Rust (commands + events)
  components/            sidebar, chat view, setup cards, settings, "Create New Bot" dialog
src-tauri/
  src/commands.rs        UI -> Rust commands (list_bots, create_bot, send_message, ...)
  src/store.rs           SQLite persistence
  src/migrate.rs         migration runner
  migrations/            SQL migration scripts
  src/claude.rs          finds and runs the Claude Code CLI, parses its stream-json output
  src/agent.rs           one agent turn: builds the prompt, streams the reply into the chat
  src/setup.rs           onboarding state machine
  src/scheduler.rs       daily jobs
  src/runs.rs            one run per bot at a time, cancellation
e2e/                     end-to-end tests, fake `claude` CLI, screenshot script
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
src-tauri/migrations/0003_add_bot_tags.sql
```

Never edit a migration that has already shipped. The build fails on a badly
named file or a duplicate version number.

## Testing

```bash
cd src-tauri && cargo test   # store, setup, scheduler and stream parser unit tests
npm run test:e2e             # end-to-end tests against the real app
```

The end-to-end tests build the app with the `e2e` cargo feature, which embeds a
WebDriver server
([tauri-plugin-wdio-webdriver](https://crates.io/crates/tauri-plugin-wdio-webdriver)),
then drive the real window with [WebdriverIO](https://webdriver.io) against a
throwaway data directory (`KBOT_DATA_DIR`, deleted afterwards), so they never
touch your real agents; an e2e build refuses to start without it. Claude Code is replaced by `e2e/fake-claude.ts` (through
`KBOT_CLAUDE_BIN`), so the tests need no account and use no quota. That feature
is never enabled in normal builds. If the app
is already built, run just the tests with `node --test "e2e/**/*.test.ts"`.

To regenerate the screenshots above: `npm run screenshots`.

## License

Kbot is released under the [MIT License](LICENSE).

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the bot icon sets and
their licenses.
