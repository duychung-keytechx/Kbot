# Plan: Agent setup qua chat + chạy agent bằng Claude CLI

Status: draft · 2026-10-26

## Mục tiêu

1. Bot mới tạo chỉ có tên, icon, màu. Lần đầu mở chat, agent tự nhận ra mình
   chưa được setup và bắt đầu hỏi user để cấu hình:
   - Loại agent: **Chat** (hỏi gì trả lời nấy) hay **Daily job** (tự chạy một
     việc vào giờ cố định mỗi ngày, ví dụ morning brief).
   - Description, dùng làm instruction cho agent.
   - Các câu hỏi thêm tùy loại agent.
   - Workspace folder mà agent được phép đọc (native app nên làm được).
2. Agent chạy bằng **Claude CLI** (`claude -p`) với Claude subscription của
   user, không dùng API key. App bắt buộc user phải login Claude subscription
   thì mới dùng được.
3. Daily job chỉ chạy khi app đang mở. App tắt thì job không chạy, và không
   chạy bù.

## Quyết định chính

| Vấn đề | Quyết định |
| --- | --- |
| Biết agent đã setup chưa | Lưu hẳn `setup_state` trong DB (`pending` / `done` / `skipped`), không suy từ số message. |
| Lưu config | **Toàn bộ setting của agent nằm trong SQLite** (`kbot.db`), không có file config riêng hay localStorage. Gồm: setup state/bước, `AgentConfig` (cột JSON `config`, giống cách `messages.body` đang làm, nên thêm field sau này không cần migration), session Claude, `last_run_at`. Setting chung của app (vd. `claude_path`) nằm trong bảng `app_settings`. Thư mục `agents/<bot_id>/` chỉ là cwd trống cho CLI, không chứa setting. |
| "Loại agent" | Agent nào cũng chat được. Daily job = chat agent có `schedule`. Hỏi user "Chat / Daily job" nhưng lưu thành `schedule: Option<Schedule>`. Nhờ vậy user có thể hỏi lại agent về bản brief vừa nhận. |
| Onboarding | Hybrid. Các bước cố định (loại, giờ chạy, folder) là **card có nút/picker**, không parse text. Claude chỉ dùng cho (a) hỏi 0–3 câu làm rõ dựa trên description, (b) viết lại description thành instruction. |
| Gọi Claude | Spawn `claude -p --output-format stream-json`, đọc stdout từng dòng, đẩy lên UI qua event `kbot://message` sẵn có. |
| Bảo đảm dùng subscription | Kiểm tra `claude auth status --json`: `authMethod == "claude.ai"` và có `subscriptionType`. Xóa mọi biến môi trường API key khỏi process con. Mỗi lần chạy kiểm lại `apiKeySource == "none"` trong event `init`. |
| Quyền truy cập file | Chỉ đọc (`Read`, `Glob`, `Grep`), giới hạn trong các folder user chọn bằng `--add-dir`. Ở chế độ `-p`, tool nào không được allow sẽ bị từ chối, nên Rust/CLI chặn được chứ không chỉ dựa vào prompt. |
| Scheduler | Một tokio task trong app, tick mỗi 30s. Không chạy bù giờ đã lỡ lúc app tắt. |

## Đã kiểm tra trên máy (Claude Code 2.1.310)

- `claude auth status --json` trả về `loggedIn`, `authMethod` (`"claude.ai"`),
  `apiProvider`, `subscriptionType` (vd. `"team"`), `orgName`...
- `claude -p ... --output-format stream-json --verbose` emit lần lượt:
  - `{"type":"system","subtype":"init","apiKeySource":"none","model":...,"session_id":...,"tools":[...]}`
  - `{"type":"assistant","message":{"content":[{"type":"text","text":...}]}}`
  - `{"type":"rate_limit_event",...}`
  - `{"type":"result",...}`
- `--bare` **không dùng được**: chế độ này chỉ nhận `ANTHROPIC_API_KEY`, bỏ qua OAuth/subscription.
- Chạy được với `--setting-sources "" --strict-mcp-config --tools "" --system-prompt ...`.

## Phase 0: Spike (nửa ngày, làm trước)

Kiểm chứng mấy điểm chưa chắc trước khi code thật:

1. `--setting-sources ""` có chặn `~/.claude/CLAUDE.md` và hooks của user không,
   hay vẫn bị lẫn vào agent? Nếu vẫn lẫn, thử `CLAUDE_CONFIG_DIR` riêng (nhưng
   cách này có thể mất login; cần test).
2. `--resume <id>` kèm một `--system-prompt` **mới** có dùng prompt mới không
   (cần cho lúc user sửa instruction).
3. Ở `-p`, `Read` một file ngoài cwd/`--add-dir` có bị từ chối không.
4. App mở từ Finder không thừa hưởng PATH của shell: kiểm tra thứ tự tìm binary
   `claude` (xem Phase 1).
5. `claude auth login` có chạy được khi không có TTY không (mở browser OAuth).
   Nếu không, UI sẽ hướng dẫn user chạy lệnh này trong Terminal.
6. Shape output của `--json-schema` trong event `result` (dùng cho bước sinh
   câu hỏi và instruction).
7. Đọc lại điều khoản của Anthropic về việc app bên thứ ba gọi Claude Code
   bằng subscription của user, trước khi phát hành Kbot cho người khác.

## Phase 1: Claude CLI runtime

File mới `src-tauri/src/claude.rs`; `agent.rs` gọi vào đây thay cho phần stub.

**Tìm binary**, theo thứ tự:
1. `claude_path` trong bảng `app_settings` (user tự set, để dành sau).
2. `~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`.
3. `$SHELL -lc 'command -v claude'` (lấy PATH của login shell).
4. Biến môi trường `KBOT_CLAUDE_BIN` (cho e2e, trỏ tới một script giả lập).

**Auth gate**: `claude_status() -> ClaudeStatus`

```rust
pub enum ClaudeStatus {
    NotInstalled,
    LoggedOut,
    NotSubscription { auth_method: String }, // API key, Bedrock, Vertex...
    Ready { subscription: String, email: Option<String> },
}
```

- Chạy khi app start và khi user bấm "Check again". Cache 10 phút, và kiểm lại
  ngay khi một lần chạy bị lỗi auth.
- `Ready` chỉ khi `loggedIn && authMethod == "claude.ai" && apiProvider == "firstParty" && subscriptionType` khác rỗng.
- UI: nếu không `Ready` thì hiện màn hình **Connect Claude** (thay cho chat), có
  hướng dẫn theo từng trạng thái: link cài Claude Code / lệnh
  `claude auth login` / giải thích vì sao không nhận API key. Có nút **Check again**.

**Chạy một lượt**: `run(bot, prompt, mode) -> stream`

```
claude -p <prompt>
  --output-format stream-json --verbose --include-partial-messages
  --system-prompt <system prompt dựng từ config>
  --session-id <uuid> | --resume <claude_session_id>
  --tools <danh sách>        --allowedTools <như trên>
  --add-dir <folder>...      (workspace folders)
  --setting-sources "" --strict-mcp-config
  [--model <config.model>]
```

- `cwd` = `<app_data>/agents/<bot_id>/` (thư mục trống riêng của từng bot), để
  session không lẫn vào project của user.
- Env của process con: xóa `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
  `CLAUDE_CODE_USE_FOUNDRY`.
- Tools: không có folder và không bật web thì `--tools ""`. Có folder thì thêm
  `Read Glob Grep`. Bật web thì thêm `WebSearch WebFetch`. **Không** có
  Bash/Edit/Write ở v1.
- Parse stream:
  - `init`: lưu `session_id` vào DB; nếu `apiKeySource != "none"` thì kill process
    và báo lỗi "not using subscription".
  - Text delta: upsert **cùng một** `MessageBody::Agent` theo message id (cách đã
    ghi trong `agent.rs`).
  - `tool_use`: hiện một dòng system nhỏ, vd. "Reading notes.md…".
  - `rate_limit_event` / `result.is_error`: tin system kiểu "Claude usage limit
    reached, resets at …".
- Mỗi bot chỉ chạy một lượt một lúc. Có `cancel_run(bot_id)` để kill process
  con. Event `kbot://run { botId, running }` để UI hiện typing indicator và
  nút Stop.
- System prompt dựng từ: tên bot, `instructions`, danh sách workspace folders,
  ngày giờ và timezone hiện tại, và "trả lời bằng ngôn ngữ user dùng".

Cargo: `tokio` thêm features `process`, `io-util`, `macros`, `sync`.

## Phase 2: Data model

Migration `src-tauri/migrations/0002_agent_config.sql`:

```sql
ALTER TABLE bots ADD COLUMN setup_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (setup_state IN ('pending', 'done', 'skipped'));
ALTER TABLE bots ADD COLUMN setup_step TEXT;           -- bước onboarding hiện tại
ALTER TABLE bots ADD COLUMN config TEXT NOT NULL DEFAULT '{}';  -- AgentConfig JSON
ALTER TABLE bots ADD COLUMN claude_session_id TEXT;
ALTER TABLE bots ADD COLUMN last_run_at INTEGER;       -- lần chạy daily job gần nhất (ms)

-- Setting chung của app (key/value), vd. 'claude_path'.
CREATE TABLE app_settings (
    key    TEXT PRIMARY KEY NOT NULL,
    value  TEXT NOT NULL
);
```

Mọi thay đổi setting (từ onboarding, panel Settings, hoặc scheduler cập nhật
`last_run_at`) đều đi qua `Store` và ghi ngay xuống DB. UI không giữ bản riêng,
chỉ đọc lại từ `list_bots` / event `kbot://bots`.

Bot cũ cũng thành `pending`, nên mở ra sẽ được onboarding. Điều này là đúng,
vì bot cũ cũng chưa có config.

`models.rs`:

```rust
pub struct AgentConfig {
    pub description: String,        // câu user gõ
    pub instructions: String,       // bản Claude viết lại, user sửa được
    pub schedule: Option<Schedule>, // None = chat agent
    pub workspace_folders: Vec<String>,
    pub web_access: bool,
    pub model: Option<String>,
}

pub struct Schedule {
    pub time: String,          // "08:00", giờ local
    pub days: Vec<Weekday>,    // mặc định cả 7 ngày
    pub task: String,          // việc cần làm mỗi lần chạy
    pub notify: bool,          // bắn notification của OS khi xong
}
```

`Bot` thêm `setup_state` và `config`. Nhớ cập nhật mirror trong `src/lib/types.ts`.

## Phase 3: Onboarding flow

State machine trong `src-tauri/src/setup.rs`. Bước hiện tại lưu ở `setup_step`,
nên tắt app giữa chừng thì lần sau mở tiếp đúng chỗ.

| Bước | Agent nói / hiện | User trả lời bằng |
| --- | --- | --- |
| `kind` | "Hi, I'm {name}! What should I do for you?" | Card 2 nút: **Chat with me** / **Run a daily job** |
| `description` | "Describe what I should do." (gợi ý ví dụ theo loại) | Gõ text |
| `schedule` (daily) | "When should I run each day?" | Card: time picker + chọn ngày (mặc định mỗi ngày) + toggle notification |
| `web` | "Should I be able to search the web?" (mặc định Yes cho daily job) | Card Yes / No |
| `workspace` | "Any folders I should look into?" | Card: **Add folder** (native picker) / **Skip** |
| `clarify` | Claude sinh 0–3 câu hỏi làm rõ từ description (`--json-schema`), hỏi lần lượt | Gõ text |
| `review` | Claude viết `instructions` (và `schedule.task` nếu có); hiện card tóm tắt toàn bộ config | **Looks good** / **Edit** (sửa instruction tại chỗ) |
| done | System message "Setup complete", kèm "Next run: tomorrow 08:00" nếu là daily job | |

- Trigger: `ChatView` gọi `ensure_setup(bot_id)` khi mount. Lệnh này idempotent:
  nếu `pending` và chưa có `setup_step` thì push lời chào + card `kind`.
- Khi đang `pending`, `send_message` chuyển text sang `setup::answer` thay vì
  gọi agent.
- Lúc nào cũng có link **Skip setup** (state `skipped`, agent chạy với
  instruction trống) và có thể chạy lại setup từ Settings.
- Hai bước dùng Claude (`clarify`, `review`) chạy `--tools ""
  --no-session-persistence` và không đụng vào session chat của bot.
- Lời thoại onboarding cố định bằng tiếng Anh cho khớp UI hiện tại. Những phần
  do Claude sinh thì theo ngôn ngữ của user.

Message type mới (`MessageBody`, giữ nguyên pattern JSON body):

```rust
SetupChoice   { step: String, question: String, options: Vec<String>, selected: Option<String> },
SetupSchedule { time: Option<String>, days: Vec<Weekday>, notify: bool, submitted: bool },
SetupFolders  { folders: Vec<String>, submitted: bool },
SetupReview   { config: AgentConfig, confirmed: bool },
```

Card đã submit thì khóa lại (giống `ComputerCard` đổi state). Commands:
`ensure_setup`, `answer_setup(bot_id, message_id, answer)`, `skip_setup`.

Folder picker: thêm `tauri-plugin-dialog` (Rust) và `@tauri-apps/plugin-dialog`
(JS), cấp permission `dialog:allow-open` trong `capabilities/default.json`.

## Phase 4: Scheduler

`src-tauri/src/scheduler.rs`, khởi động trong `setup()` của `lib.rs`:

- Ghi lại `app_started_at`. Tick mỗi 30s. Với mỗi bot `done` có `schedule`:
  `due = hôm nay là ngày đã chọn && scheduled_time <= now && scheduled_time > max(last_run_at, app_started_at)`.
  Điều kiện `> app_started_at` bảo đảm **không chạy bù** giờ đã lỡ khi app tắt.
- Chạy: push system message "Daily job · 08:00", gọi `claude::run` với prompt
  `schedule.task` + ngày hôm nay, chạy **trong session chat của bot** để user hỏi
  tiếp được. Xong thì set `last_run_at`. Nếu `notify` thì bắn notification
  (`tauri-plugin-notification`).
- Bot đang bận (user đang chat) thì đợi tick sau.
- Máy sleep qua giờ chạy: lúc thức dậy, tick sẽ thấy job đã due và chạy ngay
  (app vẫn mở nên chấp nhận được). Muốn đổi thì thêm giới hạn "trễ quá 1 tiếng
  thì bỏ".
- Dùng giờ local (`chrono::Local`). Đổi timezone thì theo giờ local mới.

## Phase 5: Agent settings

Bấm vào header của chat để mở panel Settings: sửa description/instructions,
schedule (bật/tắt, giờ, ngày), folders, web access, model; có nút **Run now**
cho daily job và **Redo setup**. Command: `update_bot_config(bot_id, config)`.
Sidebar hiện icon đồng hồ nhỏ cho bot có schedule.

## Phase 6: Mock backend và tests

- `src/lib/mockBackend.ts`: giả lập onboarding và trả lời giả, để
  `npm run dev` vẫn chạy được không cần Rust.
- Rust unit tests: chuyển bước của state machine, hàm tính `due` (gồm trường hợp
  không chạy bù và đổi ngày), parser stream-json (dùng fixture từ output thật),
  migration 0002 trên DB đã có bot cũ.
- e2e: `KBOT_CLAUDE_BIN` trỏ tới `e2e/fake-claude.ts`, script này in ra
  stream-json mẫu và output mẫu của `auth status`. Test: tạo bot → đi hết
  onboarding → chat; và trạng thái "chưa login" hiện màn Connect Claude.

## Thứ tự làm và commit

1. Phase 0 spike, ghi kết quả vào cuối file này.
2. Phase 1 + màn Connect Claude: thay stub, chat thật với Claude.
3. Phase 2 + 3: onboarding.
4. Phase 4: scheduler.
5. Phase 5: settings.
6. Phase 6 làm song song từ phase 2 trở đi. Cập nhật README (bỏ dòng "agent is
   a stub", thêm yêu cầu Claude subscription và Claude Code).

## Rủi ro

- **Điều khoản sử dụng subscription**: Kbot gọi CLI chính thức chứ không lấy
  OAuth token, nhưng nếu phân phối app cho người khác thì vẫn cần đọc lại
  điều khoản (spike mục 7).
- **CLI thay đổi format** stream-json hoặc flag giữa các version: parser phải
  chịu được field lạ; ghi version tối thiểu đã test; hiện lỗi rõ ràng khi parse
  thất bại.
- **Giới hạn usage của subscription**: daily job có thể trúng rate limit. Phải
  báo trong chat, không fail im lặng.
- **Khởi động chậm**: mỗi lượt spawn một process (~1–2s). Chấp nhận được cho v1.
  Nếu cần nhanh hơn, có thể giữ process sống với `--input-format stream-json`.
- **Session dài**: chat và daily job dùng chung session nên sẽ phình to. CLI tự
  compact, nhưng cần theo dõi.

## Kết quả spike Phase 0

Test với Claude Code 2.1.310 trên macOS, tài khoản Max.

1. **Cô lập cấu hình user**: `--setting-sources "" --strict-mcp-config` chặn
   được CLAUDE.md, hooks, settings và MCP server của user. Bot chỉ thấy system
   prompt của Kbot.
2. **`--resume` bỏ qua `--system-prompt` mới**: session cũ giữ system prompt
   lúc tạo. Vì vậy mỗi khi config đổi (`update_bot_config`, xong onboarding,
   redo setup) thì reset `claude_session_id`, và giờ hiện tại được đưa vào từng
   prompt thay vì system prompt.
3. **Permission mode**: theo yêu cầu, chạy `--permission-mode auto` (hằng số
   `PERMISSION_MODE` trong `claude.rs`). Bộ tool vẫn bị giới hạn bằng `--tools`
   (chỉ Read/Glob/Grep khi có folder, WebSearch/WebFetch khi bật web), không có
   Bash/Edit/Write. Đánh đổi: ở chế độ auto, Read **có thể đọc file ngoài
   `--add-dir`**; với `dontAsk` (hoặc không có `--allowedTools`) thì bị từ
   chối. Muốn khóa chặt folder thì đổi hằng số đó sang `dontAsk`.
4. **Tìm binary**: thứ tự `KBOT_CLAUDE_BIN` (thêm so với plan, cần cho e2e) →
   `app_settings.claude_path` → các thư mục cài đặt quen thuộc
   (`~/.local/bin`, `~/.claude/local`, Homebrew, ...) → `PATH` → login shell
   (`$SHELL -lc 'command -v claude'`), vì app mở từ Finder không có PATH của
   terminal.
5. **`claude auth login` không có TTY**: chưa test. UI hướng dẫn user chạy lệnh
   trong Terminal, rồi bấm "Check again" (app cũng tự kiểm tra lại khi cửa sổ
   được focus).
6. **Structured output**: `--json-schema` trả kết quả trong field
   `structured_output` của event `result` (`result` là chuỗi JSON). Dùng cho
   câu hỏi làm rõ và việc viết instructions.
7. **Điều khoản sử dụng subscription**: chưa xem lại, để anh quyết định trước
   khi phân phối app.

Ghi chú khác:

- `auth status --json` cho biết `authMethod` (`claude.ai` = subscription) và
  `subscriptionType`; đăng nhập bằng API key thì hiện màn "notSubscription".
- Stream-json: dùng `stream_event` / `content_block_delta` để stream chữ, và
  `assistant` / `result` để chốt nội dung. Parser bỏ qua event lạ (fixture ở
  `src-tauri/src/fixtures/`).
- Scheduler ghi `last_run_at` **trước** khi chạy, nên một job lỗi hoặc bị dừng
  sẽ không chạy lại trong cùng ngày.
