use std::collections::{HashSet, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaitingLimits {
    Always,
    /// Permit uninterrupted single-source playback; bound competing backlog.
    WhenCompeting,
}

/// Limits apply to waiting work. Continuations of the started group finish first.
#[derive(Clone, Copy, Debug)]
pub struct QueueConfig {
    pub max_waiting_chunks: usize,
    pub max_waiting_utf16_units: usize,
    pub max_wait_ms: u64,
    pub limits: WaitingLimits,
}

/// Plain text supplied by any application. Source and group IDs are opaque.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueueItem {
    pub source: String,
    pub group: String,
    pub text: String,
    /// Repeated only when the source or prefix changes.
    pub prefix: String,
}

impl QueueItem {
    fn belongs_to(&self, identity: Option<&(String, String)>) -> bool {
        identity.is_some_and(|(source, group)| self.source == *source && self.group == *group)
    }
    fn identity(&self) -> (String, String) {
        (self.source.clone(), self.group.clone())
    }

    fn units(&self) -> usize {
        self.text.encode_utf16().count() + self.prefix.encode_utf16().count()
    }
}

#[derive(Debug)]
struct Pending {
    item: QueueItem,
    queued_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Playback {
    /// Unique even after clear/cancel. Fence native callbacks with this and the
    /// player's ownership lease; callbacks for older audio must be ignored.
    pub id: u64,
    pub item: QueueItem,
}

/// Completion-driven queue. A backend can take one utterance at a time.
#[derive(Debug)]
pub struct PlaybackQueue {
    config: QueueConfig,
    pending: VecDeque<Pending>,
    current: Option<(String, String)>,
    last_source: Option<(String, String)>,
    dismissed: HashSet<(String, String)>,
    sequence: u64,
    active: Option<Playback>,
}

impl PlaybackQueue {
    #[must_use]
    pub fn new(config: QueueConfig) -> Self {
        Self {
            config,
            pending: VecDeque::new(),
            current: None,
            last_source: None,
            dismissed: HashSet::new(),
            sequence: 0,
            active: None,
        }
    }

    fn competing(&self, source: &str) -> bool {
        self.current
            .as_ref()
            .is_some_and(|(current, _)| current != source)
            || self
                .pending
                .iter()
                .any(|pending| pending.item.source != source)
    }

    fn limited(&self, source: &str) -> bool {
        self.config.limits == WaitingLimits::Always || self.competing(source)
    }

    fn trim(&mut self, now_ms: u64) {
        let current = self.current.as_ref();
        self.pending.retain(|pending| {
            pending.item.belongs_to(current)
                || now_ms.saturating_sub(pending.queued_at) <= self.config.max_wait_ms
        });
        let (mut count, mut units) = self
            .pending
            .iter()
            .filter(|pending| !pending.item.belongs_to(current))
            .fold((0, 0), |(count, units), pending| {
                (count + 1, units + pending.item.units())
            });
        while count > self.config.max_waiting_chunks || units > self.config.max_waiting_utf16_units
        {
            let Some(index) = self
                .pending
                .iter()
                .position(|pending| !pending.item.belongs_to(current))
            else {
                break;
            };
            if let Some(pending) = self.pending.remove(index) {
                count -= 1;
                units -= pending.item.units();
            }
        }
    }

    /// Returns false when an item's group was explicitly dismissed.
    pub fn enqueue(&mut self, item: QueueItem, now_ms: u64) -> bool {
        if item.text.trim().is_empty() || self.dismissed.contains(&item.identity()) {
            return false;
        }
        let limited = self.limited(&item.source);
        self.pending.push_back(Pending {
            item,
            queued_at: now_ms,
        });
        if limited {
            self.trim(now_ms);
        }
        true
    }

    /// Take only when the native player is ready to accept an utterance.
    pub fn take(&mut self, now_ms: u64) -> Option<Playback> {
        if self.active.is_some() {
            return None;
        }
        let id = self.sequence.checked_add(1)?;
        let limited = self
            .pending
            .front()
            .is_some_and(|pending| self.limited(&pending.item.source));
        loop {
            let index = self
                .pending
                .iter()
                .position(|pending| pending.item.belongs_to(self.current.as_ref()))
                .unwrap_or(0);
            let Some(mut pending) = self.pending.remove(index) else {
                break;
            };
            if !pending.item.belongs_to(self.current.as_ref())
                && limited
                && now_ms.saturating_sub(pending.queued_at) > self.config.max_wait_ms
            {
                continue;
            }
            let source = (pending.item.source.clone(), pending.item.prefix.clone());
            if self.last_source.as_ref() != Some(&source) {
                pending.item.text.insert_str(0, &pending.item.prefix);
            }
            self.last_source = Some(source);
            self.current = Some(pending.item.identity());
            self.sequence = id;
            let playback = Playback {
                id,
                item: pending.item,
            };
            self.active = Some(playback.clone());
            return Some(playback);
        }
        self.current = None;
        None
    }

    pub fn complete(&mut self, id: u64) -> bool {
        if self.active.as_ref().is_none_or(|active| active.id != id) {
            return false;
        }
        self.active = None;
        true
    }

    #[must_use]
    pub fn active(&self) -> Option<&Playback> {
        self.active.as_ref()
    }

    /// Skip the entire started group, including future streamed continuations.
    pub fn dismiss_current(&mut self) {
        self.active = None;
        let Some(identity) = self.current.take() else {
            return;
        };
        self.pending
            .retain(|pending| pending.item.identity() != identity);
        self.dismissed.insert(identity);
    }

    /// Discard a source's waiting work; returns a native utterance to cancel.
    pub fn remove(&mut self, source: &str) -> Option<Playback> {
        self.pending.retain(|pending| pending.item.source != source);
        self.dismissed.retain(|(key, _)| key != source);
        if self
            .last_source
            .as_ref()
            .is_some_and(|(key, _)| key == source)
        {
            self.last_source = None;
        }
        if self.current.as_ref().is_some_and(|(key, _)| key == source) {
            self.current = None;
        }
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.item.source == source)
        {
            self.active.take()
        } else {
            None
        }
    }

    /// Flush work without reusing IDs. Cancel returned playback on the backend.
    pub fn clear(&mut self) -> Option<Playback> {
        self.pending.clear();
        self.current = None;
        self.last_source = None;
        self.dismissed.clear();
        self.active.take()
    }
}
