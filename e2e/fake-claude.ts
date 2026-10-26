#!/usr/bin/env node
// Stand-in for the `claude` CLI in e2e tests (`KBOT_CLAUDE_BIN`). Prints the
// same shapes as Claude Code 2.1.310 (see src-tauri/src/fixtures/):
//
// - `auth status --json`: signed in with a subscription, or signed out when
//   FAKE_CLAUDE_STATE=loggedOut.
// - `-p ... --json-schema <schema>`: onboarding helpers; one clarifying
//   question, then instructions built from the prompt.
// - `-p ...`: a streamed reply quoting the last line of the prompt.
//
// Every call's arguments are appended to FAKE_CLAUDE_LOG (JSON lines) if set.

import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\n");

const out = (event: object) => process.stdout.write(JSON.stringify(event) + "\n");
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

if (args[0] === "auth" && args[1] === "status") {
  if (process.env.FAKE_CLAUDE_STATE === "loggedOut") {
    out({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" });
    process.exit(1);
  }
  out({
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "e2e@example.com",
    orgName: "E2E",
    subscriptionType: "max",
  });
  process.exit(0);
}

if (args[0] !== "-p") {
  process.stderr.write(`fake-claude: unsupported arguments ${args.join(" ")}\n`);
  process.exit(2);
}

const prompt = readFileSync(0, "utf8");
const sessionId = flag("--session-id") ?? flag("--resume") ?? randomUUID();
out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none", tools: [], model: "fake" });

const schema = flag("--json-schema");
if (schema) {
  const structured = schema.includes('"questions"')
    ? { questions: ["Which topics matter most to you?"] }
    : {
        instructions: `You write a short, friendly brief. ${prompt.match(/A: (.*)/)?.[1] ?? ""}`.trim(),
        task: prompt.includes("Kind: daily job") ? "Write today's brief." : "",
      };
  out({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(structured), structured_output: structured });
  process.exit(0);
}

const last = prompt.trim().split("\n").at(-1) ?? "";
const reply = `Fake reply to: ${last}`;
const stream = (event: object) => out({ type: "stream_event", event, session_id: sessionId });
stream({ type: "message_start", message: { content: [] } });
stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
for (const part of reply.match(/.{1,8}/g) ?? []) {
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } });
  await new Promise((r) => setTimeout(r, 20));
}
out({ type: "assistant", message: { content: [{ type: "text", text: reply }] }, session_id: sessionId });
stream({ type: "content_block_stop", index: 0 });
out({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
out({ type: "result", subtype: "success", is_error: false, result: reply, session_id: sessionId });
