//! Capture generations follow real mute transitions, including a rapid mute/unmute.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub(super) struct InputGate {
    muted: AtomicBool,
    generation: AtomicU64,
}
impl InputGate {
    pub(super) fn new(muted: bool) -> Self {
        Self {
            muted: AtomicBool::new(muted),
            generation: AtomicU64::new(0),
        }
    }
    pub(super) fn set_muted(&self, muted: bool) -> bool {
        if self.muted.swap(muted, Ordering::AcqRel) == muted {
            return false;
        }
        self.generation.fetch_add(1, Ordering::AcqRel);
        true
    }
    pub(super) fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }
    pub(super) fn accepts(&self, generation: u64) -> bool {
        !self.muted.load(Ordering::Acquire) && generation == self.generation()
    }
}

#[cfg(test)]
mod tests {
    use super::InputGate;
    #[test]
    fn repeated_unmuted_controls_preserve_capture_and_real_toggles_reject_old_buffers() {
        let gate = InputGate::new(false);
        let initial = gate.generation();
        assert!(!gate.set_muted(false));
        assert!(gate.accepts(initial));
        assert!(gate.set_muted(true));
        let muted = gate.generation();
        assert!(!gate.accepts(muted));
        assert!(!gate.set_muted(true));
        assert_eq!(gate.generation(), muted);
        assert!(gate.set_muted(false));
        assert!(!gate.accepts(initial));
        assert!(!gate.accepts(muted));
        assert!(gate.accepts(gate.generation()));
    }
}
