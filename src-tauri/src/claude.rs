//! Claude Code CLI runtime. Agents run as `claude -p` child processes on the
//! user's Claude subscription (never an API key): this module finds the
//! binary, checks how it is signed in, builds the command line and parses its
//! `stream-json` output.
//!
//! Tested against Claude Code 2.1.310. The parser ignores event types and
//! fields it doesn't know, so newer CLI versions keep working.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;
use tokio::sync::mpsc::UnboundedReceiver;

use crate::events;
use crate::AppState;

/// `--permission-mode` for agent runs: every tool call runs without asking,
/// including shell commands and file changes anywhere on the computer.
pub const PERMISSION_MODE: &str = "bypassPermissions";

/// The Claude Code tools a run gets.
#[derive(Debug, Clone, PartialEq)]
pub enum Tools {
    /// No tools: onboarding helpers that only answer in JSON.
    None,
    /// Claude Code's default set, minus these.
    AllExcept(Vec<&'static str>),
}

/// Variables that would make the CLI bill an API key or a cloud provider
/// instead of the user's subscription. Removed from every child process.
const API_ENV: [&str; 6] = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];

const STATUS_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClaudeStatus {
    NotInstalled,
    LoggedOut,
    /// Signed in, but billed through an API key, Bedrock, Vertex...
    NotSubscription { auth_method: String },
    Ready { subscription: String, email: Option<String> },
}

/// Parses `claude auth status --json`.
pub fn parse_status(json: &str) -> ClaudeStatus {
    let Ok(v) = serde_json::from_str::<Value>(json) else {
        return ClaudeStatus::LoggedOut;
    };
    let text = |key: &str| v.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    if v.get("loggedIn").and_then(Value::as_bool) != Some(true) {
        return ClaudeStatus::LoggedOut;
    }
    let (method, provider, subscription) = (text("authMethod"), text("apiProvider"), text("subscriptionType"));
    if method != "claude.ai" || provider != "firstParty" {
        let auth_method = if provider.is_empty() || provider == "firstParty" { method } else { provider };
        return ClaudeStatus::NotSubscription { auth_method };
    }
    if subscription.is_empty() {
        return ClaudeStatus::NotSubscription { auth_method: "claude.ai without a subscription".into() };
    }
    let email = Some(text("email")).filter(|e| !e.is_empty());
    ClaudeStatus::Ready { subscription, email }
}

/// Located binary plus the last auth check, shared by all runs.
#[derive(Default)]
pub struct Claude {
    status: Mutex<Option<(Instant, ClaudeStatus)>>,
    bin: Mutex<Option<PathBuf>>,
}

/// Where to look for `claude`. An app opened from Finder doesn't inherit the
/// shell's PATH, so the usual install locations are tried before the login shell.
fn find_binary(configured: Option<String>) -> Option<PathBuf> {
    let is_file = |p: &PathBuf| p.is_file();
    // Lets e2e tests substitute a fake CLI.
    if let Some(p) = std::env::var_os("KBOT_CLAUDE_BIN").map(PathBuf::from).filter(is_file) {
        return Some(p);
    }
    if let Some(p) = configured.map(PathBuf::from).filter(is_file) {
        return Some(p);
    }
    let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
    let mut candidates = Vec::new();
    if let Some(home) = std::env::home_dir() {
        candidates.push(home.join(".local/bin").join(exe));
        candidates.push(home.join(".claude/local").join(exe));
    }
    candidates.extend(["/opt/homebrew/bin/claude", "/usr/local/bin/claude"].map(PathBuf::from));
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(exe)));
    }
    if let Some(p) = candidates.into_iter().find(is_file) {
        return Some(p);
    }
    login_shell_lookup()
}

#[cfg(unix)]
fn login_shell_lookup() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = std::process::Command::new(shell)
        .args(["-lc", "command -v claude"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    path.is_file().then_some(path)
}

#[cfg(not(unix))]
fn login_shell_lookup() -> Option<PathBuf> {
    None
}

/// A `claude` command with the API-key variables removed.
fn command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    for key in API_ENV {
        cmd.env_remove(key);
    }
    // The CLI may need tools next to it (e.g. a Node install) that a Finder
    // launch has no PATH entry for.
    if let Some(dir) = bin.parent() {
        let mut paths = vec![dir.to_path_buf()];
        paths.extend(std::env::var_os("PATH").iter().flat_map(std::env::split_paths));
        if let Ok(path) = std::env::join_paths(paths) {
            cmd.env("PATH", path);
        }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    cmd
}

/// Deletes Claude Code's state for the project at `cwd` (its transcripts,
/// file history and config entry) with `claude purge`. Works after `cwd` is
/// gone. Best effort: failures are only logged.
pub async fn purge(app: &AppHandle, cwd: &Path) {
    let state = app.state::<AppState>();
    let bin = match state.claude.binary() {
        Some(bin) => Some(bin),
        None => {
            let configured = state.store.lock().unwrap().app_setting("claude_path");
            tauri::async_runtime::spawn_blocking(move || find_binary(configured)).await.ok().flatten()
        }
    };
    let Some(bin) = bin else { return };
    let mut cmd = command(&bin);
    cmd.arg("purge").arg("--yes").arg(cwd);
    match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => {}
        Ok(Ok(out)) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            // Exits 1 when Claude Code never ran there.
            if !stderr.contains("No Claude Code project state found") {
                eprintln!("claude purge {} failed: {}", cwd.display(), stderr.trim());
            }
        }
        Ok(Err(e)) => eprintln!("claude purge {} failed: {e}", cwd.display()),
        Err(_) => eprintln!("claude purge {} timed out", cwd.display()),
    }
}

impl Claude {
    pub fn binary(&self) -> Option<PathBuf> {
        self.bin.lock().unwrap().clone()
    }

    /// Forgets the cached auth check, e.g. after a run failed.
    pub fn invalidate(&self) {
        *self.status.lock().unwrap() = None;
    }
}

/// The current auth status, cached for 10 minutes unless `refresh`.
/// Emits `kbot://claude` when it changes.
pub async fn status(app: &AppHandle, refresh: bool) -> ClaudeStatus {
    let state = app.state::<AppState>();
    if !refresh
        && let Some((at, status)) = state.claude.status.lock().unwrap().clone()
        && at.elapsed() < STATUS_TTL
    {
        return status;
    }
    let configured = state.store.lock().unwrap().app_setting("claude_path");
    let bin = tauri::async_runtime::spawn_blocking(move || find_binary(configured)).await.ok().flatten();
    let status = match &bin {
        None => ClaudeStatus::NotInstalled,
        Some(bin) => {
            let mut cmd = command(bin);
            cmd.args(["auth", "status", "--json"]);
            match tokio::time::timeout(Duration::from_secs(20), cmd.output()).await {
                // Prints JSON (and exits 1) when logged out too.
                Ok(Ok(out)) => parse_status(&String::from_utf8_lossy(&out.stdout)),
                Ok(Err(e)) => {
                    eprintln!("claude auth status failed: {e}");
                    ClaudeStatus::NotInstalled
                }
                Err(_) => {
                    eprintln!("claude auth status timed out");
                    ClaudeStatus::LoggedOut
                }
            }
        }
    };
    *state.claude.bin.lock().unwrap() = bin;
    let previous = state.claude.status.lock().unwrap().replace((Instant::now(), status.clone()));
    if previous.map(|(_, s)| s) != Some(status.clone()) {
        events::claude_status(app, &status);
    }
    status
}

/// Which Claude session a run continues.
#[derive(Debug, Clone, PartialEq)]
pub enum Session {
    /// Start the bot's session with this id.
    New(String),
    Resume(String),
    /// One-off call that isn't saved (onboarding helpers).
    Ephemeral,
}

#[derive(Debug, Clone)]
pub struct RunSpec {
    pub prompt: String,
    pub system_prompt: String,
    pub session: Session,
    pub tools: Tools,
    pub add_dirs: Vec<String>,
    pub model: Option<String>,
    pub json_schema: Option<Value>,
    /// Empty working directory of the bot, so sessions never mix with a user project.
    pub cwd: PathBuf,
}

impl RunSpec {
    /// Command-line arguments; the prompt itself goes to stdin.
    pub fn args(&self) -> Vec<String> {
        let mut args: Vec<String> = [
            "-p",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            // The prompt and answers to permission requests go to stdin as
            // JSON lines; Claude Code asks for permission on stdout.
            "--input-format",
            "stream-json",
            "--permission-prompt-tool",
            "stdio",
            // No user/project settings, CLAUDE.md, hooks or MCP servers.
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--permission-mode",
            PERMISSION_MODE,
            "--system-prompt",
        ]
        .map(String::from)
        .to_vec();
        args.push(self.system_prompt.clone());
        match &self.session {
            Session::New(id) => args.extend(["--session-id".into(), id.clone()]),
            Session::Resume(id) => args.extend(["--resume".into(), id.clone()]),
            Session::Ephemeral => args.push("--no-session-persistence".into()),
        }
        match &self.tools {
            Tools::None => args.extend(["--tools".into(), String::new()]),
            Tools::AllExcept(except) => {
                args.extend(["--tools".into(), "default".into()]);
                if !except.is_empty() {
                    args.extend(["--disallowedTools".into(), except.join(" ")]);
                }
            }
        }
        for dir in &self.add_dirs {
            args.extend(["--add-dir".into(), dir.clone()]);
        }
        if let Some(model) = &self.model {
            args.extend(["--model".into(), model.clone()]);
        }
        if let Some(schema) = &self.json_schema {
            args.extend(["--json-schema".into(), schema.to_string()]);
        }
        args
    }
}

/// One parsed line of `--output-format stream-json`.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Init { session_id: String, api_key_source: String },
    /// A new text block starts; deltas that follow belong to it.
    TextStart,
    TextDelta(String),
    /// A finished text block (also sent without `--include-partial-messages`).
    Text(String),
    ToolUse { name: String, input: Value },
    /// Claude Code wants an OK before running a tool (or an answer, for
    /// `AskUserQuestion`); reply with `permission_reply`.
    PermissionRequest { request_id: String, tool: String, input: Value },
    /// The subscription's usage limit was hit. Unix seconds.
    RateLimited { resets_at: Option<i64> },
    Result { is_error: bool, text: Option<String>, errors: Vec<String>, structured: Option<Value> },
}

/// Parses one stdout line into the events it carries (an `assistant` line can
/// hold several content blocks). Unknown lines yield nothing.
pub fn parse_line(line: &str) -> Vec<Event> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let str_at = |v: &Value, ptr: &str| v.pointer(ptr).and_then(Value::as_str).map(String::from);
    match v.get("type").and_then(Value::as_str).unwrap_or_default() {
        "system" if str_at(&v, "/subtype").as_deref() == Some("init") => vec![Event::Init {
            session_id: str_at(&v, "/session_id").unwrap_or_default(),
            api_key_source: str_at(&v, "/apiKeySource").unwrap_or_default(),
        }],
        "stream_event" => match str_at(&v, "/event/type").as_deref() {
            Some("content_block_start") if str_at(&v, "/event/content_block/type").as_deref() == Some("text") => {
                vec![Event::TextStart]
            }
            Some("content_block_delta") if str_at(&v, "/event/delta/type").as_deref() == Some("text_delta") => {
                str_at(&v, "/event/delta/text").map(Event::TextDelta).into_iter().collect()
            }
            _ => Vec::new(),
        },
        "assistant" => {
            let blocks = v.pointer("/message/content").and_then(Value::as_array);
            blocks
                .into_iter()
                .flatten()
                .filter_map(|block| match block.get("type").and_then(Value::as_str)? {
                    "text" => Some(Event::Text(str_at(block, "/text")?)),
                    "tool_use" => Some(Event::ToolUse {
                        name: str_at(block, "/name")?,
                        input: block.get("input").cloned().unwrap_or(Value::Null),
                    }),
                    _ => None,
                })
                .collect()
        }
        "control_request" if str_at(&v, "/request/subtype").as_deref() == Some("can_use_tool") => {
            vec![Event::PermissionRequest {
                request_id: str_at(&v, "/request_id").unwrap_or_default(),
                tool: str_at(&v, "/request/tool_name").unwrap_or_default(),
                input: v.pointer("/request/input").cloned().unwrap_or(Value::Null),
            }]
        }
        "rate_limit_event" => {
            let status = str_at(&v, "/rate_limit_info/status").unwrap_or_default();
            if status == "rejected" {
                let resets_at = v.pointer("/rate_limit_info/resetsAt").and_then(Value::as_i64);
                vec![Event::RateLimited { resets_at }]
            } else {
                Vec::new()
            }
        }
        "result" => vec![Event::Result {
            is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false),
            text: str_at(&v, "/result"),
            errors: v
                .get("errors")
                .and_then(Value::as_array)
                .map(|e| e.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            structured: v.get("structured_output").cloned().filter(|s| !s.is_null()),
        }],
        _ => Vec::new(),
    }
}

/// The stdin line answering a `PermissionRequest`: `Ok(input)` runs the
/// tool with that input, `Err(reason)` refuses it.
pub fn permission_reply(request_id: &str, decision: Result<Value, String>) -> String {
    let response = match decision {
        Ok(input) => json!({"behavior": "allow", "updatedInput": input}),
        Err(message) => json!({"behavior": "deny", "message": message}),
    };
    let reply = json!({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": request_id, "response": response},
    });
    format!("{reply}\n")
}

/// How a run ended.
#[derive(Debug)]
pub enum Exit {
    /// The process exited by itself.
    Finished { success: bool, stderr: String },
    /// `cancel` was notified, or the event handler asked to stop.
    Stopped,
}

/// Runs `claude` with `spec`, calling `on_event` for every parsed event.
/// Returning `false` from `on_event` kills the process. Notifying `cancel`
/// kills it too. Lines from `input` are written to its stdin until the
/// result arrives.
pub async fn run(
    bin: &Path,
    spec: &RunSpec,
    cancel: Arc<Notify>,
    mut input: Option<&mut UnboundedReceiver<String>>,
    mut on_event: impl FnMut(Event) -> bool,
) -> Result<Exit, String> {
    std::fs::create_dir_all(&spec.cwd).map_err(|e| format!("can't create {}: {e}", spec.cwd.display()))?;
    let mut cmd = command(bin);
    cmd.args(spec.args()).current_dir(&spec.cwd).stdin(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("can't start Claude Code: {e}"))?;

    let mut stdin = Some(child.stdin.take().expect("piped stdin"));
    let prompt = json!({"type": "user", "message": {"role": "user", "content": spec.prompt}});
    if let Some(stdin) = &mut stdin {
        stdin.write_all(format!("{prompt}\n").as_bytes()).await.map_err(|e| format!("can't send the prompt: {e}"))?;
    }

    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    let events = parse_line(&line);
                    // Claude Code waits for more input until stdin closes.
                    if events.iter().any(|e| matches!(e, Event::Result { .. })) {
                        stdin = None;
                    }
                    if !events.into_iter().all(&mut on_event) {
                        let _ = child.kill().await;
                        return Ok(Exit::Stopped);
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("reading claude output failed: {e}");
                    break;
                }
            },
            Some(line) = next_input(&mut input), if stdin.is_some() => {
                if let Some(stdin) = &mut stdin
                    && let Err(e) = stdin.write_all(line.as_bytes()).await
                {
                    eprintln!("writing to claude failed: {e}");
                }
            }
            _ = cancel.notified() => {
                let _ = child.kill().await;
                return Ok(Exit::Stopped);
            }
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = stderr.await.unwrap_or_default();
    Ok(Exit::Finished { success: status.success(), stderr })
}

async fn next_input(input: &mut Option<&mut UnboundedReceiver<String>>) -> Option<String> {
    match input {
        Some(input) => input.recv().await,
        None => std::future::pending().await,
    }
}

/// One-off structured call (`--json-schema`) with no tools and no saved
/// session. Returns the `structured_output` object.
pub async fn ask_json(
    bin: &Path,
    cwd: PathBuf,
    system_prompt: String,
    prompt: String,
    schema: Value,
    model: Option<String>,
    cancel: Arc<Notify>,
) -> Result<Value, String> {
    let spec = RunSpec {
        prompt,
        system_prompt,
        session: Session::Ephemeral,
        tools: Tools::None,
        add_dirs: Vec::new(),
        model,
        json_schema: Some(schema),
        cwd,
    };
    let mut output = None;
    let mut error = None;
    let exit = run(bin, &spec, cancel, None, |event| {
        match event {
            Event::Init { api_key_source, .. } if api_key_source != "none" => {
                error = Some(not_subscription_error(&api_key_source));
                return false;
            }
            Event::Result { is_error: false, structured: Some(v), .. } => output = Some(v),
            Event::Result { is_error: true, text, errors, .. } => {
                error = Some(text.unwrap_or_else(|| errors.join("; ")));
            }
            _ => {}
        }
        true
    })
    .await?;
    if let Some(v) = output {
        return Ok(v);
    }
    Err(error.unwrap_or_else(|| match exit {
        Exit::Stopped => "stopped".into(),
        Exit::Finished { stderr, .. } => format!("Claude Code returned no answer. {}", stderr.trim()),
    }))
}

pub fn not_subscription_error(api_key_source: &str) -> String {
    format!(
        "Claude Code is using an API key ({api_key_source}) instead of your Claude subscription, so Kbot stopped the run. \
         Remove the key and sign in with `claude auth login`."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_status_states() {
        let ready = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",
            "email":"me@example.com","subscriptionType":"team"}"#;
        assert_eq!(
            parse_status(ready),
            ClaudeStatus::Ready { subscription: "team".into(), email: Some("me@example.com".into()) }
        );
        assert_eq!(
            parse_status(r#"{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}"#),
            ClaudeStatus::LoggedOut
        );
        assert_eq!(
            parse_status(r#"{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}"#),
            ClaudeStatus::NotSubscription { auth_method: "api_key".into() }
        );
        assert_eq!(
            parse_status(r#"{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}"#),
            ClaudeStatus::NotSubscription { auth_method: "bedrock".into() }
        );
        assert!(matches!(
            parse_status(r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}"#),
            ClaudeStatus::NotSubscription { .. }
        ));
        assert_eq!(parse_status("not json"), ClaudeStatus::LoggedOut);
    }

    #[test]
    fn status_serializes_for_the_ui() {
        let json = serde_json::to_value(ClaudeStatus::NotSubscription { auth_method: "api_key".into() }).unwrap();
        assert_eq!(json, serde_json::json!({"state": "notSubscription", "authMethod": "api_key"}));
    }

    /// Output of a real `claude -p` run that reads two files (paths shortened).
    #[test]
    fn parses_real_stream() {
        let events: Vec<Event> =
            include_str!("fixtures/stream_read_files.jsonl").lines().flat_map(parse_line).collect();
        assert!(matches!(&events[0], Event::Init { api_key_source, .. } if api_key_source == "none"));
        let tools: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                Event::ToolUse { name, input } => Some((name.as_str(), input["file_path"].as_str().unwrap())),
                _ => None,
            })
            .collect();
        assert_eq!(tools, [("Read", "/Users/me/allowed/a.txt"), ("Read", "/Users/me/allowed2/b.txt")]);
        let deltas: String = events
            .iter()
            .filter_map(|e| match e {
                Event::TextDelta(d) => Some(d.as_str()),
                _ => None,
            })
            .collect();
        let full = events.iter().find_map(|e| match e {
            Event::Text(t) => Some(t.clone()),
            _ => None,
        });
        assert_eq!(Some(deltas), full);
        let start = events.iter().position(|e| *e == Event::TextStart).unwrap();
        assert!(matches!(events[start + 1], Event::TextDelta(_)));
        assert!(matches!(events.last(), Some(Event::Result { is_error: false, .. })));
    }

    #[test]
    fn parses_permission_requests_and_builds_replies() {
        // Captured from Claude Code 2.1.310 (`--permission-prompt-tool stdio`).
        let bash = r#"{"type":"control_request","request_id":"a842","request":{"subtype":"can_use_tool",
            "tool_name":"Bash","display_name":"Bash","input":{"command":"touch probe.txt && ls -l",
            "description":"Create probe.txt and list directory details"},
            "description":"Create probe.txt and list directory details","permission_suggestions":[]}}"#;
        let input = serde_json::json!({"command": "touch probe.txt && ls -l", "description": "Create probe.txt and list directory details"});
        assert_eq!(
            parse_line(bash),
            [Event::PermissionRequest { request_id: "a842".into(), tool: "Bash".into(), input: input.clone() }]
        );
        let other = r#"{"type":"control_request","request_id":"x","request":{"subtype":"hook_callback"}}"#;
        assert!(parse_line(other).is_empty());

        let allow: Value = serde_json::from_str(&permission_reply("a842", Ok(input.clone()))).unwrap();
        assert_eq!(
            allow,
            serde_json::json!({"type": "control_response", "response": {"subtype": "success", "request_id": "a842",
                "response": {"behavior": "allow", "updatedInput": input}}})
        );
        let deny = permission_reply("a842", Err("No".into()));
        assert!(deny.ends_with('\n') && deny.contains(r#""behavior":"deny","message":"No""#));
    }

    #[test]
    fn parses_limits_errors_and_unknown_lines() {
        let limited = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1792990200}}"#;
        assert_eq!(parse_line(limited), [Event::RateLimited { resets_at: Some(1792990200) }]);
        let allowed = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1}}"#;
        assert!(parse_line(allowed).is_empty());
        let missing = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":null,
            "errors":["No conversation found with session ID: x"]}"#;
        assert_eq!(
            parse_line(&missing.replace('\n', "")),
            [Event::Result {
                is_error: true,
                text: None,
                errors: vec!["No conversation found with session ID: x".into()],
                structured: None
            }]
        );
        let structured = r#"{"type":"result","is_error":false,"result":"{}","structured_output":{"questions":[]}}"#;
        assert!(matches!(&parse_line(structured)[0], Event::Result { structured: Some(_), .. }));
        assert!(parse_line(r#"{"type":"something_new","x":1}"#).is_empty());
        assert!(parse_line("Warning: not json").is_empty());
    }

    #[test]
    fn args_limit_tools_and_folders() {
        let mut spec = RunSpec {
            prompt: "hi".into(),
            system_prompt: "You are Bot.".into(),
            session: Session::Resume("s1".into()),
            tools: Tools::AllExcept(vec!["WebSearch", "WebFetch"]),
            add_dirs: vec!["/a".into(), "/b".into()],
            model: Some("sonnet".into()),
            json_schema: None,
            cwd: PathBuf::from("/tmp"),
        };
        let args = spec.args().join("|");
        assert!(args.contains("|--setting-sources||--strict-mcp-config|"));
        assert!(args.contains("|--permission-mode|bypassPermissions|"));
        assert!(args.contains("|--input-format|stream-json|--permission-prompt-tool|stdio|"));
        assert!(args.contains("|--resume|s1|"));
        assert!(args.contains("|--tools|default|--disallowedTools|WebSearch WebFetch|"));
        assert!(args.contains("|--add-dir|/a|--add-dir|/b|--model|sonnet"));
        assert!(!args.contains("hi"), "prompt goes to stdin");

        spec.tools = Tools::AllExcept(Vec::new());
        assert!(spec.args().join("|").contains("|--tools|default|"));
        assert!(!spec.args().contains(&"--disallowedTools".to_string()));

        spec.tools = Tools::None;
        spec.add_dirs.clear();
        spec.session = Session::Ephemeral;
        let args = spec.args();
        let tools = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[tools + 1], "");
        assert!(args.contains(&"--no-session-persistence".to_string()));
    }
}
