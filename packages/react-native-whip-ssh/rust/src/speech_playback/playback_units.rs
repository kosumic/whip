//! Exclusive FIFO playback turns. An alert retains one turn across speech and
//! ringtone; platform callbacks explicitly finish or cancel their own turn.
use std::{collections::VecDeque, sync::LazyLock, time::Instant};

const IDLE_SPEECH_RECHECK_MS: u64 = 1_000;
const PCM_STALL_MS: u64 = 60_000;
static START: LazyLock<Instant> = LazyLock::new(Instant::now);

struct Progress {
    frames: u64,
    advanced_at: u64,
}

#[derive(Default)]
pub(super) struct PlaybackUnits {
    sequence: u64,
    active: Option<u64>,
    waiting: VecDeque<u64>,
    progress: Option<Progress>,
}

impl PlaybackUnits {
    pub(super) fn command(&mut self, action: &str, token: &str, frames: u64) -> String {
        let now = u64::try_from(START.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.command_at(action, token, frames, now)
    }

    fn stalled(&self, now: u64) -> bool {
        self.progress
            .as_ref()
            .is_some_and(|progress| now.saturating_sub(progress.advanced_at) >= PCM_STALL_MS)
    }

    fn command_at(&mut self, action: &str, token: &str, frames: u64, now: u64) -> String {
        match action {
            "id" => {
                let Some(next) = self.sequence.checked_add(1) else {
                    return "0".into();
                };
                self.sequence = next;
                next.to_string()
            }
            "active" => self.active.is_some().to_string(),
            // Long, advancing speech may exceed its contention budget. A PCM
            // player that stopped consuming frames must still time out alone.
            "timeout-delay-ms" => if self.waiting.is_empty() && !self.stalled(now) {
                IDLE_SPEECH_RECHECK_MS
            } else {
                0
            }
            .to_string(),
            "next" => {
                if self.active.is_some() {
                    return "null".into();
                }
                self.active = self.waiting.pop_front();
                self.active
                    .map_or_else(|| "null".into(), |id| id.to_string())
            }
            _ => {
                let Some(id) = token.parse::<u64>().ok().filter(|id| *id != 0) else {
                    return "false".into();
                };
                match action {
                    "owns" => (self.active == Some(id)).to_string(),
                    "start" => {
                        let admitted = self.active.is_none_or(|active| active == id);
                        if admitted {
                            self.active = Some(id);
                        }
                        admitted.to_string()
                    }
                    "watch-progress" => {
                        if self.active != Some(id) {
                            return "false".into();
                        }
                        self.progress = Some(Progress {
                            frames: 0,
                            advanced_at: now,
                        });
                        "true".into()
                    }
                    "unwatch-progress" => {
                        if self.active != Some(id) {
                            return "false".into();
                        }
                        self.progress = None;
                        "true".into()
                    }
                    "progress" => {
                        if self.active != Some(id) {
                            return "false".into();
                        }
                        // A delayed callback cannot revive speech after the
                        // silence deadline. Native teardown still owns cleanup.
                        if self.stalled(now) {
                            return "true".into();
                        }
                        if let Some(progress) = &mut self.progress
                            && frames > progress.frames
                        {
                            progress.frames = frames;
                            progress.advanced_at = now;
                        }
                        self.stalled(now).to_string()
                    }
                    "defer" => {
                        let defer = self.active != Some(id)
                            && (self.active.is_some() || !self.waiting.is_empty());
                        if defer && !self.waiting.contains(&id) {
                            self.waiting.push_back(id);
                        }
                        defer.to_string()
                    }
                    "cancel" => {
                        self.waiting.retain(|waiting| *waiting != id);
                        "null".into()
                    }
                    "finish" => {
                        let current = self.active == Some(id);
                        if current {
                            self.active = None;
                            self.progress = None;
                        }
                        current.to_string()
                    }
                    _ => "null".into(),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PCM_STALL_MS, PlaybackUnits};

    #[test]
    fn stalled_pcm_times_out_without_a_competing_request() {
        let mut units = PlaybackUnits::default();
        units.command_at("start", "1", 0, 0);
        units.command_at("watch-progress", "1", 0, 0);
        assert_eq!(units.command_at("progress", "1", 24_000, 1_000), "false");
        assert_eq!(
            units.command_at("progress", "1", 24_000, PCM_STALL_MS),
            "false"
        );
        assert_eq!(
            units.command_at("progress", "1", 24_000, PCM_STALL_MS + 1_000),
            "true"
        );
        assert_eq!(
            units.command_at("timeout-delay-ms", "", 0, PCM_STALL_MS + 1_000),
            "0"
        );
        // Do not report success or release the turn before native cancels audio
        // and settles its pending promises.
        assert_eq!(
            units.command_at("owns", "1", 0, PCM_STALL_MS + 1_000),
            "true"
        );
        assert_eq!(
            units.command_at("progress", "1", 48_000, 15 * 60_000),
            "true"
        );
    }

    #[test]
    fn advancing_pcm_can_read_for_fifteen_minutes() {
        let mut units = PlaybackUnits::default();
        units.command_at("start", "1", 0, 0);
        units.command_at("watch-progress", "1", 0, 0);
        for second in 1..=15 * 60 {
            assert_eq!(
                units.command_at("progress", "1", second * 24_000, second * 1_000),
                "false"
            );
            assert_eq!(
                units.command_at("timeout-delay-ms", "", 0, second * 1_000),
                "1000"
            );
        }
    }

    #[test]
    fn generated_audio_and_stale_callbacks_cannot_extend_the_stall_deadline() {
        let mut units = PlaybackUnits::default();
        units.command_at("start", "1", 0, 0);
        units.command_at("watch-progress", "1", 0, 0);
        units.command_at("progress", "1", 24_000, 1_000);
        assert_eq!(units.command_at("progress", "1", 0, 30_000), "false");
        assert_eq!(units.command_at("progress", "2", 480_000, 50_000), "false");
        assert_eq!(units.command_at("watch-progress", "2", 0, 50_000), "false");
        assert_eq!(
            units.command_at("progress", "1", 24_000, PCM_STALL_MS + 1_000),
            "true"
        );
        units.command_at("defer", "2", 0, PCM_STALL_MS + 1_000);
        units.command_at("finish", "1", 0, PCM_STALL_MS + 1_000);
        assert_eq!(units.command_at("next", "", 0, PCM_STALL_MS + 1_000), "2");
        units.command_at("watch-progress", "2", 0, PCM_STALL_MS + 1_000);
        assert_eq!(
            units.command_at("progress", "1", 960_000, PCM_STALL_MS + 2_000),
            "false"
        );
        assert_eq!(
            units.command_at("progress", "2", 24_000, PCM_STALL_MS + 2_000),
            "false"
        );
    }

    #[test]
    fn system_fallback_does_not_inherit_a_pcm_stall() {
        let mut units = PlaybackUnits::default();
        units.command_at("start", "1", 0, 0);
        units.command_at("watch-progress", "1", 0, 0);
        assert_eq!(units.command_at("unwatch-progress", "2", 0, 1_000), "false");
        assert_eq!(units.command_at("unwatch-progress", "1", 0, 1_000), "true");
        assert_eq!(
            units.command_at("timeout-delay-ms", "", 0, 15 * 60_000),
            "1000"
        );
    }

    #[test]
    fn speech_waits_for_speech_and_for_the_entire_alert_unit() {
        let mut units = PlaybackUnits::default();
        assert_eq!(units.command("start", "1", 0), "true");
        assert_eq!(units.command("defer", "2", 0), "true");
        assert_eq!(units.command("defer", "3", 0), "true");
        assert_eq!(units.command("next", "", 0), "null");
        assert_eq!(units.command("finish", "1", 0), "true");
        assert_eq!(units.command("next", "", 0), "2");
        // The alert keeps the same turn between its speech and ringtone.
        assert_eq!(units.command("start", "2", 0), "true");
        assert_eq!(units.command("defer", "2", 0), "false");
        assert_eq!(units.command("next", "", 0), "null");
        assert_eq!(units.command("start", "3", 0), "false");
        assert_eq!(units.command("finish", "2", 0), "true");
        assert_eq!(units.command("next", "", 0), "3");
    }

    #[test]
    fn shaking_one_alert_releases_its_whole_turn_and_keeps_other_alerts() {
        let mut units = PlaybackUnits::default();
        units.command("start", "1", 0);
        units.command("defer", "2", 0);
        units.command("defer", "3", 0);
        units.command("finish", "1", 0);
        assert_eq!(units.command("next", "", 0), "2");
        assert_eq!(units.command("finish", "1", 0), "false");
        assert_eq!(units.command("next", "", 0), "null");
        units.command("finish", "2", 0);
        assert_eq!(units.command("next", "", 0), "3");
    }

    #[test]
    fn cancelled_waiting_speech_cannot_return_when_the_ringtone_ends() {
        let mut units = PlaybackUnits::default();
        units.command("start", "1", 0);
        units.command("defer", "2", 0);
        units.command("defer", "2", 0);
        units.command("defer", "3", 0);
        units.command("cancel", "2", 0);
        units.command("finish", "1", 0);
        assert_eq!(units.command("next", "", 0), "3");
        units.command("finish", "3", 0);
        assert_eq!(units.command("next", "", 0), "null");
    }

    #[test]
    fn long_speech_keeps_playing_until_another_unit_is_waiting() {
        let mut units = PlaybackUnits::default();
        units.command("start", "1", 0);
        assert_eq!(units.command("timeout-delay-ms", "", 0), "1000");
        units.command("defer", "2", 0);
        assert_eq!(units.command("timeout-delay-ms", "", 0), "0");
        // The timeout decision never admits the waiting unit over the active
        // alert's pending ringtone. Native cleanup still finishes the turn.
        assert_eq!(units.command("next", "", 0), "null");
        units.command("start", "1", 0);
        assert_eq!(units.command("next", "", 0), "null");
        units.command("finish", "1", 0);
        assert_eq!(units.command("next", "", 0), "2");
    }

    #[test]
    fn cancelled_waiters_and_the_active_alert_itself_do_not_limit_reading() {
        let mut units = PlaybackUnits::default();
        units.command("start", "1", 0);
        assert_eq!(units.command("defer", "1", 0), "false");
        assert_eq!(units.command("timeout-delay-ms", "", 0), "1000");
        units.command("defer", "2", 0);
        units.command("defer", "3", 0);
        units.command("cancel", "2", 0);
        assert_eq!(units.command("timeout-delay-ms", "", 0), "0");
        units.command("cancel", "3", 0);
        assert_eq!(units.command("timeout-delay-ms", "", 0), "1000");
    }
}
