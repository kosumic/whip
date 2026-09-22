//! Device-local wall-time usage, independent of React and host count.
//!
//! Only observed time is credited: process death, suspension and clock jumps
//! cannot turn an old `working` status into hours of invented usage.

use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::{
    HerdrAgentStatus, HostConnectionState, HostFreshness, HostRuntimeEvent, HostSyncStatus,
};

const TICK: Duration = Duration::from_secs(1);
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(15);
const MAX_OBSERVATION_GAP: Duration = Duration::from_secs(5);
const CLOCK_TOLERANCE_MS: u64 = 1_000;
const STORE_VERSION: u32 = 1;
const MAX_CHART_BUCKETS: usize = 512;

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum UsageError {
    #[error("Usage storage: {0}")]
    Storage(String),
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct UsageSummary {
    pub today_ms: u64,
    pub week_ms: u64,
    pub month_ms: u64,
    pub lifetime_ms: u64,
    pub started_at_ms: Option<u64>,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct UsageChart {
    pub buckets_ms: Vec<u64>,
    pub total_ms: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Span {
    start: u64,
    end: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    lifetime_ms: u64,
    spans: Vec<Span>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            version: STORE_VERSION,
            lifetime_ms: 0,
            spans: Vec::new(),
        }
    }
}

impl Ledger {
    fn record(&mut self, start: u64, end: u64) {
        // Keep spans ordered and disjoint even if the device clock moves back.
        let start = self.spans.last().map_or(start, |span| start.max(span.end));
        if end <= start {
            return;
        }
        self.lifetime_ms = self.lifetime_ms.saturating_add(end - start);
        if let Some(last) = self.spans.last_mut()
            && last.end == start
        {
            last.end = end;
        } else {
            self.spans.push(Span { start, end });
        }
    }

    fn since(&self, start: u64, now: u64) -> u64 {
        self.spans
            .iter()
            .map(|span| span.end.min(now).saturating_sub(span.start.max(start)))
            .sum()
    }

    fn chart(&self, boundaries: &[u64], now: u64) -> Result<UsageChart, UsageError> {
        if boundaries.len() < 2
            || boundaries.len() > MAX_CHART_BUCKETS + 1
            || boundaries.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(UsageError::Storage("Invalid chart boundaries".into()));
        }
        let buckets_ms: Vec<_> = boundaries
            .windows(2)
            .map(|pair| self.since(pair[0], pair[1].min(now)))
            .collect();
        let total_ms = buckets_ms.iter().sum();
        Ok(UsageChart {
            buckets_ms,
            total_ms,
        })
    }

    fn load(path: &PathBuf) -> Result<Self, UsageError> {
        let contents = match fs::read(path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => return Err(UsageError::Storage(error.to_string())),
        };
        let ledger: Self = serde_json::from_slice(&contents)
            .map_err(|error| UsageError::Storage(error.to_string()))?;
        let valid = ledger.version == STORE_VERSION
            && ledger.spans.iter().all(|span| span.start < span.end)
            && ledger
                .spans
                .windows(2)
                .all(|pair| pair[0].end <= pair[1].start)
            && ledger
                .spans
                .iter()
                .try_fold(0_u64, |total, span| {
                    total.checked_add(span.end - span.start)
                })
                .is_some_and(|total| total <= ledger.lifetime_ms);
        if !valid {
            return Err(UsageError::Storage("Invalid usage history".into()));
        }
        Ok(ledger)
    }
}

struct Tracker {
    ledger: Ledger,
    path: PathBuf,
    last_tick: Instant,
    last_wall: u64,
    last_checkpoint: Instant,
    dirty: bool,
    storage_error: Option<String>,
}

impl Tracker {
    fn new(path: PathBuf, ledger: Ledger) -> Self {
        Self {
            path,
            ledger,
            last_tick: Instant::now(),
            last_wall: wall_ms(),
            last_checkpoint: Instant::now(),
            dirty: false,
            storage_error: None,
        }
    }

    fn tick(&mut self, active: bool, now: Instant, wall: u64) {
        let elapsed = now.saturating_duration_since(self.last_tick);
        let wall_elapsed = wall.saturating_sub(self.last_wall);
        if active
            && wall >= self.last_wall
            && elapsed <= MAX_OBSERVATION_GAP
            && wall_elapsed.abs_diff(millis(elapsed)) <= CLOCK_TOLERANCE_MS
        {
            self.ledger.record(self.last_wall, wall);
            self.dirty |= wall_elapsed > 0;
        }
        self.last_tick = now;
        self.last_wall = wall;
    }

    fn checkpoint(&mut self) {
        if !self.dirty {
            return;
        }
        let result = (|| -> Result<(), String> {
            let bytes = serde_json::to_vec(&self.ledger).map_err(|error| error.to_string())?;
            let temporary = self.path.with_extension("tmp");
            fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
            fs::rename(temporary, &self.path).map_err(|error| error.to_string())
        })();
        self.storage_error = result.err();
        self.dirty = self.storage_error.is_some();
        self.last_checkpoint = Instant::now();
    }
}

#[derive(Default)]
struct UsageState {
    foreground: bool,
    working_hosts: HashSet<String>,
    tracker: Option<Tracker>,
}

impl UsageState {
    fn tick(&mut self) {
        let active = self.foreground || !self.working_hosts.is_empty();
        if let Some(tracker) = &mut self.tracker {
            tracker.tick(active, Instant::now(), wall_ms());
        }
    }

    fn checkpoint(&mut self) {
        if let Some(tracker) = &mut self.tracker {
            tracker.checkpoint();
        }
    }
}

fn state() -> &'static Mutex<UsageState> {
    static STATE: OnceLock<Mutex<UsageState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(UsageState::default()))
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn wall_ms() -> u64 {
    millis(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default(),
    )
}

/// Idempotent across React remounts; never restores an open interval from disk.
#[uniffi::export]
pub fn initialize_usage_tracking(path: String) -> Result<(), UsageError> {
    let mut state = state().lock();
    if state.tracker.is_some() {
        return Ok(());
    }
    let path = PathBuf::from(path);
    let ledger = Ledger::load(&path)?;
    let runtime = crate::runtime().map_err(UsageError::Storage)?;
    state.tracker = Some(Tracker::new(path, ledger));
    drop(state);
    runtime.spawn(async {
        loop {
            tokio::time::sleep(TICK).await;
            let mut state = self::state().lock();
            state.tick();
            if let Some(tracker) = &mut state.tracker
                && tracker.last_checkpoint.elapsed() >= CHECKPOINT_INTERVAL
            {
                tracker.checkpoint();
            }
        }
    });
    Ok(())
}

#[uniffi::export]
pub fn set_usage_foreground(foreground: bool) {
    let mut state = state().lock();
    state.tick();
    if state.foreground != foreground {
        state.foreground = foreground;
        state.checkpoint();
    }
}

/// Platform calendar boundaries include the device timezone and DST rules.
#[uniffi::export]
pub fn usage_summary(
    today_start_ms: u64,
    week_start_ms: u64,
    month_start_ms: u64,
) -> Result<UsageSummary, UsageError> {
    let mut state = state().lock();
    state.tick();
    let tracker = state
        .tracker
        .as_ref()
        .ok_or_else(|| UsageError::Storage("Tracking has not started".into()))?;
    if let Some(error) = &tracker.storage_error {
        return Err(UsageError::Storage(error.clone()));
    }
    let now = tracker.last_wall;
    let summary = UsageSummary {
        today_ms: tracker.ledger.since(today_start_ms, now),
        week_ms: tracker.ledger.since(week_start_ms, now),
        month_ms: tracker.ledger.since(month_start_ms, now),
        lifetime_ms: tracker.ledger.lifetime_ms,
        started_at_ms: tracker.ledger.spans.first().map(|span| span.start),
    };
    drop(state);
    Ok(summary)
}

/// Rust clips the union of observed spans into platform-local calendar buckets.
#[uniffi::export]
pub fn usage_chart(boundaries_ms: Vec<u64>) -> Result<UsageChart, UsageError> {
    let mut state = state().lock();
    state.tick();
    let tracker = state
        .tracker
        .as_ref()
        .ok_or_else(|| UsageError::Storage("Tracking has not started".into()))?;
    if let Some(error) = &tracker.storage_error {
        return Err(UsageError::Storage(error.clone()));
    }
    let chart = tracker.ledger.chart(&boundaries_ms, tracker.last_wall);
    drop(state);
    chart
}

fn runtime_activity(event: &HostRuntimeEvent) -> Option<(&str, bool)> {
    match event {
        HostRuntimeEvent::HostStateChanged {
            runtime_id, state, ..
        } => Some((
            runtime_id,
            state.freshness == HostFreshness::Fresh
                && state.sync_status == HostSyncStatus::Synced
                && state.snapshot.as_ref().is_some_and(|snapshot| {
                    snapshot
                        .agents
                        .iter()
                        .any(|agent| agent.agent_status == HerdrAgentStatus::Working)
                }),
        )),
        HostRuntimeEvent::ConnectionStateChanged { runtime_id, status }
            if status.state != HostConnectionState::Connected =>
        {
            Some((runtime_id, false))
        }
        _ => None,
    }
}

pub(crate) fn observe_runtime_event(event: &HostRuntimeEvent) {
    let Some((id, working)) = runtime_activity(event) else {
        return;
    };
    let mut state = state().lock();
    let was_working = state.working_hosts.contains(id);
    if was_working == working {
        return;
    }
    state.tick();
    if working {
        state.working_hosts.insert(id.to_owned());
    } else {
        state.working_hosts.remove(id);
    }
    state.checkpoint();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker() -> Tracker {
        Tracker::new(PathBuf::new(), Ledger::default())
    }

    fn advance(tracker: &mut Tracker, active: bool, milliseconds: u64) {
        tracker.tick(
            active,
            tracker.last_tick + Duration::from_millis(milliseconds),
            tracker.last_wall + milliseconds,
        );
    }

    #[test]
    fn foreground_and_background_work_form_one_union() {
        let mut state = UsageState {
            tracker: Some(tracker()),
            ..UsageState::default()
        };
        let advance_state = |state: &mut UsageState| {
            let active = state.foreground || !state.working_hosts.is_empty();
            advance(state.tracker.as_mut().unwrap(), active, 1_000);
        };
        advance_state(&mut state); // background idle
        state.foreground = true;
        advance_state(&mut state); // foreground without agents
        state.working_hosts.insert("one".into());
        state.working_hosts.insert("two".into());
        advance_state(&mut state); // foreground and two agents: count once
        state.foreground = false;
        advance_state(&mut state);
        state.working_hosts.remove("one");
        advance_state(&mut state); // second host still working
        state.working_hosts.clear();
        advance_state(&mut state);
        let tracker = state.tracker.unwrap();
        assert_eq!(tracker.ledger.lifetime_ms, 4_000);
        assert_eq!(tracker.ledger.spans.len(), 1);
    }

    #[test]
    fn calendar_boundaries_clip_an_ongoing_span() {
        let mut ledger = Ledger::default();
        ledger.record(100, 300);
        ledger.record(400, 600);
        assert_eq!(ledger.since(250, 550), 200);
        assert_eq!(ledger.since(600, 700), 0);
        assert_eq!(ledger.since(0, 700), 400);
    }

    #[test]
    fn suspension_and_clock_changes_do_not_inflate_usage() {
        let mut tracker = tracker();
        advance(&mut tracker, true, 1_000);
        advance(&mut tracker, true, 3_600_000); // suspended
        tracker.tick(
            true,
            tracker.last_tick + TICK,
            tracker.last_wall + 3_600_000,
        ); // clock forward
        tracker.tick(
            true,
            tracker.last_tick + TICK,
            tracker.last_wall - 7_200_000,
        ); // clock back
        assert_eq!(tracker.ledger.lifetime_ms, 1_000);
    }

    #[test]
    fn overlapping_clock_ranges_are_not_counted_twice() {
        let mut ledger = Ledger::default();
        ledger.record(100, 300);
        ledger.record(200, 250);
        ledger.record(200, 400);
        assert_eq!(ledger.lifetime_ms, 300);
        assert_eq!(ledger.spans.len(), 1);
    }

    #[test]
    fn chart_splits_spans_and_excludes_future_time() {
        let mut ledger = Ledger::default();
        ledger.record(100, 500);
        ledger.record(600, 800);
        let chart = ledger.chart(&[0, 200, 400, 600, 800, 1_000], 750).unwrap();
        assert_eq!(ledger.lifetime_ms, 600);
        assert_eq!(chart.buckets_ms, vec![100, 200, 100, 150, 0]);
        assert_eq!(chart.total_ms, 550);
    }

    #[test]
    fn lifetime_chart_retains_history_older_than_forty_days() {
        const DAY: u64 = 24 * 60 * 60 * 1_000;
        let mut ledger = Ledger::default();
        ledger.record(DAY, 2 * DAY);
        ledger.record(100 * DAY, 101 * DAY);
        let chart = ledger
            .chart(&[0, 30 * DAY, 60 * DAY, 90 * DAY, 120 * DAY], 120 * DAY)
            .unwrap();
        assert_eq!(chart.buckets_ms, vec![DAY, 0, 0, DAY]);
        assert_eq!(chart.total_ms, ledger.lifetime_ms);
    }

    #[test]
    fn chart_rejects_empty_reversed_duplicate_and_excessive_boundaries() {
        let ledger = Ledger::default();
        for boundaries in [
            vec![],
            vec![0],
            vec![1, 0],
            vec![0, 0],
            vec![0; MAX_CHART_BUCKETS + 2],
        ] {
            assert!(ledger.chart(&boundaries, 1_000).is_err());
        }
    }

    #[test]
    fn checkpoint_survives_restart_without_reopening_an_interval() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.json");
        let mut first = Tracker::new(path.clone(), Ledger::load(&path).unwrap());
        advance(&mut first, true, 1_000);
        first.checkpoint();
        let mut second = Tracker::new(path.clone(), Ledger::load(&path).unwrap());
        assert_eq!(second.ledger.lifetime_ms, 1_000);
        advance(&mut second, false, 1_000);
        assert_eq!(second.ledger.lifetime_ms, 1_000);
        assert!(first.storage_error.is_none());
    }

    #[test]
    fn invalid_history_is_preserved_instead_of_reset() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("usage.json");
        for contents in [
            "not json",
            r#"{"version":2,"lifetime_ms":0,"spans":[]}"#,
            r#"{"version":1,"lifetime_ms":5,"spans":[{"start":20,"end":10}]}"#,
        ] {
            fs::write(&path, contents).unwrap();
            assert!(Ledger::load(&path).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        }
    }

    #[test]
    fn failed_checkpoint_keeps_dirty_history_for_retry() {
        let directory = tempfile::tempdir().unwrap();
        let parent = directory.path().join("missing");
        let mut tracker = Tracker::new(parent.join("usage.json"), Ledger::default());
        advance(&mut tracker, true, 1_000);
        tracker.checkpoint();
        assert!(tracker.dirty);
        assert!(tracker.storage_error.is_some());
        fs::create_dir(&parent).unwrap();
        tracker.checkpoint();
        assert!(!tracker.dirty);
        assert!(tracker.storage_error.is_none());
        assert_eq!(Ledger::load(&tracker.path).unwrap().lifetime_ms, 1_000);
    }
}

#[cfg(test)]
mod runtime_tests {
    use super::*;
    use crate::{HerdrAgentInfo, HerdrSessionSnapshot, HostRuntimeStatus, host_state::HostState};

    fn host_event(status: HerdrAgentStatus, freshness: HostFreshness) -> HostRuntimeEvent {
        let agent = HerdrAgentInfo {
            pane_id: "pane".into(),
            terminal_id: "terminal".into(),
            workspace_id: "workspace".into(),
            tab_id: "tab".into(),
            focused: false,
            agent_status: status,
            revision: 1.0,
            cwd: None,
            foreground_cwd: None,
            agent: Some("codex".into()),
            name: None,
            title: None,
            terminal_title: None,
            terminal_title_stripped: None,
            display_agent: None,
            interactive_ready: None,
            launch_pending: None,
            screen_detection_skipped: None,
            state_change_seq: None,
            state_labels: None,
            tokens: None,
            agent_session: None,
        };
        let mut state = HostState::default().projection();
        state.freshness = freshness;
        state.sync_status = HostSyncStatus::Synced;
        state.snapshot = Some(HerdrSessionSnapshot {
            version: "test".into(),
            protocol: 20,
            focused_workspace_id: None,
            focused_tab_id: None,
            focused_pane_id: None,
            agents: vec![agent],
            workspaces: Vec::new(),
            tabs: Vec::new(),
            panes: Vec::new(),
            layouts: Vec::new(),
        });
        HostRuntimeEvent::HostStateChanged {
            runtime_id: "host".into(),
            state,
            agent_status_transitions: Vec::new(),
            transcript_retention: None,
        }
    }

    #[test]
    fn only_fresh_working_agents_qualify_for_background_time() {
        for status in [
            HerdrAgentStatus::Working,
            HerdrAgentStatus::Blocked,
            HerdrAgentStatus::Done,
            HerdrAgentStatus::Idle,
            HerdrAgentStatus::Unknown,
        ] {
            for freshness in [
                HostFreshness::Fresh,
                HostFreshness::Stale,
                HostFreshness::Loading,
                HostFreshness::Unavailable,
            ] {
                assert_eq!(
                    runtime_activity(&host_event(status, freshness)),
                    Some((
                        "host",
                        status == HerdrAgentStatus::Working && freshness == HostFreshness::Fresh
                    ))
                );
            }
        }
    }

    #[test]
    fn disconnect_and_reconnect_stop_background_time_until_fresh_state_arrives() {
        for connection in [
            HostConnectionState::Disconnected,
            HostConnectionState::Reconnecting,
            HostConnectionState::Connecting,
            HostConnectionState::Disconnecting,
            HostConnectionState::Failed,
            HostConnectionState::Connected,
        ] {
            let event = HostRuntimeEvent::ConnectionStateChanged {
                runtime_id: "host".into(),
                status: HostRuntimeStatus {
                    state: connection,
                    generation: 1,
                    reconnect_attempt: 0,
                    error: None,
                },
            };
            assert_eq!(
                runtime_activity(&event),
                if connection == HostConnectionState::Connected {
                    None
                } else {
                    Some(("host", false))
                }
            );
        }
    }
}
