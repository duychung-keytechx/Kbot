//! Runs daily jobs while the app is open. Checks every 30 seconds; a job
//! whose time passed while the app was closed is not run late.

use std::time::Duration;

use chrono::{DateTime, Local, NaiveTime, TimeZone};
use tauri::{AppHandle, Manager};

use crate::agent::{self, Trigger};
use crate::models::{Schedule, SetupState, Weekday};
use crate::AppState;

const TICK: Duration = Duration::from_secs(30);

pub fn start(app: AppHandle) {
    let started_at = Local::now().timestamp_millis();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        loop {
            tick.tick().await;
            run_due(&app, started_at);
        }
    });
}

fn run_due(app: &AppHandle, started_at: i64) {
    let state = app.state::<AppState>();
    let now = Local::now();
    let bots = state.store.lock().unwrap().bots();
    for bot in bots {
        let Some(schedule) = &bot.config.schedule else { continue };
        if bot.setup_state == SetupState::Pending || !is_due(schedule, now, bot.last_run_at, started_at) {
            continue;
        }
        // Busy (e.g. the user is chatting): try again on the next tick.
        let Some(ticket) = state.runs.start(app, &bot.id) else { continue };
        // Marked before the run starts, so a slow run isn't started twice.
        if let Err(e) = state.store.lock().unwrap().set_last_run_at(&bot.id, now.timestamp_millis()) {
            eprintln!("saving last run of {} failed: {e}", bot.id);
            continue;
        }
        agent::spawn(app.clone(), ticket, Trigger::DailyJob { manual: false });
    }
}

/// When `schedule` runs on `now`'s date, if it runs that day.
fn slot<Tz: TimeZone>(schedule: &Schedule, now: &DateTime<Tz>, days_ahead: i64) -> Option<DateTime<Tz>> {
    let time = NaiveTime::parse_from_str(&schedule.time, "%H:%M").ok()?;
    let date = now.date_naive() + chrono::Duration::days(days_ahead);
    if !schedule.days.contains(&Weekday::from(chrono::Datelike::weekday(&date))) {
        return None;
    }
    // `earliest` picks a time that a DST change makes ambiguous; a skipped time has none.
    now.timezone().from_local_datetime(&date.and_time(time)).earliest()
}

/// Whether today's run is due: its time has come, and it hasn't run since
/// then nor was its time before the app started (no catching up).
pub fn is_due<Tz: TimeZone>(schedule: &Schedule, now: DateTime<Tz>, last_run_at: Option<i64>, started_at: i64) -> bool {
    let Some(slot) = slot(schedule, &now, 0) else { return false };
    let slot = slot.timestamp_millis();
    slot <= now.timestamp_millis() && slot > last_run_at.unwrap_or(i64::MIN).max(started_at)
}

/// The next time `schedule` runs after `now`.
pub fn next_run<Tz: TimeZone>(schedule: &Schedule, now: DateTime<Tz>) -> Option<DateTime<Tz>> {
    (0..=7).filter_map(|d| slot(schedule, &now, d)).find(|slot| *slot > now)
}

/// "today at 08:00", "tomorrow at 08:00" or "Mon at 08:00".
pub fn describe_next_run<Tz: TimeZone>(next: DateTime<Tz>, now: DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let day = match (next.date_naive() - now.date_naive()).num_days() {
        0 => "today".to_string(),
        1 => "tomorrow".to_string(),
        _ => next.format("%a").to_string(),
    };
    format!("{day} at {}", next.format("%H:%M"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn at(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).unwrap()
    }

    fn ms(s: &str) -> i64 {
        at(s).timestamp_millis()
    }

    fn eight_am() -> Schedule {
        Schedule::default()
    }

    // 2026-10-26 is a Monday.
    const STARTED: &str = "2026-10-26T07:00:00+07:00";

    #[test]
    fn due_once_after_its_time() {
        let s = eight_am();
        let started = ms(STARTED);
        assert!(!is_due(&s, at("2026-10-26T07:59:30+07:00"), None, started));
        assert!(is_due(&s, at("2026-10-26T08:00:10+07:00"), None, started));
        // Already ran today.
        let ran = Some(ms("2026-10-26T08:00:10+07:00"));
        assert!(!is_due(&s, at("2026-10-26T08:00:40+07:00"), ran, started));
        // Next day it's due again.
        assert!(is_due(&s, at("2026-10-27T08:00:05+07:00"), ran, started));
    }

    #[test]
    fn missed_runs_are_not_caught_up() {
        let s = eight_am();
        // App opened at 09:00, after today's 08:00 slot.
        assert!(!is_due(&s, at("2026-10-26T09:00:30+07:00"), None, ms("2026-10-26T09:00:00+07:00")));
        // Last ran yesterday; still not caught up.
        let yesterday = Some(ms("2026-10-25T08:00:00+07:00"));
        assert!(!is_due(&s, at("2026-10-26T09:00:30+07:00"), yesterday, ms("2026-10-26T09:00:00+07:00")));
    }

    #[test]
    fn a_manual_run_before_the_slot_doesnt_cancel_it() {
        let ran_now = Some(ms("2026-10-26T07:30:00+07:00"));
        assert!(is_due(&eight_am(), at("2026-10-26T08:00:20+07:00"), ran_now, ms(STARTED)));
    }

    #[test]
    fn only_on_selected_days() {
        let s = Schedule { days: vec![Weekday::Tue], ..eight_am() };
        assert!(!is_due(&s, at("2026-10-26T08:00:10+07:00"), None, ms(STARTED)));
        assert!(is_due(&s, at("2026-10-27T08:00:10+07:00"), None, ms(STARTED)));
    }

    #[test]
    fn crossing_midnight() {
        let s = Schedule { time: "23:59".into(), ..eight_am() };
        let started = ms("2026-10-26T23:00:00+07:00");
        assert!(is_due(&s, at("2026-10-26T23:59:30+07:00"), None, started));
        // Just after midnight the next day's slot hasn't come yet.
        let ran = Some(ms("2026-10-26T23:59:30+07:00"));
        assert!(!is_due(&s, at("2026-10-27T00:00:10+07:00"), ran, started));
    }

    #[test]
    fn next_run_and_its_label() {
        let s = Schedule { days: vec![Weekday::Mon, Weekday::Fri], ..eight_am() };
        let now = at("2026-10-26T07:00:00+07:00");
        let next = next_run(&s, now).unwrap();
        assert_eq!(next, at("2026-10-26T08:00:00+07:00"));
        assert_eq!(describe_next_run(next, now), "today at 08:00");

        let now = at("2026-10-26T09:00:00+07:00");
        let next = next_run(&s, now).unwrap();
        assert_eq!(next, at("2026-10-30T08:00:00+07:00"));
        assert_eq!(describe_next_run(next, now), "Fri at 08:00");

        let now = at("2026-10-29T09:00:00+07:00");
        assert_eq!(describe_next_run(next_run(&s, now).unwrap(), now), "tomorrow at 08:00");
        assert_eq!(next_run(&Schedule { days: vec![], ..eight_am() }, now), None);
    }
}
