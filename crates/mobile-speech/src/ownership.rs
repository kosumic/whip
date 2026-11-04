use std::num::NonZeroU64;

/// A process-local ownership generation. Never reused by an arbiter.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LeaseId(NonZeroU64);

impl LeaseId {
    #[must_use]
    pub const fn new(value: u64) -> Option<Self> {
        match NonZeroU64::new(value) {
            Some(value) => Some(Self(value)),
            None => None,
        }
    }

    #[must_use]
    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

/// Which active request a newly admitted request may replace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preemption {
    Never,
    SameClass,
    SameOwner,
    Any,
}

/// Application-supplied admission policy. Class numbers have no built-in meaning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Admission {
    pub preemption: Preemption,
    /// Reserve ownership between utterances until explicitly stopped.
    pub retain_on_complete: bool,
}

#[derive(Debug)]
struct Lease {
    id: LeaseId,
    class: u8,
    owner: String,
    request: String,
    retain_on_complete: bool,
}

/// One admission authority for all speech users of an application's player.
///
/// No global state or internal lock: an embedding application supplies both.
#[derive(Debug, Default)]
pub struct Arbiter {
    sequence: u64,
    active: Option<Lease>,
}

impl Arbiter {
    pub fn claim(
        &mut self,
        class: u8,
        owner: &str,
        request: &str,
        admission: Admission,
    ) -> Option<LeaseId> {
        if owner.is_empty() {
            return None;
        }
        if let Some(active) = &self.active {
            let allowed = match admission.preemption {
                Preemption::Never => false,
                Preemption::SameClass => active.class == class,
                Preemption::SameOwner => active.class == class && active.owner == owner,
                Preemption::Any => true,
            };
            if !allowed {
                return None;
            }
        }
        let sequence = self.sequence.checked_add(1)?;
        let id = LeaseId::new(sequence)?;
        self.sequence = sequence;
        self.active = Some(Lease {
            id,
            class,
            owner: owner.into(),
            request: request.into(),
            retain_on_complete: admission.retain_on_complete,
        });
        Some(id)
    }

    /// Transfer at a native-certified idle boundary, fencing intervening claims.
    /// `None` certifies that the caller observed an idle player.
    pub fn handoff(
        &mut self,
        observed: Option<LeaseId>,
        from_class: u8,
        to_class: u8,
        owner: &str,
        admission: Admission,
    ) -> Option<LeaseId> {
        match (&self.active, observed) {
            (None, None) => {}
            (Some(active), Some(id)) if active.id == id && active.class == from_class => {}
            _ => return None,
        }
        // Boundary validation authorizes this transfer regardless of the normal
        // preemption rule. Completion still follows the target's policy.
        self.claim(
            to_class,
            owner,
            "",
            Admission {
                preemption: Preemption::Any,
                ..admission
            },
        )
    }

    #[must_use]
    pub fn is_current(&self, id: LeaseId) -> bool {
        self.active.as_ref().is_some_and(|active| active.id == id)
    }

    pub fn complete(&mut self, id: LeaseId) -> bool {
        if !self.is_current(id) {
            return false;
        }
        if self
            .active
            .as_ref()
            .is_some_and(|active| !active.retain_on_complete)
        {
            self.active = None;
        }
        true
    }

    pub fn stop(&mut self, id: LeaseId) -> bool {
        if !self.is_current(id) {
            return false;
        }
        self.active = None;
        true
    }

    pub fn stop_matching(
        &mut self,
        class: u8,
        owner: Option<&str>,
        request: Option<&str>,
    ) -> Option<LeaseId> {
        let active = self.active.as_ref()?;
        if active.class != class
            || owner.is_some_and(|owner| owner != active.owner)
            || request.is_some_and(|request| request != active.request)
        {
            return None;
        }
        let id = active.id;
        self.active = None;
        Some(id)
    }
}
