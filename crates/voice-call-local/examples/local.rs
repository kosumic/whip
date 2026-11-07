use voice_call_local::{Call, Phase};

fn main() -> Result<(), &'static str> {
    let mut call = Call::default();
    call.prepared(false);
    let input = call.view().input_id;
    // A recorder can pass its existing mono 16 kHz buffer here.
    call.audio(input, &[0.0; 256]);
    call.recognition(input, "Hello from an independent Rust application".into());
    call.finish(); // e.g. the user presses Done
    if let Some(turn) = call.recognition_ended(input)? {
        if let Some(prompt) = call.take_prompt() {
            println!("User: {prompt}"); // dispatch to any assistant or local handler
        }
        let reply = "Hello!";
        println!("Assistant: {reply}"); // hand text to your own TTS adapter
        call.assistant_progress(turn.generation, true, true);
        assert_eq!(call.view().phase, Phase::Speaking);
        call.playback_ended(turn.generation, false); // native player drained
        assert_eq!(call.view().phase, Phase::Listening);
    }
    call.close();
    Ok(())
}
