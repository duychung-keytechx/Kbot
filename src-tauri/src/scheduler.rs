//! Runs scheduled jobs while the app is open. Checks every 30 seconds; a job
//! whose time passed while the app was closed is not run late, except a
//! one-time task, which runs as soon as the app is open again.
//!
//! A daily job runs at its time. An interval job runs every `n` minutes
//! after its last run, counting from when the app started (or the interval
//! changed) if that is later, so opening the app doesn't run it at once.
//! A task on a date runs once at its date and time, or every month on that
//! day (the last day of shorter months) if it repeats monthly.

use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Datelike, Local, Months, NaiveTime, TimeZone};
use tauri::{AppHandle, Manager};

use crate::agent::{self, Trigger};
use crate::models::{Schedule, Weekday};
use crate::AppState;

const TICK: Duration = Duration::from_secs(30);

pub fn start(app: AppHandle) {
    let started_at = Local::now().timestamp_millis();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        let mut armed = Armed::new();
        loop {
            tick.tick().await;
            run_due(&app, started_at, &mut armed);
        }
    });
}

/// Interval jobs by bot id: their interval, and when it started counting.
type Armed = HashMap<String, (u32, i64)>;

fn run_due(app: &AppHandle, started_at: i64, armed: &mut Armed) {
    let state = app.state::<AppState>();
    let now = Local::now();
    let bots = state.store.lock().unwrap().scheduled_bots();
    armed.retain(|id, _| bots.iter().any(|b| &b.id == id && b.config.schedule.as_ref().is_some_and(|s| s.every_minutes.is_some())));
    for bot in bots {
        let Some(schedule) = &bot.config.schedule else { continue };
        let due = match schedule.every_minutes {
            Some(every) => {
                let now_ms = now.timestamp_millis();
                let (n, armed_at) = armed.entry(bot.id.clone()).or_insert((every, now_ms));
                if *n != every {
                    (*n, *armed_at) = (every, now_ms);
                }
                is_due_interval(schedule, now, bot.last_run_at, *armed_at)
            }
            None => is_due(schedule, now, bot.last_run_at, started_at),
        };
        if !due {
            continue;
        }
        // Busy (e.g. the user is chatting): try again on the next tick.
        let Some(ticket) = state.runs.start(app, &bot.id) else { continue };
        // Marked before the run starts, so a slow run isn't started twice.
        if let Err(e) = state.store.lock().unwrap().set_last_run_at(&bot.id, now.timestamp_millis()) {
            eprintln!("saving last run of {} failed: {e}", bot.id);
            continue;
        }
        let late = late_run(schedule, now).map(|due| describe_late(due, now));
        agent::spawn(app.clone(), ticket, Trigger::Job { manual: false, late });
    }
}

/// When a daily job runs on `now`'s date, if it runs that day.
fn slot<Tz: TimeZone>(schedule: &Schedule, now: &DateTime<Tz>, days_ahead: i64) -> Option<DateTime<Tz>> {
    let time = NaiveTime::parse_from_str(&schedule.time, "%H:%M").ok()?;
    let date = now.date_naive() + chrono::Duration::days(days_ahead);
    if !schedule.days.contains(&Weekday::from(date.weekday())) {
        return None;
    }
    // `earliest` picks a time that a DST change makes ambiguous; a skipped time has none.
    now.timezone().from_local_datetime(&date.and_time(time)).earliest()
}

/// A task on a date: its latest run up to `now`, and its next run after `now`.
fn dated_runs<Tz: TimeZone>(schedule: &Schedule, now: &DateTime<Tz>) -> (Option<DateTime<Tz>>, Option<DateTime<Tz>>) {
    let (Some(date), Ok(time)) = (schedule.parsed_date(), NaiveTime::parse_from_str(&schedule.time, "%H:%M")) else {
        return (None, None);
    };
    // Runs by months after `date`; around `now`, the month before to the month after.
    let months = match schedule.monthly {
        true => {
            let since = (now.year() - date.year()) * 12 + now.month() as i32 - date.month() as i32;
            (since - 1).max(0)..=(since + 1).max(0)
        }
        false => 0..=0,
    };
    let runs: Vec<DateTime<Tz>> = months
        .filter_map(|m| {
            let month = date.with_day(1)? + Months::new(m as u32);
            let last_day = (month + Months::new(1)).pred_opt()?.day();
            let day = month.with_day(date.day().min(last_day))?;
            now.timezone().from_local_datetime(&day.and_time(time)).earliest()
        })
        .collect();
    (runs.iter().rev().find(|run| *run <= now).cloned(), runs.into_iter().find(|run| run > now))
}

/// Whether a daily job or a task on a date is due: its latest run time has
/// come, and it hasn't run since then nor was that before the app started
/// (no catching up). A one-time task is caught up: it only runs once, so
/// skipping it would lose it.
pub fn is_due<Tz: TimeZone>(schedule: &Schedule, now: DateTime<Tz>, last_run_at: Option<i64>, started_at: i64) -> bool {
    if schedule.every_minutes.is_some() {
        return false;
    }
    let slot = match schedule.date {
        Some(_) => dated_runs(schedule, &now).0,
        None => slot(schedule, &now, 0).filter(|slot| *slot <= now),
    };
    let Some(slot) = slot else { return false };
    let since = match is_one_time(schedule) {
        true => last_run_at.unwrap_or(i64::MIN),
        false => last_run_at.unwrap_or(i64::MIN).max(started_at),
    };
    slot.timestamp_millis() > since
}

fn is_one_time(schedule: &Schedule) -> bool {
    schedule.date.is_some() && !schedule.monthly && schedule.every_minutes.is_none()
}

/// How late a one-time task may start, e.g. after waiting for a chat reply,
/// before its run says it's late.
const LATE_AFTER: chrono::Duration = chrono::Duration::minutes(5);

/// When a one-time task due at `now` was meant to run, if that was a while
/// ago (e.g. the app was closed then).
pub fn late_run<Tz: TimeZone>(schedule: &Schedule, now: DateTime<Tz>) -> Option<DateTime<Tz>> {
    if !is_one_time(schedule) {
        return None;
    }
    dated_runs(schedule, &now).0.filter(|due| now.clone() - due.clone() > LATE_AFTER)
}

/// "today at 09:30", "yesterday at 09:30" or "Fri, Oct 30 at 09:30".
pub fn describe_late<Tz: TimeZone>(due: DateTime<Tz>, now: DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let day = match (now.date_naive() - due.date_naive()).num_days() {
        0 => "today".to_string(),
        1 => "yesterday".to_string(),
        _ if due.year() != now.year() => due.format("%a, %b %-d, %Y").to_string(),
        _ => due.format("%a, %b %-d").to_string(),
    };
    format!("{day} at {}", due.format("%H:%M"))
}

/// Whether an interval job is due: today is one of its days, and its
/// interval has passed since the later of its last run and `armed_at`.
pub fn is_due_interval<Tz: TimeZone>(schedule: &Schedule, now: DateTime<Tz>, last_run_at: Option<i64>, armed_at: i64) -> bool {
    let Some(every) = schedule.every_minutes else { return false };
    let today = Weekday::from(chrono::Datelike::weekday(&now.date_naive()));
    let since = last_run_at.unwrap_or(i64::MIN).max(armed_at);
    schedule.days.contains(&today) && now.timestamp_millis() >= since + i64::from(every) * 60_000
}

/// The next time a daily job or a task on a date runs after `now`; `None`
/// for an interval job, or a one-time task whose time has passed.
pub fn next_run<Tz: TimeZone>(schedule: &Schedule, now: DateTime<Tz>) -> Option<DateTime<Tz>> {
    if schedule.every_minutes.is_some() {
        return None;
    }
    if schedule.date.is_some() {
        return dated_runs(schedule, &now).1;
    }
    (0..=7).filter_map(|d| slot(schedule, &now, d)).find(|slot| *slot > now)
}

/// A one-time task set to a time that has passed would never run. Checked
/// when its date or time is set, i.e. differs from `old`.
pub fn check_date<Tz: TimeZone>(schedule: &Schedule, old: Option<&Schedule>, now: DateTime<Tz>) -> Result<(), String> {
    let key = |s: &Schedule| (s.date.clone(), s.time.clone(), s.monthly);
    if schedule.date.is_none() || old.is_some_and(|old| key(old) == key(schedule)) || next_run(schedule, now).is_some() {
        return Ok(());
    }
    Err("Pick a date and time in the future".into())
}

/// "today at 08:00", "tomorrow at 08:00", "Mon at 08:00", "Nov 26 at 08:00"
/// or, in another year, "Jan 31, 2099 at 08:00".
pub fn describe_next_run<Tz: TimeZone>(next: DateTime<Tz>, now: DateTime<Tz>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let day = match (next.date_naive() - now.date_naive()).num_days() {
        0 => "today".to_string(),
        1 => "tomorrow".to_string(),
        2..=6 => next.format("%a").to_string(),
        _ if next.year() != now.year() => next.format("%b %-d, %Y").to_string(),
        _ => next.format("%b %-d").to_string(),
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
    fn interval_runs_after_each_interval() {
        let s = Schedule { every_minutes: Some(15), ..eight_am() };
        let armed = ms("2026-10-26T10:00:00+07:00");
        assert!(!is_due(&s, at("2026-10-26T10:20:00+07:00"), None, armed), "not a daily job");
        // Not at once when the app opens, even if it last ran long ago.
        let long_ago = Some(ms("2026-10-20T10:00:00+07:00"));
        assert!(!is_due_interval(&s, at("2026-10-26T10:00:30+07:00"), long_ago, armed));
        assert!(!is_due_interval(&s, at("2026-10-26T10:14:50+07:00"), long_ago, armed));
        assert!(is_due_interval(&s, at("2026-10-26T10:15:00+07:00"), long_ago, armed));
        // 15 minutes after the last run, scheduled or manual.
        let ran = Some(ms("2026-10-26T10:20:00+07:00"));
        assert!(!is_due_interval(&s, at("2026-10-26T10:30:00+07:00"), ran, armed));
        assert!(is_due_interval(&s, at("2026-10-26T10:35:10+07:00"), ran, armed));
    }

    #[test]
    fn interval_only_on_selected_days() {
        let s = Schedule { every_minutes: Some(30), days: vec![Weekday::Tue], ..eight_am() };
        let armed = ms(STARTED);
        assert!(!is_due_interval(&s, at("2026-10-26T12:00:00+07:00"), None, armed));
        assert!(is_due_interval(&s, at("2026-10-27T00:10:00+07:00"), None, armed));
        assert_eq!(next_run(&s, at(STARTED)), None);
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

    fn on(date: &str, monthly: bool) -> Schedule {
        Schedule { date: Some(date.into()), monthly, time: "09:30".into(), days: vec![], ..eight_am() }
    }

    #[test]
    fn a_task_on_a_date_runs_once() {
        let s = on("2026-11-03", false);
        let started = ms(STARTED);
        assert!(!is_due(&s, at("2026-11-02T09:30:00+07:00"), None, started), "not the day before");
        assert!(!is_due(&s, at("2026-11-03T09:29:50+07:00"), None, started));
        assert!(is_due(&s, at("2026-11-03T09:30:10+07:00"), None, started));
        let ran = Some(ms("2026-11-03T09:30:10+07:00"));
        assert!(!is_due(&s, at("2026-11-03T09:30:40+07:00"), ran, started));
        assert!(!is_due(&s, at("2026-12-03T09:30:10+07:00"), ran, started), "doesn't repeat");
        assert_eq!(late_run(&s, at("2026-11-03T09:30:10+07:00")), None, "on time");

        let now = at(STARTED);
        assert_eq!(next_run(&s, now), Some(at("2026-11-03T09:30:00+07:00")));
        assert_eq!(describe_next_run(next_run(&s, now).unwrap(), now), "Nov 3 at 09:30");
        assert_eq!(next_run(&s, at("2026-11-03T09:30:00+07:00")), None, "nothing after it ran");
    }

    #[test]
    fn a_monthly_task_repeats_on_its_day() {
        let s = on("2026-10-31", true);
        let started = ms(STARTED);
        assert!(!is_due(&s, at("2026-10-30T09:30:10+07:00"), None, started), "not before its first date");
        assert!(is_due(&s, at("2026-10-31T09:30:10+07:00"), None, started));
        let ran = Some(ms("2026-10-31T09:30:10+07:00"));
        assert!(!is_due(&s, at("2026-11-15T09:30:00+07:00"), ran, started));
        // November has 30 days: the last day instead of the 31st.
        assert_eq!(next_run(&s, at("2026-11-01T00:00:00+07:00")), Some(at("2026-11-30T09:30:00+07:00")));
        assert!(is_due(&s, at("2026-11-30T09:30:10+07:00"), ran, started));
        assert_eq!(next_run(&s, at("2026-11-30T10:00:00+07:00")), Some(at("2026-12-31T09:30:00+07:00")));
        let now = at("2027-02-01T10:00:00+07:00");
        assert_eq!(next_run(&s, now), Some(at("2027-02-28T09:30:00+07:00")));
        let nov = at("2026-11-01T00:00:00+07:00");
        assert_eq!(describe_next_run(next_run(&s, nov).unwrap(), nov), "Nov 30 at 09:30");
        assert_eq!(describe_next_run(at("2099-01-31T09:30:00+07:00"), now), "Jan 31, 2099 at 09:30");
        // Before its first date, the next run is the first date.
        assert_eq!(next_run(&s, at("2026-09-01T10:00:00+07:00")), Some(at("2026-10-31T09:30:00+07:00")));
    }

    #[test]
    fn a_missed_one_time_task_runs_when_the_app_opens() {
        let s = on("2026-11-03", false);
        // The app was closed at 09:30 and opened at 11:00.
        let opened = ms("2026-11-03T11:00:00+07:00");
        let now = at("2026-11-03T11:00:05+07:00");
        assert!(is_due(&s, now, None, opened));
        assert_eq!(late_run(&s, now), Some(at("2026-11-03T09:30:00+07:00")));
        assert_eq!(describe_late(late_run(&s, now).unwrap(), now), "today at 09:30");
        // Once only, even after the app restarts again.
        let ran = Some(ms("2026-11-03T11:00:05+07:00"));
        assert!(!is_due(&s, at("2026-11-05T08:00:00+07:00"), ran, ms("2026-11-05T07:59:00+07:00")));
        // A run made with "Run now" after it was due counts as its run.
        assert!(!is_due(&s, now, Some(ms("2026-11-03T10:00:00+07:00")), opened));

        let later = at("2026-11-04T08:00:00+07:00");
        assert_eq!(describe_late(late_run(&s, later).unwrap(), later), "yesterday at 09:30");
        let later = at("2026-11-20T08:00:00+07:00");
        assert_eq!(describe_late(late_run(&s, later).unwrap(), later), "Tue, Nov 3 at 09:30");
        let later = at("2027-01-02T08:00:00+07:00");
        assert_eq!(describe_late(late_run(&s, later).unwrap(), later), "Tue, Nov 3, 2026 at 09:30");

        // Monthly tasks are not caught up, like daily jobs.
        let monthly = on("2026-11-03", true);
        assert!(!is_due(&monthly, now, None, opened));
        assert_eq!(late_run(&monthly, now), None);
    }

    #[test]
    fn a_one_time_task_must_be_set_in_the_future() {
        let now = at(STARTED);
        assert!(check_date(&on("2026-10-26", false), None, now).is_ok(), "later today");
        let today = Schedule { time: "06:00".into(), ..on("2026-10-26", false) };
        assert_eq!(check_date(&today, None, now), Err("Pick a date and time in the future".into()));
        assert!(check_date(&today, Some(&today), now).is_ok(), "unchanged, e.g. after it ran");
        assert!(check_date(&Schedule { monthly: true, ..today.clone() }, None, now).is_ok(), "repeats next month");
        assert!(check_date(&eight_am(), None, at("2026-10-26T09:00:00+07:00")).is_ok());
    }
}
