//! OpenAI Codex CLI runtime, the alternative to `claude.rs` chosen in Kbot >
//! Settings…. Agents run as `codex exec --json` child processes with the
//! user's Codex sign-in or the model provider from their `config.toml`. Runs
//! reuse `claude::RunSpec` and map Codex's JSONL events onto `claude::Event`,
//! so `agent.rs` drives both the same way.
//!
//! Tested against Codex CLI 0.155.1. The parser ignores event types and
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

use crate::claude::{Event, Exit, RunSpec, Session, Tools};
use crate::events;
use crate::AppState;

const STATUS_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CodexStatus {
    NotInstalled,
    LoggedOut,
    /// `account` = "ChatGPT", "an API key" or the configured model provider's name.
    Ready { account: String },
}

/// The parts of `~/.codex/config.toml` Kbot needs. Only top-level keys and
/// `[model_providers.<id>]` tables are read; everything else is left to Codex.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Config {
    pub model: Option<String>,
    pub model_provider: Option<String>,
    /// Display name of `model_provider` from its table, if it has one.
    pub provider_name: Option<String>,
    /// Environment variable holding the provider's API key.
    pub env_key: Option<String>,
}

impl Config {
    pub fn parse(text: &str) -> Config {
        let mut top = std::collections::HashMap::new();
        let mut providers: std::collections::HashMap<String, std::collections::HashMap<String, String>> =
            Default::default();
        let mut table: Option<String> = None;
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(name) = line.strip_prefix('[') {
                table = Some(name.trim_end_matches(']').trim().to_string());
                continue;
            }
            let Some((key, value)) = line.split_once('=') else { continue };
            let (key, value) = (key.trim().to_string(), toml_string(value.trim()));
            let Some(value) = value else { continue };
            match &table {
                None => {
                    top.insert(key, value);
                }
                Some(t) => {
                    if let Some(id) = t.strip_prefix("model_providers.") {
                        providers.entry(id.trim_matches('"').to_string()).or_default().insert(key, value);
                    }
                }
            }
        }
        let model_provider = top.remove("model_provider");
        let provider = model_provider.as_ref().and_then(|id| providers.get(id));
        Config {
            model: top.remove("model"),
            provider_name: provider.and_then(|p| p.get("name").cloned()),
            env_key: provider.and_then(|p| p.get("env_key").cloned()),
            model_provider,
        }
    }

    /// A provider other than OpenAI's, which needs no `codex login`.
    fn custom_provider(&self) -> Option<String> {
        let id = self.model_provider.as_ref().filter(|p| p.as_str() != "openai")?;
        Some(self.provider_name.clone().unwrap_or_else(|| id.clone()))
    }
}

/// A quoted TOML string value (`"a"` or `'a'`), minus any trailing comment.
fn toml_string(value: &str) -> Option<String> {
    let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let rest = &value[1..];
    let end = rest.find(quote)?;
    Some(rest[..end].to_string())
}

fn codex_home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME") {
        Some(dir) => Some(PathBuf::from(dir)),
        None => std::env::home_dir().map(|h| h.join(".codex")),
    }
}

pub fn config() -> Config {
    let text = codex_home().and_then(|dir| std::fs::read_to_string(dir.join("config.toml")).ok());
    text.map(|t| Config::parse(&t)).unwrap_or_default()
}

/// Located binary, the last sign-in check and environment a Finder launch
/// lacks (the custom provider's API key), shared by all runs.
#[derive(Default)]
pub struct Codex {
    status: Mutex<Option<(Instant, CodexStatus)>>,
    bin: Mutex<Option<PathBuf>>,
    env: Mutex<Vec<(String, String)>>,
}

impl Codex {
    pub fn binary(&self) -> Option<PathBuf> {
        self.bin.lock().unwrap().clone()
    }

    /// Forgets the cached sign-in check, e.g. after a run failed.
    pub fn invalidate(&self) {
        *self.status.lock().unwrap() = None;
    }
}

/// Where to look for `codex`; see `claude::find_binary`.
fn find_binary(configured: Option<String>) -> Option<PathBuf> {
    let is_file = |p: &PathBuf| p.is_file();
    // Lets e2e tests substitute a fake CLI.
    if let Some(p) = std::env::var_os("KBOT_CODEX_BIN").map(PathBuf::from).filter(is_file) {
        return Some(p);
    }
    if let Some(p) = configured.map(PathBuf::from).filter(is_file) {
        return Some(p);
    }
    let exe = if cfg!(windows) { "codex.exe" } else { "codex" };
    let mut candidates = Vec::new();
    if let Some(home) = std::env::home_dir() {
        candidates.push(home.join(".local/bin").join(exe));
    }
    candidates.extend(["/opt/homebrew/bin/codex", "/usr/local/bin/codex"].map(PathBuf::from));
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(exe)));
    }
    if let Some(p) = candidates.into_iter().find(is_file) {
        return Some(p);
    }
    login_shell(r#"command -v codex"#).map(PathBuf::from).filter(is_file)
}

/// Output of `script` in the user's login shell, which has the PATH and
/// variables set in their shell profile.
#[cfg(unix)]
fn login_shell(script: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = std::process::Command::new(shell)
        .args(["-lc", script])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(not(unix))]
fn login_shell(_script: &str) -> Option<String> {
    None
}

/// The provider's API key variable from the login shell, when the app didn't
/// inherit it (opened from Finder).
fn missing_env(config: &Config) -> Vec<(String, String)> {
    let Some(key) = &config.env_key else { return Vec::new() };
    let valid = !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid || std::env::var_os(key).is_some() {
        return Vec::new();
    }
    login_shell(&format!("printf %s \"${key}\"")).map(|v| vec![(key.clone(), v)]).unwrap_or_default()
}

fn command(bin: &Path, env: &[(String, String)]) -> Command {
    let mut cmd = Command::new(bin);
    // An npm install runs on the Node next to it, which a Finder launch has no PATH entry for.
    if let Some(dir) = bin.parent() {
        let mut paths = vec![dir.to_path_buf()];
        paths.extend(std::env::var_os("PATH").iter().flat_map(std::env::split_paths));
        if let Ok(path) = std::env::join_paths(paths) {
            cmd.env("PATH", path);
        }
    }
    cmd.envs(env.iter().map(|(k, v)| (k, v)));
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    cmd
}

/// Reads `codex login status` (exit 0 = signed in, e.g. "Logged in using ChatGPT").
fn parse_login(success: bool, output: &str, config: &Config) -> CodexStatus {
    if success {
        let account = if output.contains("ChatGPT") { "ChatGPT" } else { "an API key" };
        return CodexStatus::Ready { account: account.into() };
    }
    match config.custom_provider() {
        Some(account) => CodexStatus::Ready { account },
        None => CodexStatus::LoggedOut,
    }
}

/// The current sign-in status, cached for 10 minutes unless `refresh`.
/// Emits `kbot://codex` when it changes.
pub async fn status(app: &AppHandle, refresh: bool) -> CodexStatus {
    let state = app.state::<AppState>();
    if !refresh
        && let Some((at, status)) = state.codex.status.lock().unwrap().clone()
        && at.elapsed() < STATUS_TTL
    {
        return status;
    }
    let configured = state.store.lock().unwrap().app_setting("codex_path");
    let found = tauri::async_runtime::spawn_blocking(move || {
        let config = config();
        let env = missing_env(&config);
        (find_binary(configured), config, env)
    })
    .await;
    let (bin, config, env) = found.unwrap_or_default();
    let status = match &bin {
        None => CodexStatus::NotInstalled,
        Some(bin) => {
            let mut cmd = command(bin, &env);
            cmd.args(["login", "status"]);
            match tokio::time::timeout(Duration::from_secs(20), cmd.output()).await {
                Ok(Ok(out)) => {
                    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
                    parse_login(out.status.success(), &text, &config)
                }
                Ok(Err(e)) => {
                    eprintln!("codex login status failed: {e}");
                    CodexStatus::NotInstalled
                }
                Err(_) => {
                    eprintln!("codex login status timed out");
                    CodexStatus::LoggedOut
                }
            }
        }
    };
    *state.codex.bin.lock().unwrap() = bin;
    *state.codex.env.lock().unwrap() = env;
    let previous = state.codex.status.lock().unwrap().replace((Instant::now(), status.clone()));
    if previous.map(|(_, s)| s) != Some(status.clone()) {
        events::codex_status(app, &status);
    }
    status
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    pub id: String,
    pub description: String,
}

/// Models offered in Kbot > Settings…: `configured` is the model from
/// `config.toml` (what Codex uses when Kbot names none).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexModels {
    pub configured: Option<String>,
    pub models: Vec<CodexModel>,
}

/// Listed models from Codex's `models_cache.json`, in Codex's order.
pub fn parse_models_cache(json: &str) -> Vec<CodexModel> {
    let Ok(v) = serde_json::from_str::<Value>(json) else { return Vec::new() };
    let mut models: Vec<(i64, CodexModel)> = v
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|m| m.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|m| {
            let text = |key: &str| m.get(key).and_then(Value::as_str).map(String::from);
            let priority = m.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX);
            Some((priority, CodexModel { id: text("slug")?, description: text("description").unwrap_or_default() }))
        })
        .collect();
    models.sort_by_key(|(priority, _)| *priority);
    models.into_iter().map(|(_, m)| m).collect()
}

pub fn models() -> CodexModels {
    let cache = codex_home().and_then(|dir| std::fs::read_to_string(dir.join("models_cache.json")).ok());
    CodexModels { configured: config().model, models: cache.map(|c| parse_models_cache(&c)).unwrap_or_default() }
}

/// `codex exec` arguments for `spec`; the prompt goes to stdin (`-`).
/// `schema_file` holds `spec.json_schema`.
pub fn args(spec: &RunSpec, schema_file: Option<&Path>) -> Vec<String> {
    let mut args: Vec<String> = ["exec", "--json", "--skip-git-repo-check"].map(String::from).to_vec();
    let mut config = |key: &str, value: String| args.extend(["-c".into(), format!("{key}={value}")]);
    // Every command runs without asking, like Claude Code's bypassPermissions.
    // Onboarding helpers that only answer in JSON get a read-only sandbox.
    config("approval_policy", "\"never\"".into());
    config("developer_instructions", Value::String(spec.system_prompt.clone()).to_string());
    // Only the model and provider come from the user's config: no MCP
    // servers, plugins, hooks or notifications, so bots behave the same on
    // either provider.
    config("mcp_servers", "{}".into());
    config("plugins", "{}".into());
    config("notify", "[]".into());
    let web = matches!(&spec.tools, Tools::AllExcept(except) if !except.contains(&"WebSearch"));
    config("web_search", if web { "\"live\"" } else { "\"disabled\"" }.into());
    if let Some(effort) = spec.effort {
        config("model_reasoning_effort", format!("\"{}\"", effort.as_str()));
    }
    let sandbox = if spec.tools == Tools::None { "read-only" } else { "danger-full-access" };
    args.extend(["-s".into(), sandbox.into()]);
    for feature in ["plugins", "apps", "hooks", "skill_search", "tool_suggest", "browser_use", "computer_use"] {
        args.extend(["--disable".into(), feature.into()]);
    }
    if let Some(model) = &spec.model {
        args.extend(["-m".into(), model.clone()]);
    }
    if let Some(file) = schema_file {
        args.extend(["--output-schema".into(), file.display().to_string()]);
    }
    match &spec.session {
        // Codex picks the thread id; `Event::Init` reports it.
        Session::New(_) => {}
        Session::Resume(id) => args.extend(["resume".into(), id.clone()]),
        Session::Ephemeral => args.push("--ephemeral".into()),
    }
    args.push("-".into());
    args
}

/// The command a `command_execution` item runs, without the `zsh -lc '…'` wrapper.
fn shell_command(item: &Value) -> String {
    let raw = match item.get("command") {
        Some(Value::Array(parts)) => parts.last().and_then(Value::as_str).unwrap_or_default().to_string(),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    let Some((_, script)) = raw.split_once(" -lc ").or_else(|| raw.split_once(" -c ")) else { return raw };
    let script = script.trim();
    match script.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
        Some(inner) => inner.replace(r"'\''", "'"),
        None => script.trim_matches('"').to_string(),
    }
}

/// Parses one `codex exec --json` line into `claude::Event`s.
/// Unknown lines yield nothing.
pub fn parse_line(line: &str) -> Vec<Event> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let str_at = |v: &Value, ptr: &str| v.pointer(ptr).and_then(Value::as_str).map(String::from);
    let item = v.get("item").cloned().unwrap_or(Value::Null);
    let item_type = str_at(&item, "/type").unwrap_or_default();
    match (v.get("type").and_then(Value::as_str).unwrap_or_default(), item_type.as_str()) {
        ("thread.started", _) => vec![Event::Init {
            session_id: str_at(&v, "/thread_id").unwrap_or_default(),
            // Codex has no subscription check; see `claude::not_subscription_error`.
            api_key_source: "none".into(),
        }],
        ("item.started", "command_execution") => {
            vec![Event::ToolUse { name: "Bash".into(), input: json!({"command": shell_command(&item)}) }]
        }
        ("item.started", "web_search") => {
            vec![Event::ToolUse { name: "WebSearch".into(), input: json!({"query": str_at(&item, "/query")}) }]
        }
        ("item.completed", "file_change") => item
            .get("changes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|c| str_at(c, "/path"))
            .map(|path| Event::ToolUse { name: "Edit".into(), input: json!({"file_path": path}) })
            .collect(),
        ("item.completed", "agent_message") => {
            str_at(&item, "/text").filter(|t| !t.trim().is_empty()).map(Event::Text).into_iter().collect()
        }
        ("turn.completed", _) => vec![Event::Result { is_error: false, text: None, errors: Vec::new(), structured: None }],
        ("turn.failed", _) => vec![Event::Result {
            is_error: true,
            text: str_at(&v, "/error/message"),
            errors: Vec::new(),
            structured: None,
        }],
        _ => Vec::new(),
    }
}

/// What `agent.rs` checks for a lost Claude session; Codex says it on stderr.
pub const SESSION_MISSING: &str = "No conversation found";

/// Runs `codex exec` with `spec`, calling `on_event` for every parsed event.
/// Returning `false` from `on_event` kills the process. Notifying `cancel`
/// kills it too.
pub async fn run(
    app: &AppHandle,
    bin: &Path,
    spec: &RunSpec,
    cancel: Arc<Notify>,
    mut on_event: impl FnMut(Event) -> bool,
) -> Result<Exit, String> {
    std::fs::create_dir_all(&spec.cwd).map_err(|e| format!("can't create {}: {e}", spec.cwd.display()))?;
    let schema_file = match &spec.json_schema {
        Some(schema) => {
            let file = std::env::temp_dir().join(format!("kbot-schema-{}.json", uuid::Uuid::new_v4()));
            std::fs::write(&file, schema.to_string()).map_err(|e| format!("can't write the answer schema: {e}"))?;
            Some(file)
        }
        None => None,
    };
    let env = app.state::<AppState>().codex.env.lock().unwrap().clone();
    let result = run_process(bin, &env, spec, schema_file.as_deref(), cancel, &mut on_event).await;
    if let Some(file) = schema_file {
        let _ = std::fs::remove_file(file);
    }
    result
}

async fn run_process(
    bin: &Path,
    env: &[(String, String)],
    spec: &RunSpec,
    schema_file: Option<&Path>,
    cancel: Arc<Notify>,
    on_event: &mut impl FnMut(Event) -> bool,
) -> Result<Exit, String> {
    let mut cmd = command(bin, env);
    cmd.args(args(spec, schema_file)).current_dir(&spec.cwd).stdin(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("can't start Codex: {e}"))?;

    // Codex reads the prompt until stdin closes.
    let mut stdin = child.stdin.take().expect("piped stdin");
    stdin.write_all(spec.prompt.as_bytes()).await.map_err(|e| format!("can't send the prompt: {e}"))?;
    drop(stdin);

    let mut stderr = child.stderr.take().expect("piped stderr");
    let stderr = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text).await;
        text
    });
    let mut got_result = false;
    let mut lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    let events = parse_line(&line);
                    got_result |= events.iter().any(|e| matches!(e, Event::Result { .. }));
                    if !events.into_iter().all(&mut *on_event) {
                        let _ = child.kill().await;
                        return Ok(Exit::Stopped);
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    eprintln!("reading codex output failed: {e}");
                    break;
                }
            },
            _ = cancel.notified() => {
                let _ = child.kill().await;
                return Ok(Exit::Stopped);
            }
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = stderr.await.unwrap_or_default();
    // `resume` of a thread whose history is gone fails before any output.
    if !got_result && stderr.contains("no rollout found") {
        on_event(Event::Result {
            is_error: true,
            text: None,
            errors: vec![format!("{SESSION_MISSING}: {}", stderr.trim())],
            structured: None,
        });
    }
    Ok(Exit::Finished { success: status.success(), stderr })
}

/// One-off structured call (`--output-schema`) in a read-only sandbox with
/// no saved session. Returns the final answer parsed as JSON.
pub async fn ask_json(app: &AppHandle, bin: &Path, spec: RunSpec, cancel: Arc<Notify>) -> Result<Value, String> {
    let spec = RunSpec { session: Session::Ephemeral, tools: Tools::None, ..spec };
    let mut answer = None;
    let mut error = None;
    let exit = run(app, bin, &spec, cancel, |event| {
        match event {
            Event::Text(text) => answer = Some(text),
            Event::Result { is_error: true, text, errors, .. } => {
                error = Some(text.unwrap_or_else(|| errors.join("; ")));
            }
            _ => {}
        }
        true
    })
    .await?;
    if let Some(text) = answer {
        return serde_json::from_str(&text).map_err(|e| format!("Codex's answer wasn't valid JSON: {e}"));
    }
    Err(error.unwrap_or_else(|| match exit {
        Exit::Stopped => "stopped".into(),
        Exit::Finished { stderr, .. } => format!("Codex returned no answer. {}", stderr.trim()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Effort;

    fn spec() -> RunSpec {
        RunSpec {
            prompt: "hi".into(),
            system_prompt: "You are \"Bot\".\nBe brief.".into(),
            session: Session::New("ignored".into()),
            tools: Tools::AllExcept(vec!["WebSearch", "WebFetch"]),
            add_dirs: Vec::new(),
            model: Some("gpt-5.2-codex".into()),
            effort: Some(Effort::High),
            json_schema: None,
            cwd: PathBuf::from("/tmp"),
        }
    }

    #[test]
    fn reads_model_and_provider_from_config() {
        let text = r#"
model = "Qwen3.8-27B-MLX-4bit" # local
model_provider = "omlx"
approval_policy = 'on-request'

[model_providers.omlx]
name = "oMLX"
base_url = "http://127.0.0.1:8001/v1"
env_key = "OMLX_API_KEY"

[projects."/Users/me"]
model = "not-top-level"
"#;
        let config = Config::parse(text);
        assert_eq!(config.model.as_deref(), Some("Qwen3.8-27B-MLX-4bit"));
        assert_eq!(config.model_provider.as_deref(), Some("omlx"));
        assert_eq!(config.env_key.as_deref(), Some("OMLX_API_KEY"));
        assert_eq!(config.custom_provider().as_deref(), Some("oMLX"));
        assert_eq!(Config::parse("model_provider = \"openai\"").custom_provider(), None);
        assert_eq!(Config::parse("").custom_provider(), None);
    }

    #[test]
    fn login_states() {
        let none = Config::default();
        assert_eq!(parse_login(true, "Logged in using ChatGPT", &none), CodexStatus::Ready { account: "ChatGPT".into() });
        assert_eq!(parse_login(true, "Logged in using an API key - sk-…", &none), CodexStatus::Ready {
            account: "an API key".into()
        });
        assert_eq!(parse_login(false, "Not logged in", &none), CodexStatus::LoggedOut);
        let local = Config { model_provider: Some("omlx".into()), ..Config::default() };
        assert_eq!(parse_login(false, "Not logged in", &local), CodexStatus::Ready { account: "omlx".into() });
        let json = serde_json::to_value(CodexStatus::Ready { account: "oMLX".into() }).unwrap();
        assert_eq!(json, json!({"state": "ready", "account": "oMLX"}));
    }

    #[test]
    fn lists_cached_models_in_order() {
        let cache = r#"{"models":[
            {"slug":"b","description":"Second","visibility":"list","priority":2},
            {"slug":"hidden","visibility":"hide","priority":0},
            {"slug":"a","description":"First","visibility":"list","priority":1}]}"#;
        let ids: Vec<_> = parse_models_cache(cache).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, ["a", "b"]);
        assert!(parse_models_cache("nope").is_empty());
    }

    #[test]
    fn args_isolate_codex_and_resume() {
        let mut spec = spec();
        let first = args(&spec, None);
        let joined = first.join("|");
        assert!(joined.starts_with("exec|--json|--skip-git-repo-check|"));
        assert!(joined.contains(r#"|-c|developer_instructions="You are \"Bot\".\nBe brief."|"#));
        assert!(joined.contains(r#"|-c|approval_policy="never"|"#));
        assert!(joined.contains("|-c|mcp_servers={}|-c|plugins={}|-c|notify=[]|"));
        assert!(joined.contains(r#"|-c|web_search="disabled"|"#));
        assert!(joined.contains(r#"|-c|model_reasoning_effort="high"|"#));
        assert!(joined.contains("|-s|danger-full-access|"));
        assert!(joined.contains("|--disable|hooks|"));
        assert!(joined.contains("|-m|gpt-5.2-codex|"));
        assert!(!joined.contains("resume") && !joined.contains("ignored"));
        assert_eq!(first.last().map(String::as_str), Some("-"));
        assert!(!joined.contains("hi|"), "prompt goes to stdin");

        spec.tools = Tools::AllExcept(Vec::new());
        spec.session = Session::Resume("t1".into());
        spec.model = None;
        spec.effort = None;
        let joined = args(&spec, None).join("|");
        assert!(joined.contains(r#"web_search="live""#));
        assert!(joined.ends_with("|resume|t1|-"));
        assert!(!joined.contains("-m|") && !joined.contains("model_reasoning_effort"));

        spec.tools = Tools::None;
        spec.session = Session::Ephemeral;
        let joined = args(&spec, Some(Path::new("/tmp/s.json"))).join("|");
        assert!(joined.contains("|-s|read-only|"));
        assert!(joined.ends_with("|--output-schema|/tmp/s.json|--ephemeral|-"));
    }

    /// Output of a real `codex exec --json` run on a local model that reads a file.
    #[test]
    fn parses_real_stream() {
        let lines = [
            r#"{"type":"thread.started","thread_id":"019a-thread"}"#,
            r#"{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `Qwen3.8-27B-MLX-4bit` not found."}}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"Reading the note."}}"#,
            r#"{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc 'cat note.txt'","aggregated_output":"","exit_code":null,"status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc 'cat note.txt'","aggregated_output":"hello\n","exit_code":0,"status":"completed"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":""}}"#,
            r#"{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"The note says hello."}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#,
        ];
        let events: Vec<Event> = lines.iter().flat_map(|l| parse_line(l)).collect();
        assert_eq!(events, [
            Event::Init { session_id: "019a-thread".into(), api_key_source: "none".into() },
            Event::ToolUse { name: "Bash".into(), input: json!({"command": "cat note.txt"}) },
            Event::Text("The note says hello.".into()),
            Event::Result { is_error: false, text: None, errors: Vec::new(), structured: None },
        ]);
    }

    #[test]
    fn parses_failures_files_and_quotes() {
        let retry = r#"{"type":"error","message":"Reconnecting... 1/5 (stream disconnected)"}"#;
        assert!(parse_line(retry).is_empty());
        let failed = r#"{"type":"turn.failed","error":{"message":"You've hit your usage limit."}}"#;
        assert_eq!(parse_line(failed), [Event::Result {
            is_error: true,
            text: Some("You've hit your usage limit.".into()),
            errors: Vec::new(),
            structured: None
        }]);
        let edit = r#"{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"/a/b.md","kind":"add"}],"status":"completed"}}"#;
        assert_eq!(parse_line(edit), [Event::ToolUse { name: "Edit".into(), input: json!({"file_path": "/a/b.md"}) }]);
        let quoted = json!({"command": r"/bin/zsh -lc 'echo '\''hi'\'''"});
        assert_eq!(shell_command(&quoted), "echo 'hi'");
        assert_eq!(shell_command(&json!({"command": ["bash", "-lc", "ls"]})), "ls");
        assert!(parse_line("Reading prompt from stdin...").is_empty());
    }
}
