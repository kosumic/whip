//! Thread-local allocation measurements shared by regressions and benchmarks.
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::time::Instant;

thread_local! {
    static ALLOCATIONS: Cell<Option<Measurement>> = const { Cell::new(None) };
}

#[derive(Clone, Copy, Default)]
struct Measurement {
    count: u64,
    bytes: u64,
    live: i128,
    peak: i128,
}

fn record(allocation: usize, freed: usize) {
    let _ = ALLOCATIONS.try_with(|counter| {
        if let Some(mut measurement) = counter.get() {
            measurement.count += u64::from(allocation != 0);
            measurement.bytes += allocation as u64;
            // Frees can belong to allocations made before measurement began.
            measurement.live += allocation as i128 - freed as i128;
            measurement.peak = measurement.peak.max(measurement.live);
            counter.set(Some(measurement));
        }
    });
}

struct CountingAllocator;

// SAFETY: all allocation operations delegate unchanged to System. The TLS
// counters allocate no memory and never affect allocator ownership or layout.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size(), 0);
        // SAFETY: forwarded with the caller's unmodified allocation layout.
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        record(0, layout.size());
        // SAFETY: pointer/layout retain the allocator's original contract.
        unsafe {
            System.dealloc(pointer, layout);
        }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size, layout.size());
        // SAFETY: forwarded with the caller's original pointer and layout.
        unsafe { System.realloc(pointer, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

pub(crate) fn measured<T>(operation: impl FnOnce() -> T) -> (T, u128, u64, u64) {
    let (value, elapsed, count, bytes, _) = measured_with_peak(operation);
    (value, elapsed, count, bytes)
}

/// Time, allocation traffic, and peak live-byte increase in the same operation.
pub(crate) fn measured_with_peak<T>(operation: impl FnOnce() -> T) -> (T, u128, u64, u64, u64) {
    ALLOCATIONS.with(|counter| counter.set(Some(Measurement::default())));
    let start = Instant::now();
    let value = operation();
    let elapsed = start.elapsed().as_nanos();
    let measurement = ALLOCATIONS.with(|counter| counter.replace(None).unwrap_or_default());
    (
        value,
        elapsed,
        measurement.count,
        measurement.bytes,
        u64::try_from(measurement.peak).unwrap(),
    )
}

/// Peak increase in live bytes on this thread, relative to the starting heap.
pub(crate) fn peak_allocated_bytes<T>(operation: impl FnOnce() -> T) -> (T, u64) {
    ALLOCATIONS.with(|counter| counter.set(Some(Measurement::default())));
    let value = operation();
    let measurement = ALLOCATIONS.with(|counter| counter.replace(None).unwrap_or_default());
    (value, u64::try_from(measurement.peak).unwrap())
}
