//! Whip-owned ABI and executor integration over the platform-independent queue.
use audio_ingress::{Error, Format, Ingress, Limits, Packet, Ticket};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Notify;

pub(crate) const MAX_AGE: Duration = Duration::from_millis(500);
pub(crate) const MAX_SAMPLES: usize = 8192;
static STREAMS: OnceLock<Mutex<HashMap<u64, Weak<NativeIngress>>>> = OnceLock::new();
fn streams() -> &'static Mutex<HashMap<u64, Weak<NativeIngress>>> {
    STREAMS.get_or_init(Mutex::default)
}

#[repr(u8)]
enum Status {
    Accepted = 0,
    Stale = 1,
    Closed = 3,
    Overflow = 4,
    Invalid = 5,
}

pub(crate) struct NativeIngress {
    queue: Ingress,
    format: Format,
    wake: Notify,
    failed: AtomicBool,
    recover_overload: bool,
    discontinuity: AtomicBool,
    sequence: AtomicU64,
    accepted: AtomicU64,
    recoveries: AtomicU64,
    pub(crate) packet_samples: usize,
}
impl NativeIngress {
    pub(crate) fn new(
        rate: u32,
        packet_samples: usize,
        packets: usize,
    ) -> Result<Arc<Self>, &'static str> {
        Self::with_recovery(rate, packet_samples, packets, false)
    }
    pub(crate) fn realtime(
        rate: u32,
        packet_samples: usize,
        packets: usize,
    ) -> Result<Arc<Self>, &'static str> {
        Self::with_recovery(rate, packet_samples, packets, true)
    }
    fn with_recovery(
        rate: u32,
        packet_samples: usize,
        packets: usize,
        recover_overload: bool,
    ) -> Result<Arc<Self>, &'static str> {
        let format = Format {
            sample_rate: rate,
            channels: 1,
        };
        let queue = Ingress::new(
            format,
            Limits {
                packets,
                samples_per_packet: packet_samples,
                max_age: MAX_AGE,
            },
        )
        .map_err(|_| "Microphone buffering could not start.")?;
        let stream = Arc::new(Self {
            queue,
            format,
            wake: Notify::new(),
            failed: AtomicBool::new(false),
            recover_overload,
            discontinuity: AtomicBool::new(false),
            sequence: AtomicU64::new(0),
            accepted: AtomicU64::new(0),
            recoveries: AtomicU64::new(0),
            packet_samples,
        });
        streams()
            .lock()
            .insert(stream.id(), Arc::downgrade(&stream));
        Ok(stream)
    }
    pub(crate) fn id(&self) -> u64 {
        self.queue.ticket().session
    }
    pub(crate) fn generation(&self) -> u64 {
        self.queue.ticket().generation
    }
    pub(crate) fn diagnostics(&self) -> (u64, u64) {
        (
            self.accepted.load(Ordering::Relaxed),
            self.recoveries.load(Ordering::Relaxed),
        )
    }
    pub(crate) fn accepts(&self, generation: u64) -> bool {
        !self.failed.load(Ordering::Acquire)
            && self.queue.accepts(Ticket {
                session: self.id(),
                generation,
            })
    }
    pub(crate) fn set_muted(&self, muted: bool) -> bool {
        self.queue.set_muted(muted)
    }
    pub(crate) fn close(&self) {
        self.queue.close();
        streams().lock().remove(&self.id());
        self.wake.notify_one();
    }
    fn admitted(&self, result: Result<(), Error>) -> Result<(), Error> {
        if result.is_ok() {
            self.accepted.fetch_add(1, Ordering::Relaxed);
        }
        if let Err(error) = result
            && !matches!(error, Error::Stale | Error::Closed)
        {
            if self.recover_overload
                && matches!(error, Error::Overflow | Error::Busy | Error::Expired)
            {
                self.discontinuity.store(true, Ordering::Release);
            } else {
                self.failed.store(true, Ordering::Release);
            }
        }
        self.wake.notify_one();
        result
    }
    pub(crate) fn push(&self, generation: u64, at: Instant, samples: &[i16]) -> Result<(), Error> {
        if self.failed.load(Ordering::Acquire) {
            return Err(Error::Closed);
        }
        let ticket = Ticket {
            session: self.id(),
            generation,
        };
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        self.admitted(self.queue.push(ticket, self.format, sequence, at, samples))
    }
    /// Retire queued PCM before processing another pending packet after overload.
    pub(crate) fn recover(&self) -> bool {
        if !self.discontinuity.swap(false, Ordering::AcqRel) {
            return false;
        }
        self.recoveries.fetch_add(1, Ordering::Relaxed);
        self.queue.discard();
        true
    }
    /// True marks a capture gap: retire partial DSP/codec state before fresh audio.
    pub(crate) async fn receive(&self, packet: &mut Packet) -> Result<bool, &'static str> {
        loop {
            let wake = self.wake.notified();
            if self.failed.load(Ordering::Acquire) {
                return Err(
                    "Microphone delivery fell behind or returned invalid audio. Reopen voice chat.",
                );
            }
            if self.recover() {
                packet.samples.clear();
                return Ok(true);
            }
            match self.queue.pop_into(packet) {
                Ok(true) => {
                    if self.discontinuity.load(Ordering::Acquire) {
                        continue;
                    }
                    return Ok(false);
                }
                Ok(false) => wake.await,
                Err(Error::Closed) => return Err("Microphone stream closed."),
                Err(Error::Expired) if self.recover_overload => {
                    self.recoveries.fetch_add(1, Ordering::Relaxed);
                    self.queue.discard();
                    packet.samples.clear();
                    return Ok(true);
                }
                Err(_) => return Err("Microphone delivery fell behind. Reopen voice chat."),
            }
        }
    }
}
impl Drop for NativeIngress {
    fn drop(&mut self) {
        streams().lock().remove(&self.id());
    }
}

/// Version 1: little-endian PCM16 mono, borrowed only until return.
/// # Safety
/// `bytes` references `byte_count` initialized bytes for the callback lifetime.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_audio_ingress_push_v1(
    handle: u64,
    bytes: *const u8,
    byte_count: usize,
    sample_rate: u32,
    channels: u16,
    sequence: u64,
    age_ns: u64,
) -> u8 {
    let Some(stream) = streams().lock().get(&handle).and_then(Weak::upgrade) else {
        return Status::Closed as u8;
    };
    if stream.failed.load(Ordering::Acquire) {
        return Status::Closed as u8;
    }
    if bytes.is_null() || byte_count > MAX_SAMPLES * 2 {
        let _ = stream.admitted(Err(Error::InvalidPacket));
        return Status::Invalid as u8;
    }
    let Some(at) = Instant::now().checked_sub(Duration::from_nanos(age_ns)) else {
        let _ = stream.admitted(Err(Error::InvalidPacket));
        return Status::Invalid as u8;
    };
    // SAFETY: The caller owns and bounds this borrowed buffer until return.
    let bytes = unsafe { std::slice::from_raw_parts(bytes, byte_count) };
    let result = stream.admitted(stream.queue.push_le(
        stream.queue.ticket(),
        Format {
            sample_rate,
            channels,
        },
        sequence,
        at,
        bytes,
    ));
    match result {
        Ok(()) => Status::Accepted as u8,
        Err(Error::Stale) => Status::Stale as u8,
        Err(Error::Closed) => Status::Closed as u8,
        Err(Error::Overflow | Error::Busy) => Status::Overflow as u8,
        Err(_) => Status::Invalid as u8,
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        reason = "Unexpected ABI errors must fail these tests immediately"
    )]
    use super::{MAX_AGE, NativeIngress, Packet, Status, whip_audio_ingress_push_v1};
    use audio_ingress::Error;
    use std::time::{Duration, Instant};
    #[tokio::test]
    async fn native_bytes_are_owned_and_closed_handles_cannot_reach_replacements() {
        let stream = NativeIngress::new(16_000, 4, 2).unwrap();
        let mut bytes = [0, 128, 255, 127];
        // SAFETY: The array is live and contains the declared number of bytes.
        let status = unsafe {
            whip_audio_ingress_push_v1(stream.id(), bytes.as_ptr(), bytes.len(), 16_000, 1, 0, 0)
        };
        assert_eq!(status, Status::Accepted as u8);
        bytes.fill(0);
        let mut packet = Packet::new(4);
        stream.receive(&mut packet).await.unwrap();
        assert_eq!(packet.samples, [i16::MIN, i16::MAX]);
        stream.close();
        let replacement = NativeIngress::new(16_000, 4, 2).unwrap();
        assert_ne!(stream.id(), replacement.id());
        // SAFETY: The array remains live for this rejected callback.
        let status = unsafe {
            whip_audio_ingress_push_v1(stream.id(), bytes.as_ptr(), bytes.len(), 16_000, 1, 1, 0)
        };
        assert_eq!(status, Status::Closed as u8);
        assert!(!replacement.queue.pop_into(&mut packet).unwrap());
        replacement.close();
    }

    #[tokio::test]
    async fn malformed_native_audio_wakes_the_consumer_with_an_error() {
        let stream = NativeIngress::new(16_000, 4, 2).unwrap();
        // SAFETY: Null is explicitly checked before accessing the borrowed buffer.
        let status = unsafe {
            whip_audio_ingress_push_v1(stream.id(), std::ptr::null(), 0, 16_000, 1, 0, 0)
        };
        assert_eq!(status, Status::Invalid as u8);
        assert!(stream.receive(&mut Packet::new(4)).await.is_err());
        stream.close();
    }

    #[tokio::test]
    async fn overflow_invalidates_native_admission_until_a_new_stream_is_opened() {
        let stream = NativeIngress::new(16_000, 4, 1).unwrap();
        let bytes = [1, 0];
        for (sequence, status) in [Status::Accepted, Status::Overflow, Status::Closed]
            .into_iter()
            .enumerate()
        {
            // SAFETY: The array remains live for each synchronous callback.
            let actual = unsafe {
                whip_audio_ingress_push_v1(
                    stream.id(),
                    bytes.as_ptr(),
                    bytes.len(),
                    16_000,
                    1,
                    sequence as u64,
                    0,
                )
            };
            assert_eq!(actual, status as u8);
        }
        assert!(stream.receive(&mut Packet::new(4)).await.is_err());
        stream.close();
    }

    #[tokio::test]
    async fn realtime_overload_signals_a_gap_then_resumes_only_fresh_capture() {
        let stream = NativeIngress::realtime(24_000, 4, 1).unwrap();
        let generation = stream.generation();
        stream.push(generation, Instant::now(), &[1, 2]).unwrap();
        assert_eq!(
            stream.push(generation, Instant::now(), &[3]),
            Err(Error::Overflow)
        );
        let mut packet = Packet::new(4);
        assert!(stream.receive(&mut packet).await.unwrap());
        assert!(packet.samples.is_empty());
        assert!(stream.accepts(generation));
        stream.push(generation, Instant::now(), &[7, 8]).unwrap();
        assert!(!stream.receive(&mut packet).await.unwrap());
        assert_eq!(packet.samples, [7, 8]);
        stream.close();
    }

    #[tokio::test]
    async fn realtime_expired_capture_resets_without_ending_the_stream() {
        let stream = NativeIngress::realtime(24_000, 4, 2).unwrap();
        let generation = stream.generation();
        assert_eq!(
            stream.push(
                generation,
                Instant::now()
                    .checked_sub(MAX_AGE + Duration::from_millis(1))
                    .unwrap(),
                &[1]
            ),
            Err(Error::Expired)
        );
        let mut packet = Packet::new(4);
        assert!(stream.receive(&mut packet).await.unwrap());
        stream.push(generation, Instant::now(), &[5]).unwrap();
        assert!(!stream.receive(&mut packet).await.unwrap());
        assert_eq!(packet.samples, [5]);
        stream.close();
    }
}
