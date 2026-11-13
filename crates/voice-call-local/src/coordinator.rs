//! Call-owned asynchronous work policy. The host supplies a monotonic millisecond
//! clock and executes effects; cancelled work never owns the next playback lease.
use std::collections::VecDeque;

const BINDING_TIMEOUT: u64 = 30_000;
const DISPATCH_TIMEOUT: u64 = 30_000;
const MATCH_TIMEOUT: u64 = 30_000;
const PLAYBACK_TIMEOUT: u64 = 60_000;
const FILLER_DELAY: u64 = 2_000;
const FILLER_INTERVAL: u64 = 20_000;
const LOOKAHEAD: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    AwaitingBinding,
    Ready,
    Submitting,
    WaitingForTurn,
    WaitingForReply,
    FillerPlaying,
    ReplyPlaying,
    Recovering,
    Failed,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    Queued,
    Dispatched,
    Observed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeechKind {
    Filler,
    Reply,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lease {
    pub generation: u64,
    pub serial: u64,
    pub kind: SpeechKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Speech {
    pub text: String,
    pub message_id: String,
    pub part_id: String,
    pub start_utf16: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Start(Lease),
    Speak(Lease, u64, Speech),
    Stop(Lease),
    Drained(u64),
}

struct Playback {
    lease: Lease,
    ready: bool,
    deadline: u64,
    pending: VecDeque<(u64, u64)>,
}

/// Used alongside `Call` under the same host lock. `Call` owns capture/turn
/// boundaries; this coordinator owns all asynchronous send and playback leases.
pub struct Coordinator {
    pub stage: Stage,
    pub delivery: Option<Delivery>,
    pub error: Option<&'static str>,
    generation: u64,
    sequence: u64,
    binding_deadline: Option<u64>,
    delivery_deadline: Option<u64>,
    match_deadline: Option<u64>,
    filler_at: u64,
    bound: bool,
    active: bool,
    completed: bool,
    queue: VecDeque<Speech>,
    playback: Option<Playback>,
    effects: Vec<Effect>,
    capacity: usize,
}

impl Default for Coordinator {
    fn default() -> Self {
        Self {
            stage: Stage::AwaitingBinding,
            delivery: None,
            error: None,
            generation: 0,
            sequence: 0,
            binding_deadline: None,
            delivery_deadline: None,
            match_deadline: None,
            filler_at: 0,
            bound: false,
            active: false,
            completed: false,
            queue: VecDeque::new(),
            playback: None,
            effects: Vec::new(),
            capacity: LOOKAHEAD,
        }
    }
}

impl Coordinator {
    pub fn set_playback_capacity(&mut self, capacity: usize) {
        self.capacity = capacity.clamp(1, LOOKAHEAD);
    }

    pub fn failed_playback(&mut self, lease: Lease) {
        if self.accepts(lease) && lease.kind == SpeechKind::Filler {
            self.revoke();
            self.refresh_stage();
        }
    }
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.generation
    }

    #[must_use]
    pub fn queue_depth(&self) -> usize {
        self.queue.len() + self.playback.as_ref().map_or(0, |p| p.pending.len())
    }

    pub fn acquiring(&mut self, now: u64) {
        if self.binding_deadline.is_none() && !self.terminal() {
            self.binding_deadline = Some(now + BINDING_TIMEOUT);
        }
    }

    pub fn binding(&mut self, available: bool, now: u64) {
        if self.terminal() {
            return;
        }
        self.bound = available;
        if available {
            self.binding_deadline = None;
        } else {
            self.acquiring(now);
            // Reassurance while the source is unavailable is misleading.
            if self
                .playback
                .as_ref()
                .is_some_and(|p| p.lease.kind == SpeechKind::Filler)
            {
                self.revoke();
            }
        }
        self.refresh_stage();
    }

    pub fn submit(&mut self, now: u64) -> u64 {
        if self.terminal() {
            return self.generation;
        }
        self.cancel();
        self.active = true;
        self.completed = false;
        self.delivery = Some(Delivery::Queued);
        self.delivery_deadline = Some(now + DISPATCH_TIMEOUT);
        self.match_deadline = None;
        self.filler_at = now + FILLER_DELAY;
        self.refresh_stage();
        self.generation
    }

    pub fn dispatched(&mut self, generation: u64, now: u64) {
        if self.generation != generation || !self.active || self.terminal() {
            return;
        }
        if self.delivery == Some(Delivery::Queued) {
            self.delivery = Some(Delivery::Dispatched);
            self.delivery_deadline = None;
            self.match_deadline = Some(now + MATCH_TIMEOUT);
            self.filler_at = now + FILLER_DELAY;
        }
        self.refresh_stage();
    }

    pub fn observed(&mut self, now: u64) {
        if !self.active || self.terminal() {
            return;
        }
        self.delivery = Some(Delivery::Observed);
        self.delivery_deadline = None;
        self.match_deadline = None;
        self.filler_at = self.filler_at.max(now);
        self.refresh_stage();
    }

    /// A provider may reconcile a temporary turn ID during a snapshot rebuild.
    /// Preserve speech cursors while bounding the wait for its submission marker.
    pub fn awaiting_turn(&mut self, now: u64) {
        if self.active && !self.terminal() {
            self.delivery = Some(Delivery::Dispatched);
            self.match_deadline.get_or_insert(now + MATCH_TIMEOUT);
            self.refresh_stage();
        }
    }

    pub fn reply(&mut self, speech: Speech, now: u64) {
        if !self.active || self.terminal() {
            return;
        }
        if self
            .playback
            .as_ref()
            .is_some_and(|p| p.lease.kind == SpeechKind::Filler)
        {
            self.revoke();
        }
        self.queue.push_back(speech);
        self.pump(now);
    }

    pub fn completed(&mut self, now: u64) {
        if !self.active || self.terminal() {
            return;
        }
        self.completed = true;
        if self
            .playback
            .as_ref()
            .is_some_and(|p| p.lease.kind == SpeechKind::Filler)
        {
            self.revoke();
        }
        self.pump(now);
    }

    pub fn started(&mut self, lease: Lease, now: u64) {
        if let Some(p) = &mut self.playback
            && p.lease == lease
        {
            p.ready = true;
            p.deadline = now + PLAYBACK_TIMEOUT;
            self.pump(now);
        }
    }

    pub fn played(&mut self, lease: Lease, chunk: u64, now: u64) {
        if let Some(p) = &mut self.playback
            && p.lease == lease
        {
            // Retain later out-of-order completions, never replay a chunk.
            p.pending.retain(|(id, _)| *id != chunk);
            if lease.kind == SpeechKind::Filler && p.pending.is_empty() && p.ready {
                self.revoke();
            }
            self.pump(now);
        }
    }

    #[must_use]
    pub fn accepts(&self, lease: Lease) -> bool {
        self.playback.as_ref().is_some_and(|p| p.lease == lease)
    }

    #[must_use]
    pub fn lease(&self) -> Option<Lease> {
        self.playback.as_ref().map(|p| p.lease)
    }

    pub fn tick(&mut self, now: u64) {
        if self.terminal() {
            return;
        }
        if self.binding_deadline.is_some_and(|at| now >= at) {
            self.fail("The agent transcript did not connect. Reopen voice chat to retry.");
        } else if self.delivery_deadline.is_some_and(|at| now >= at) {
            self.fail(
                "The voice message was not dispatched. Inspect the send queue before retrying.",
            );
        } else if self.match_deadline.is_some_and(|at| now >= at) {
            self.fail("The voice message was sent, but its agent turn could not be identified. Check the transcript.");
        } else if self.playback.as_ref().is_some_and(|p| {
            (!p.ready && now >= p.deadline) || p.pending.iter().any(|(_, at)| now >= *at)
        }) {
            if self
                .playback
                .as_ref()
                .is_some_and(|p| p.lease.kind == SpeechKind::Filler)
            {
                self.revoke();
            } else {
                self.fail("Local speech playback did not finish. Reopen voice chat to retry.");
            }
        }
        self.pump(now);
    }

    /// The host chooses a phrase only when requested; scheduling is deterministic.
    #[must_use]
    pub fn filler_due(&self, now: u64) -> bool {
        self.bound
            && self.active
            && !self.completed
            && !self.terminal()
            && self.delivery != Some(Delivery::Queued)
            && self.playback.is_none()
            && self.queue.is_empty()
            && now >= self.filler_at
    }

    pub fn filler(&mut self, text: String, now: u64) {
        if !self.filler_due(now) {
            return;
        }
        self.filler_at = now + FILLER_INTERVAL;
        self.start(SpeechKind::Filler, now);
        self.queue.push_back(Speech {
            text,
            message_id: String::new(),
            part_id: String::new(),
            start_utf16: 0,
        });
        self.pump(now);
    }

    pub fn cancel(&mut self) {
        self.revoke();
        self.generation += 1;
        self.active = false;
        self.queue.clear();
        self.delivery = None;
        self.delivery_deadline = None;
        self.match_deadline = None;
        self.refresh_stage();
    }

    pub fn fail(&mut self, error: &'static str) {
        if self.terminal() {
            return;
        }
        self.cancel();
        self.error = Some(error);
        self.stage = Stage::Failed;
    }

    pub fn close(&mut self) {
        self.cancel();
        self.stage = Stage::Closed;
    }

    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    fn terminal(&self) -> bool {
        matches!(self.stage, Stage::Failed | Stage::Closed)
    }

    fn revoke(&mut self) {
        if let Some(p) = self.playback.take() {
            if p.lease.kind == SpeechKind::Filler {
                self.queue.clear();
            }
            self.effects.push(Effect::Stop(p.lease));
        }
    }

    fn start(&mut self, kind: SpeechKind, now: u64) {
        self.sequence += 1;
        let lease = Lease {
            generation: self.generation,
            serial: self.sequence,
            kind,
        };
        self.playback = Some(Playback {
            lease,
            ready: false,
            deadline: now + PLAYBACK_TIMEOUT,
            pending: VecDeque::new(),
        });
        self.effects.push(Effect::Start(lease));
    }

    fn pump(&mut self, now: u64) {
        if self.terminal() || !self.active {
            return;
        }
        if self.playback.is_none() && !self.queue.is_empty() {
            self.start(SpeechKind::Reply, now);
        }
        if let Some(p) = &mut self.playback
            && p.ready
        {
            while p.pending.len() < self.capacity {
                let Some(speech) = self.queue.pop_front() else {
                    break;
                };
                self.sequence += 1;
                p.pending.push_back((self.sequence, now + PLAYBACK_TIMEOUT));
                self.effects
                    .push(Effect::Speak(p.lease, self.sequence, speech));
            }
        }
        if self.completed
            && self.queue.is_empty()
            && self
                .playback
                .as_ref()
                .is_none_or(|p| p.ready && p.pending.is_empty())
        {
            self.revoke();
            self.active = false;
            self.effects.push(Effect::Drained(self.generation));
        }
        self.refresh_stage();
    }

    fn refresh_stage(&mut self) {
        if self.terminal() {
            return;
        }
        self.stage = if !self.bound {
            if self.active {
                Stage::Recovering
            } else {
                Stage::AwaitingBinding
            }
        } else if let Some(p) = &self.playback {
            match p.lease.kind {
                SpeechKind::Filler => Stage::FillerPlaying,
                SpeechKind::Reply => Stage::ReplyPlaying,
            }
        } else if !self.active {
            Stage::Ready
        } else {
            match self.delivery {
                Some(Delivery::Queued) => Stage::Submitting,
                Some(Delivery::Dispatched) => Stage::WaitingForTurn,
                _ => Stage::WaitingForReply,
            }
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn speech() -> Speech {
        Speech {
            text: "The reply.".into(),
            message_id: "m".into(),
            part_id: "p".into(),
            start_utf16: 0,
        }
    }
    fn waiting() -> Coordinator {
        let mut c = Coordinator::default();
        c.binding(true, 0);
        let generation = c.submit(0);
        c.dispatched(generation, 0);
        c.observed(0);
        c
    }

    #[test]
    fn initial_missing_binding_and_unsent_queue_have_bounded_distinct_errors() {
        let mut c = Coordinator::default();
        c.acquiring(0);
        c.tick(BINDING_TIMEOUT - 1);
        assert!(c.error.is_none());
        c.tick(BINDING_TIMEOUT);
        assert_eq!(c.stage, Stage::Failed);
        let mut c = waiting();
        c.submit(0);
        assert!(!c.filler_due(FILLER_DELAY));
        c.tick(DISPATCH_TIMEOUT);
        assert!(
            c.error
                .is_some_and(|error| error.contains("not dispatched"))
        );
    }

    #[test]
    fn stuck_filler_start_or_stop_never_holds_reply_and_late_callbacks_are_fenced() {
        for started in [false, true] {
            let mut c = waiting();
            c.filler("Hmm.".into(), FILLER_DELAY);
            let Effect::Start(filler) = c.take_effects()[0] else {
                panic!("start");
            };
            if started {
                c.started(filler, FILLER_DELAY);
            }
            c.take_effects();
            c.reply(speech(), 3_000);
            let effects = c.take_effects();
            assert_eq!(effects[0], Effect::Stop(filler));
            let Effect::Start(reply) = effects[1] else {
                panic!("reply starts without stop ACK");
            };
            c.started(filler, 4_000);
            c.played(filler, 0, 4_000);
            assert!(!c.accepts(filler));
            assert!(c.accepts(reply));
            c.started(reply, 4_000);
            assert!(matches!(
                c.take_effects().as_slice(),
                [Effect::Speak(_, _, _)]
            ));
        }
    }

    #[test]
    fn completion_waits_for_actual_out_of_order_playback_drain() {
        let mut c = waiting();
        c.reply(speech(), 0);
        let Effect::Start(lease) = c.take_effects()[0] else {
            panic!("start");
        };
        c.started(lease, 0);
        c.reply(speech(), 0);
        let effects = c.take_effects();
        let Effect::Speak(_, first, _) = effects[0] else {
            panic!("first");
        };
        let Effect::Speak(_, second, _) = effects[1] else {
            panic!("second");
        };
        c.completed(0);
        c.played(lease, second, 1);
        assert!(c.take_effects().is_empty());
        c.played(lease, first, 2);
        assert_eq!(
            c.take_effects(),
            vec![Effect::Stop(lease), Effect::Drained(lease.generation)]
        );
        c.played(lease, first, 3);
        assert!(c.take_effects().is_empty());
    }

    #[test]
    fn recovery_preserves_reply_and_deadline_does_not_extend_with_stale_updates() {
        let mut c = waiting();
        c.binding(false, 10);
        c.binding(false, 20_000);
        c.binding(true, 29_000);
        c.reply(speech(), 29_000);
        assert_eq!(c.stage, Stage::ReplyPlaying);
        c.cancel();
        assert_eq!(c.queue_depth(), 0);
        c.close();
        c.binding(true, 100_000);
        c.tick(100_000);
        assert_eq!(c.stage, Stage::Closed);
    }
}
