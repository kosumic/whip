//! Exclusive FIFO playback turns. An alert retains one turn across speech and
//! ringtone; platform callbacks explicitly finish or cancel their own turn.
use std::collections::VecDeque;

const IDLE_SPEECH_RECHECK_MS: u64 = 1_000;

#[derive(Default)]
pub(super) struct PlaybackUnits {
    sequence: u64,
    active: Option<u64>,
    waiting: VecDeque<u64>,
}

impl PlaybackUnits {
    pub(super) fn command(&mut self, action: &str, token: &str) -> String {
        match action {
            "id" => {
                let Some(next) = self.sequence.checked_add(1) else {
                    return "0".into();
                };
                self.sequence = next;
                next.to_string()
            }
            "active" => self.active.is_some().to_string(),
            // The speech budget bounds contention, not an otherwise idle
            // player's reading time. Recheck so a later arrival can still run.
            "timeout-delay-ms" => if self.waiting.is_empty() {
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
    use super::PlaybackUnits;

    #[test]
    fn speech_waits_for_speech_and_for_the_entire_alert_unit() {
        let mut units = PlaybackUnits::default();
        assert_eq!(units.command("start", "1"), "true");
        assert_eq!(units.command("defer", "2"), "true");
        assert_eq!(units.command("defer", "3"), "true");
        assert_eq!(units.command("next", ""), "null");
        assert_eq!(units.command("finish", "1"), "true");
        assert_eq!(units.command("next", ""), "2");
        // The alert keeps the same turn between its speech and ringtone.
        assert_eq!(units.command("start", "2"), "true");
        assert_eq!(units.command("defer", "2"), "false");
        assert_eq!(units.command("next", ""), "null");
        assert_eq!(units.command("start", "3"), "false");
        assert_eq!(units.command("finish", "2"), "true");
        assert_eq!(units.command("next", ""), "3");
    }

    #[test]
    fn shaking_one_alert_releases_its_whole_turn_and_keeps_other_alerts() {
        let mut units = PlaybackUnits::default();
        units.command("start", "1");
        units.command("defer", "2");
        units.command("defer", "3");
        units.command("finish", "1");
        assert_eq!(units.command("next", ""), "2");
        assert_eq!(units.command("finish", "1"), "false");
        assert_eq!(units.command("next", ""), "null");
        units.command("finish", "2");
        assert_eq!(units.command("next", ""), "3");
    }

    #[test]
    fn cancelled_waiting_speech_cannot_return_when_the_ringtone_ends() {
        let mut units = PlaybackUnits::default();
        units.command("start", "1");
        units.command("defer", "2");
        units.command("defer", "2");
        units.command("defer", "3");
        units.command("cancel", "2");
        units.command("finish", "1");
        assert_eq!(units.command("next", ""), "3");
        units.command("finish", "3");
        assert_eq!(units.command("next", ""), "null");
    }

    #[test]
    fn long_speech_keeps_playing_until_another_unit_is_waiting() {
        let mut units = PlaybackUnits::default();
        units.command("start", "1");
        assert_eq!(units.command("timeout-delay-ms", ""), "1000");
        units.command("defer", "2");
        assert_eq!(units.command("timeout-delay-ms", ""), "0");
        // The timeout decision never admits the waiting unit over the active
        // alert's pending ringtone. Native cleanup still finishes the turn.
        assert_eq!(units.command("next", ""), "null");
        units.command("start", "1");
        assert_eq!(units.command("next", ""), "null");
        units.command("finish", "1");
        assert_eq!(units.command("next", ""), "2");
    }

    #[test]
    fn cancelled_waiters_and_the_active_alert_itself_do_not_limit_reading() {
        let mut units = PlaybackUnits::default();
        units.command("start", "1");
        assert_eq!(units.command("defer", "1"), "false");
        assert_eq!(units.command("timeout-delay-ms", ""), "1000");
        units.command("defer", "2");
        units.command("defer", "3");
        units.command("cancel", "2");
        assert_eq!(units.command("timeout-delay-ms", ""), "0");
        units.command("cancel", "3");
        assert_eq!(units.command("timeout-delay-ms", ""), "1000");
    }
}
