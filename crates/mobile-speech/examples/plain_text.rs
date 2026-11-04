//! A navigation app using the core without Whip, transcripts, models, or an SDK.
use mobile_speech::{PlaybackQueue, QueueConfig, QueueItem, WaitingLimits};

fn main() {
    let mut queue = PlaybackQueue::new(QueueConfig {
        max_waiting_chunks: 8,
        max_waiting_utf16_units: 2_000,
        max_wait_ms: 10_000,
        limits: WaitingLimits::Always,
    });
    queue.enqueue(
        QueueItem {
            source: "navigation".into(),
            group: "route-1".into(),
            text: "Turn left at the next street.".into(),
            prefix: String::new(),
            context: String::new(),
        },
        0,
    );
    if let Some(playback) = queue.take(0) {
        // Dispatch playback.item.text to Android TextToSpeech, AVSpeechSynthesizer,
        // or a custom PCM backend. Its native audio-drained callback completes it.
        println!("{}: {}", playback.id, playback.item.text);
        assert!(queue.complete(playback.id));
    }
}
