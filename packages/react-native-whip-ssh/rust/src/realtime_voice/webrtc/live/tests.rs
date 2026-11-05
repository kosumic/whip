use super::*;

#[test]
fn session_identity_cannot_change_the_authorized_attach_endpoint() {
    assert!(valid_id("live_test-123"));
    for id in [
        "",
        "rtc_wrong",
        "live_",
        "live_a/b",
        "live_a?redirect=true",
        "https://other/live_a",
    ] {
        assert!(!valid_id(id));
    }
}

/// Explicitly billable: real SDP, DTLS, RTP, captions, control and final usage.
/// Uses synthetic instructions, silence input, and no host or agent execution.
#[tokio::test]
#[ignore = "requires explicitly authorized OPENAI_API_KEY and network access"]
#[allow(
    clippy::significant_drop_tightening,
    reason = "The peer moves into the media task after negotiation"
)]
async fn public_live_webrtc_api_smoke() -> Result<(), Box<dyn std::error::Error>> {
    use oai_rt_rs::live::{ClientEvent, Codec, Command, Field, Nullable, ServerEvent};
    use std::ffi::c_void;
    unsafe extern "C" fn read(context: *mut c_void, out: *mut u8, capacity: usize) -> i32 {
        // SAFETY: this test lends its key for one synchronous, bounded read.
        let key = unsafe { &*context.cast::<String>() };
        if key.len() > capacity {
            return -4;
        }
        // SAFETY: the credential ingress supplied capacity writable bytes.
        unsafe {
            std::ptr::copy_nonoverlapping(key.as_ptr(), out, key.len());
        }
        i32::try_from(key.len()).unwrap_or(-4)
    }
    let mut key = std::env::var("OPENAI_API_KEY").map_err(|_| "Missing authorized API key")?;
    // SAFETY: callback/context remain live throughout the synchronous read.
    let credential = unsafe { NativeCredential::read(read, (&raw mut key).cast()) }
        .map_err(|_| "Credential ingress failed")?;
    key.clear();
    let config: voice::Config =
        serde_json::from_value(json!({"live":true,"webrtc":true,"voice":"quartz","global":true}))?;
    let input = std::env::var_os("WHIP_LIVE_SMOKE_PCM")
        .map(std::fs::read)
        .transpose()?;
    let input = input.map(|bytes| {
        bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes(*b))
            .collect::<Vec<_>>()
    });
    let mut session = voice::live::LiveVoiceAdapter::session(&config)?;
    if input.is_some() {
        session.instructions=Field::Value("Wait silently until the user speaks. Once the user greets you, say exactly: The synthetic WebRTC test passed. Do not delegate or use tools.".into());
    }
    let session = serde_json::to_value(session)?;
    let mut input_offset = 0;
    let (events, mut incoming) = futures::channel::mpsc::channel(256);
    let identity = Arc::new(Mutex::new(Identity::live()));
    let owner = playback_owner()?;
    let started = Instant::now();
    let mut peer = Transport::new(events, identity.clone()).await?;
    let offered = startup::elapsed(started);
    let call = Call::create(&credential, peer.offer(), session).await?;
    drop(credential);
    let created = startup::elapsed(started);
    let (mut sideband, connected) = tokio::try_join!(
        async {
            voice::connect_request(call.attach.clone())
                .await
                .map_err(|error| error.message)
        },
        peer.apply_answer(call.answer.clone())
    )?;
    assert_eq!(connected, AnswerOutcome::Ready);
    let connected = startup::elapsed(started);
    let codec = Codec {
        max_event_bytes: voice::MAX_WIRE,
    };
    let (stop, stopped) = watch::channel(false);
    let attempt = recovery::Attempt::new(owner.clone());
    attempt.activate().map_err(|failure| failure.message)?;
    let media_owner = owner.clone();
    let media = tokio::spawn(async move {
        let result = media::run(&media_owner, &mut peer, identity.clone(), stopped, &attempt).await;
        peer.close().await?;
        result
    });
    let mut decoded = [0_i16; voice::FRAME];
    let mut request_at = None;
    let mut seen = voice::wire::Seen::default();
    let mut sent_request = false;
    let mut audio_packets = 0;
    let mut audible = false;
    let mut text = String::new();
    let mut closing = false;
    let mut kinds = std::collections::BTreeSet::new();
    let mut finalized = false;
    let mut seconds = 0.0;
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let deadline = Instant::now() + Duration::from_secs(30);
    let result = async {
        loop {
            let event = tokio::select! {
                event = incoming.next() => event.ok_or("Data channel ended")?.map_err(|_| "Data channel failed")?,
                event = sideband.next() => event.ok_or("Sideband ended")?.map_err(|_| "Sideband failed")?,
                _ = tick.tick() => {
                    if Instant::now() > deadline { return Err("WebRTC smoke deadline exceeded".into()); }
                    if !sent_request && request_at.is_some_and(|at| Instant::now() >= at) {
                        sent_request = true;
                        audible = false;
                        text.clear();
                        if input.is_none() { sideband.send(Message::Text(codec.encode(&ClientEvent::new(Command::InstructionsAppend {
                            content: "Immediately say exactly: The synthetic WebRTC test passed. Then remain quiet. Do not delegate work.".into(),
                            delegation_id: Nullable(None),
                        }))?.into())).await?; }
                    }
                    let mut capture = [0_i16; voice::FRAME];
                    if sent_request && let Some(input) = &input {
                        let count = capture.len().min(input.len().saturating_sub(input_offset));
                        capture[..count].copy_from_slice(&input[input_offset..input_offset+count]);
                        input_offset += count;
                    }
                    owner.capture(&capture, owner.input.generation(), Instant::now());
                    {
                        let mut output = owner.output.lock();
                        let count = output.read(&mut decoded);
                        if sent_request { audible |= decoded[..count].iter().any(|sample| sample.unsigned_abs() >= 64); }
                        audio_packets += usize::from(count > 0);
                        let epoch = output.epoch;
                        let delivered = output.delivered;
                        output.acknowledge(epoch, delivered);
                    }
                    if media.is_finished() { return Err("Native media worker ended before playback".into()); }
                    if audible && text.to_ascii_lowercase().contains("passed") && !closing {
                        sideband.send(Message::Text(codec.encode(&ClientEvent::new(Command::Close))?.into())).await?;
                        closing = true;
                    }
                    continue;
                }
            };
            let Message::Text(raw) = event else { continue; };
            let value: Value = serde_json::from_str(&raw)?;
            if let Some(kind)=value["type"].as_str().filter(|s|s.len()<80&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'.')) && kinds.insert(kind.to_owned()) { eprintln!("Live observed event type={kind}"); }
            if matches!(value["type"].as_str(), Some("session.output_audio.delta" | "session.input_audio.append")) { continue; }
            if !seen.accept(&raw)? { continue; }
            match codec.decode_server(&raw)?.event {
                ServerEvent::Started {..} if request_at.is_none() => {
                    request_at = Some(Instant::now() + Duration::from_secs(5));
                }
                ServerEvent::OutputTranscriptDelta {delta,..} => text.push_str(&delta),
                ServerEvent::Closed {usage,reason,..} => {
                    assert_eq!(reason, oai_rt_rs::live::CloseReason::CloseRequested);
                    seconds = usage.seconds;
                    finalized = true;
                    call.closed.store(true, Ordering::Release);
                    break;
                }
                ServerEvent::Error {error,..} => {
                    // Identifiers only: provider prose may echo request content.
                    return Err(format!("Live WebRTC rejected: {}", error.code.as_deref().filter(|code| code.len()<=64 && code.bytes().all(|byte| byte.is_ascii_lowercase() || byte == b'_')).unwrap_or("provider_error")).into());
                }
                _ => {}
            }
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    }.await;
    let _ = call.retire().await;
    stop.send_replace(true);
    media.await??;
    let _ = sideband.close(None).await;
    result?;
    assert!(audible && audio_packets > 0, "No audible RTP output");
    assert!(sent_request && finalized, "Session did not finalize");
    eprintln!(
        "Live WebRTC observations: offer_ms={offered} create_ms={} ready_ms={connected} rtp_packets={audio_packets} final_seconds={seconds}",
        created - offered
    );
    Ok(())
}

fn playback_owner() -> Result<Arc<RealtimeVoiceAdapter>, &'static str> {
    use std::sync::atomic::AtomicU64;
    let speech = crate::speech_playback::RealtimeSpeechLease::claim(false)
        .ok_or("Speech lease unavailable")?;
    let (commands, _) = tokio::sync::mpsc::channel(8);
    let (cancel, _) = watch::channel(false);
    Ok(Arc::new(RealtimeVoiceAdapter {
        started_at: Instant::now(),
        client_elapsed_ms: 0,
        webrtc: true,
        media: Mutex::new(None),
        view: Mutex::new(voice::View {
            phase: "listening",
            muted: false,
            level: 0.0,
            playback_level: 0.0,
            text: String::new(),
            user_text: String::new(),
            error: None,
            input_tokens: 0,
            output_tokens: 0,
            estimated_usd: None,
            cost_incomplete: false,
            messages: Vec::new(),
            playback: voice::transcript::Timing::default(),
            signal: voice::echo::Signal::default(),
            startup: startup::Timings::default(),
            media_ready: true,
            recovery: recovery::State::Active,
            startup_attempt: 0,
            capture_packets: 0,
            capture_gaps: 0,
            caption_events: 0,
            capture_level: 0.0,
            uploaded_packets: 0,
            server_events: 0,
            input_speech_events: 0,
            tool: None,
            backend_text: None,
            live_seconds: None,
            usage_finalized: false,
            captions: None,
        }),
        output: Mutex::new(voice::Output::default()),
        echo: Mutex::new(None),
        commands,
        input: crate::audio_ingress::NativeIngress::realtime(24_000, voice::FRAME * 4, 32)?,
        cancel,
        closed: AtomicBool::new(false),
        ready: AtomicBool::new(true),
        stopped: AtomicBool::new(false),
        attempt: AtomicU64::new(0),
        devices_ready: AtomicBool::new(true),
        allow_input: true,
        credential_generation: crate::voice_credentials::generation(),
        speech,
        global: None,
    }))
}
