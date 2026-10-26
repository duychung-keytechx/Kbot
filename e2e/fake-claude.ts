#!/usr/bin/env node
// Stand-in for the `claude` CLI in e2e tests (`KBOT_CLAUDE_BIN`). Prints the
// same shapes as Claude Code 2.1.310 (see src-tauri/src/fixtures/):
//
// - `auth status --json`: signed in with a subscription, or signed out when
//   FAKE_CLAUDE_STATE=loggedOut.
// - `purge --yes <path>`: does nothing and succeeds.
// - `-p ... --json-schema <schema>`: onboarding helpers; one clarifying
//   question, then instructions built from the prompt. A `/setup` change
//   appends the request to the instructions and takes any "HH:MM" as the time.
// - `-p ...`: a streamed reply quoting the last line of the prompt. A prompt
//   ending in "ask me" first asks "Coffee or tea?" with AskUserQuestion; one
//   ending in "needs approval" first asks to run a Bash command. Both wait for
//   the answer on stdin, like `--permission-prompt-tool stdio`.
//
// The prompt arrives on stdin as a stream-json user message
// (`--input-format stream-json`).
//
// Every call's arguments are appended to FAKE_CLAUDE_LOG (JSON lines) if set.

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

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

if (args[0] === "purge") process.exit(0);

if (args[0] !== "-p") {
  process.stderr.write(`fake-claude: unsupported arguments ${args.join(" ")}\n`);
  process.exit(2);
}

// Stdin stays open for permission answers, so read it line by line.
const stdin = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const readLine = async () => JSON.parse((await stdin.next()).value as string);
const prompt: string = (await readLine()).message.content;
const sessionId = flag("--session-id") ?? flag("--resume") ?? randomUUID();
out({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none", tools: [], model: "fake" });

const schema = flag("--json-schema");
if (schema) {
  const edit = prompt.match(/Current setup:\n([\s\S]*?)\n\nThe user's change request:\n([\s\S]*)/);
  const structured = edit
    ? (() => {
        const current = JSON.parse(edit[1]);
        const request = edit[2].trim();
        return {
          ...current,
          instructions: `${current.instructions} ${request}`,
          time: request.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? current.time,
          note: "Updated as you asked.",
        };
      })()
    : schema.includes('"questions"')
      ? { questions: ["Which topics matter most to you?"] }
      : {
          instructions: `You write a short, friendly brief. ${prompt.match(/A: (.*)/)?.[1] ?? ""}`.trim(),
          task: prompt.includes("Kind: daily job")
            ? "Write today's brief."
            : prompt.includes("Kind: scheduled job")
              ? "Check for new posts."
              : prompt.includes("Kind: scheduled task")
                ? "Do the task."
                : "",
        };
  out({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(structured), structured_output: structured });
  process.exit(0);
}

const last = prompt.trim().split("\n").at(-1) ?? "";

/** Asks like `--permission-prompt-tool stdio` and waits for Kbot's answer. */
async function ask(tool: string, input: object) {
  const id = randomUUID();
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: tool, input }] }, session_id: sessionId });
  out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: tool, input } });
  const answer = await readLine();
  if (answer.type !== "control_response" || answer.response.request_id !== id) throw new Error("unexpected stdin line");
  return answer.response.response as { behavior: "allow" | "deny"; updatedInput?: { answers?: Record<string, string> } };
}

let reply = `Fake reply to: ${last}`;
if (/ask me$/i.test(last)) {
  const question = "Coffee or tea?";
  const answer = await ask("AskUserQuestion", {
    questions: [
      {
        question,
        header: "Drink",
        options: [
          { label: "Coffee", description: "Strong and hot" },
          { label: "Tea", description: "Green, no sugar" },
        ],
        multiSelect: false,
      },
    ],
  });
  reply = answer.behavior === "allow" ? `You picked ${answer.updatedInput?.answers?.[question]}.` : "You skipped it.";
} else if (/needs approval$/i.test(last)) {
  const answer = await ask("Bash", { command: "rm -rf build", description: "Delete the build folder" });
  reply = answer.behavior === "allow" ? "Approved, build folder deleted." : "Denied, I left it alone.";
}
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
