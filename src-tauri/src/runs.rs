//! Which bots are busy. A bot runs one thing at a time (a reply, a daily job
//! or an onboarding step that asks Claude); `kbot://run` tells the UI so it
//! can show a typing indicator and a Stop button.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use crate::events;
use crate::AppState;

#[derive(Default)]
pub struct Runs {
    active: Mutex<HashMap<String, Arc<Notify>>>,
}

/// Held for the duration of a run; dropping it marks the bot idle again.
pub struct Ticket {
    app: AppHandle,
    pub bot_id: String,
    /// Notified by `cancel_run`.
    pub cancel: Arc<Notify>,
}

impl Runs {
    /// Marks `bot_id` busy, or returns `None` if it already is.
    pub fn start(&self, app: &AppHandle, bot_id: &str) -> Option<Ticket> {
        let cancel = Arc::new(Notify::new());
        {
            let mut active = self.active.lock().unwrap();
            if active.contains_key(bot_id) {
                return None;
            }
            active.insert(bot_id.to_string(), cancel.clone());
        }
        events::run(app, bot_id, true);
        Some(Ticket { app: app.clone(), bot_id: bot_id.to_string(), cancel })
    }

    pub fn cancel(&self, bot_id: &str) -> bool {
        match self.active.lock().unwrap().get(bot_id) {
            Some(cancel) => {
                // Stores a permit, so a run that isn't waiting yet still sees it.
                cancel.notify_one();
                true
            }
            None => false,
        }
    }

    pub fn running(&self) -> Vec<String> {
        self.active.lock().unwrap().keys().cloned().collect()
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        self.app.state::<AppState>().runs.active.lock().unwrap().remove(&self.bot_id);
        events::run(&self.app, &self.bot_id, false);
    }
}
