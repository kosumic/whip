#![allow(
    clippy::unwrap_used,
    reason = "Unexpected policy errors must fail tests"
)]
use ai_voice_call::{Call, Generation, Phase};

#[derive(Default)]
struct Host {
    call: Call,
    sent: Vec<String>,
    speech: Vec<String>,
}

impl Host {
    fn recognized_turn(&mut self, text: &str) -> Generation {
        let input = self.call.view().input_id;
        self.call.recognition(input, text.into());
        self.call.finish();
        let turn = self.call.recognition_ended(input).unwrap().unwrap();
        self.dispatch();
        turn.generation
    }

    fn dispatch(&mut self) {
        if let Some(prompt) = self.call.take_prompt() {
            self.sent.push(prompt);
        }
    }

    fn assistant_text(&mut self, generation: Generation, text: &str, completed: bool) {
        // A host associates provider events with the generation returned at dispatch.
        if self.call.generation() != Some(generation) {
            return;
        }
        self.speech.push(text.into());
        self.call.assistant_progress(generation, completed, true);
    }
}

#[test]
fn independent_host_dispatches_once_and_waits_for_actual_player_drain() {
    let mut host = Host::default();
    host.call.prepared(false);
    let generation = host.recognized_turn("Hello");
    host.dispatch(); // repeated host polls cannot resend
    assert_eq!(host.sent, ["Hello"]);
    host.assistant_text(generation, "First sentence.", false);
    host.speech.clear();
    host.call.playback_ended(generation, false);
    assert_eq!(host.call.view().phase, Phase::Speaking);
    host.assistant_text(generation, "Last sentence.", true);
    assert_eq!(host.speech, ["Last sentence."]);
    host.speech.clear();
    host.call.playback_ended(generation, false);
    assert_eq!(host.call.view().phase, Phase::Listening);

    let replacement = host.recognized_turn("Next turn");
    host.assistant_text(generation, "Late old reply.", true);
    host.call.playback_ended(generation, false);
    assert_eq!(host.call.view().phase, Phase::Waiting);
    assert_eq!(host.sent, ["Hello", "Next turn"]);
    host.assistant_text(replacement, "New reply.", true);
    assert_eq!(host.speech, ["New reply."]);
}
