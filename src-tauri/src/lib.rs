mod agent;
mod claude;
mod commands;
mod events;
mod migrate;
mod models;
mod runs;
mod scheduler;
mod setup;
mod store;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    pub store: Mutex<store::Store>,
    /// Where the database and the bots' working directories live.
    pub data_dir: PathBuf,
    pub runs: runs::Runs,
    pub claude: claude::Claude,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    // WebDriver server on TAURI_WEBDRIVER_PORT, used by the e2e tests in `e2e/`.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .setup(|app| {
            // Lets e2e tests run against a throwaway database. Honored in every
            // build, so the tests never open the real one even if they launch a
            // non-e2e binary; an e2e build refuses to start without it.
            let dir = match std::env::var_os("KBOT_DATA_DIR") {
                Some(dir) => PathBuf::from(dir),
                None if cfg!(feature = "e2e") => return Err("e2e builds need KBOT_DATA_DIR".into()),
                None => app.path().app_data_dir()?,
            };
            let store = store::Store::open(dir.clone())?;
            app.manage(AppState {
                store: Mutex::new(store),
                data_dir: dir,
                runs: runs::Runs::default(),
                claude: claude::Claude::default(),
            });
            scheduler::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_bots,
            commands::get_messages,
            commands::create_bot,
            commands::send_message,
            commands::set_computer_control,
            commands::claude_status,
            commands::running_bots,
            commands::cancel_run,
            commands::ensure_setup,
            commands::answer_setup,
            commands::skip_setup,
            commands::redo_setup,
            commands::clear_chat,
            commands::delete_bot,
            commands::update_bot_config,
            commands::run_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
