mod agent;
mod commands;
mod events;
mod migrate;
mod models;
mod store;

use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    pub store: Mutex<store::Store>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // WebDriver server on TAURI_WEBDRIVER_PORT, used by the e2e tests in `e2e/`.
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            // Lets e2e tests run against a throwaway database.
            #[cfg(feature = "e2e")]
            let dir = std::env::var_os("KBOT_DATA_DIR").map(std::path::PathBuf::from).unwrap_or(dir);
            let store = store::Store::open(dir)?;
            app.manage(AppState { store: Mutex::new(store) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_bots,
            commands::get_messages,
            commands::create_bot,
            commands::send_message,
            commands::set_computer_control,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
