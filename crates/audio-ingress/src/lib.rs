//! Owned PCM delivery without a recorder, executor, platform SDK, or provider.
//! Producers never wait for queue capacity or a consumer-held queue lock.
use crossbeam_queue::ArrayQueue;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, TryLockError};
use std::time::{Duration, Instant};

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// PCM16 samples. Byte-oriented admission always decodes little endian.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub packets: usize,
    pub samples_per_packet: usize,
    pub max_age: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ticket {
    pub session: u64,
    pub generation: u64,
}

/// Mute and generation are one atomic value, including across rapid toggles.
pub struct InputGate(AtomicU64);
impl InputGate {
    #[must_use]
    pub fn new(muted: bool) -> Self {
        Self(AtomicU64::new(u64::from(muted)))
    }
    pub fn set_muted(&self, muted: bool) -> bool {
        self.0
            .try_update(Ordering::AcqRel, Ordering::Acquire, |old| {
                if old == u64::MAX || old & 1 == u64::from(muted) {
                    return None;
                }
                Some(
                    old.checked_add(2)
                        .map_or(u64::MAX, |next| (next & !1) | u64::from(muted)),
                )
            })
            .is_ok()
    }
    #[must_use]
    pub fn generation(&self) -> u64 {
        self.0.load(Ordering::Acquire) >> 1
    }
    #[must_use]
    pub fn accepts(&self, generation: u64) -> bool {
        generation
            .checked_mul(2)
            .is_some_and(|value| self.0.load(Ordering::Acquire) == value)
    }
}

/// Admission errors are observable; overload never silently removes PCM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidConfig,
    InvalidFormat,
    InvalidPacket,
    OutOfOrder,
    Stale,
    Expired,
    Closed,
    Overflow,
    Busy,
}

/// Allocate once per consumer and reuse it across reads.
pub struct Packet {
    pub samples: Vec<i16>,
    pub ticket: Ticket,
    pub sequence: u64,
    pub at: Instant,
}
impl Packet {
    #[must_use]
    pub fn new(max_samples: usize) -> Self {
        Self {
            samples: Vec::with_capacity(max_samples),
            ticket: Ticket {
                session: 0,
                generation: 0,
            },
            sequence: 0,
            at: Instant::now(),
        }
    }
}

struct Slot {
    samples: Box<[i16]>,
    len: usize,
    ticket: Ticket,
    sequence: u64,
    at: Instant,
}
struct State {
    last: Option<(Ticket, u64, Instant)>,
}

pub struct Ingress {
    closed: AtomicBool,
    session: u64,
    format: Format,
    limits: Limits,
    gate: InputGate,
    state: Mutex<State>,
    consumer: Mutex<()>,
    ready: ArrayQueue<Slot>,
    free: ArrayQueue<Slot>,
}
impl Ingress {
    /// Reserves the entire PCM capacity before capture starts.
    ///
    /// # Errors
    /// Rejects invalid/unreasonably large bounds, non-mono formats, or exhausted IDs.
    pub fn new(format: Format, limits: Limits) -> Result<Self, Error> {
        let slots = limits.packets.checked_add(1).ok_or(Error::InvalidConfig)?;
        let capacity = slots
            .checked_mul(limits.samples_per_packet)
            .ok_or(Error::InvalidConfig)?;
        if format.sample_rate == 0 || format.channels != 1 {
            return Err(Error::InvalidFormat);
        }
        if limits.packets == 0 || capacity == 0 || capacity > 1_048_576 || limits.max_age.is_zero()
        {
            return Err(Error::InvalidConfig);
        }
        let session = NEXT_SESSION
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| Error::InvalidConfig)?;
        let ticket = Ticket {
            session,
            generation: 0,
        };
        // One spare slot lets capture proceed while the consumer copies a packet.
        let free = ArrayQueue::new(slots);
        for _ in 0..slots {
            let slot = Slot {
                samples: vec![0; limits.samples_per_packet].into_boxed_slice(),
                len: 0,
                ticket,
                sequence: 0,
                at: Instant::now(),
            };
            let _ = free.push(slot);
        }
        Ok(Self {
            closed: AtomicBool::new(false),
            session,
            format,
            limits,
            gate: InputGate::new(false),
            state: Mutex::new(State { last: None }),
            consumer: Mutex::new(()),
            ready: ArrayQueue::new(limits.packets),
            free,
        })
    }
    #[must_use]
    pub fn ticket(&self) -> Ticket {
        Ticket {
            session: self.session,
            generation: self.gate.generation(),
        }
    }
    #[must_use]
    pub fn accepts(&self, ticket: Ticket) -> bool {
        !self.closed.load(Ordering::Acquire)
            && ticket.session == self.session
            && self.gate.accepts(ticket.generation)
    }
    pub fn set_muted(&self, muted: bool) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.closed.load(Ordering::Acquire) {
            return false;
        }
        let changed = self.gate.set_muted(muted);
        if changed {
            self.discard();
            state.last = None;
        }
        changed
    }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.gate.set_muted(true);
        let _producer = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _consumer = self
            .consumer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for queue in [&self.ready, &self.free] {
            while let Some(mut slot) = queue.pop() {
                slot.samples.fill(0);
            }
        }
    }
    /// Discard a bounded backlog without contending with capture's ordering lock.
    pub fn discard(&self) {
        let _consumer = self
            .consumer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for _ in 0..self.limits.packets {
            let Some(mut slot) = self.ready.pop() else {
                break;
            };
            slot.samples[..slot.len].fill(0);
            let _ = self.free.push(slot);
        }
    }
    /// # Errors
    /// Rejects invalid/stale packets and returns immediately on contention/overload.
    pub fn push(
        &self,
        ticket: Ticket,
        format: Format,
        sequence: u64,
        at: Instant,
        samples: &[i16],
    ) -> Result<(), Error> {
        self.write(ticket, format, sequence, at, samples.len(), |out| {
            out.copy_from_slice(samples);
        })
    }
    /// # Errors
    /// Also rejects odd byte counts. Decodes directly into preallocated Rust storage.
    pub fn push_le(
        &self,
        ticket: Ticket,
        format: Format,
        sequence: u64,
        at: Instant,
        bytes: &[u8],
    ) -> Result<(), Error> {
        if !bytes.len().is_multiple_of(2) {
            return Err(Error::InvalidPacket);
        }
        self.write(ticket, format, sequence, at, bytes.len() / 2, |out| {
            for (sample, pair) in out.iter_mut().zip(bytes.as_chunks::<2>().0) {
                *sample = i16::from_le_bytes(*pair);
            }
        })
    }
    fn write(
        &self,
        ticket: Ticket,
        format: Format,
        sequence: u64,
        at: Instant,
        count: usize,
        copy: impl FnOnce(&mut [i16]),
    ) -> Result<(), Error> {
        if format != self.format {
            return Err(Error::InvalidFormat);
        }
        if count == 0 || count > self.limits.samples_per_packet {
            return Err(Error::InvalidPacket);
        }
        if !self.accepts(ticket) {
            return Err(Error::Stale);
        }
        let now = Instant::now();
        if at > now {
            return Err(Error::InvalidPacket);
        }
        if now.duration_since(at) > self.limits.max_age {
            return Err(Error::Expired);
        }
        let mut state = self.state.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => Error::Busy,
            TryLockError::Poisoned(_) => Error::Closed,
        })?;
        if self.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        if !self.accepts(ticket) {
            return Err(Error::Stale);
        }
        if let Some((last_ticket, last_sequence, last_at)) = state.last
            && last_ticket == ticket
            && (sequence <= last_sequence || at < last_at)
        {
            return Err(Error::OutOfOrder);
        }
        if self.ready.is_full() {
            return Err(Error::Overflow);
        }
        let mut slot = self.free.pop().ok_or(Error::Overflow)?;
        copy(&mut slot.samples[..count]);
        slot.len = count;
        slot.ticket = ticket;
        slot.sequence = sequence;
        slot.at = at;
        if let Err(mut rejected) = self.ready.push(slot) {
            rejected.samples[..rejected.len].fill(0);
            let _ = self.free.push(rejected);
            return Err(Error::Overflow);
        }
        state.last = Some((ticket, sequence, at));
        Ok(())
    }
    /// Read outside the native callback. Check the returned ticket again under
    /// the consumer's lifecycle lock immediately before processing its samples.
    ///
    /// # Errors
    /// Rejects undersized output storage, closed queues, and expired audio.
    pub fn pop_into(&self, out: &mut Packet) -> Result<bool, Error> {
        out.samples.clear();
        if out.samples.capacity() < self.limits.samples_per_packet {
            return Err(Error::InvalidPacket);
        }
        let _consumer = self.consumer.lock().map_err(|_| Error::Closed)?;
        if self.closed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        while let Some(mut slot) = self.ready.pop() {
            let accepted = self.accepts(slot.ticket);
            let expired = slot.at.elapsed() > self.limits.max_age;
            if accepted && !expired {
                out.samples.extend_from_slice(&slot.samples[..slot.len]);
                out.ticket = slot.ticket;
                out.sequence = slot.sequence;
                out.at = slot.at;
            }
            slot.samples[..slot.len].fill(0);
            let _ = self.free.push(slot);
            if accepted {
                return if expired {
                    Err(Error::Expired)
                } else {
                    Ok(true)
                };
            }
        }
        Ok(false)
    }
}
