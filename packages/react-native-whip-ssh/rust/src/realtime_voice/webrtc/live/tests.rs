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
async fn public_live_webrtc_api_smoke() -> Result<(), Box<dyn std::error::Error>> {
    use oai_rt_rs::live::{ClientEvent, Codec, Command, Nullable, ServerEvent};
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
    let config: voice::Config = serde_json::from_value(
        json!({"live":true,"webrtc":true,"voice":"quartz","target":{
            "runtimeId":"synthetic","terminalId":"synthetic","paneId":"synthetic","bindingToken":"synthetic"
        }}),
    )?;
    let session = serde_json::to_value(voice::live::LiveVoiceAdapter::session(&config)?)?;
    let (events, mut incoming) = futures::channel::mpsc::channel(256);
    let identity = Arc::new(Mutex::new(Identity::live()));
    let started = Instant::now();
    let mut peer = Transport::new(events, identity).await?;
    peer.incoming.set_suppressed(false)?;
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
    let mut decoder = opus::Decoder::new(24_000, opus::Channels::Mono)?;
    let mut decoded = vec![0_i16; voice::RATE * 120 / 1000];
    let mut seen = voice::wire::Seen::default();
    let mut sent_request = false;
    let mut audio_packets = 0;
    let mut audible = false;
    let mut text = String::new();
    let mut closing = false;
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
                    if !closing { peer.audio.send_muted_silence(Instant::now()).await?; }
                    for _ in 0..super::super::incoming::PACKETS {
                        let Some(packet) = peer.incoming.take()? else { break; };
                        let packet = super::super::packet::parse(packet.as_ref()).ok_or("Invalid RTP")?;
                        let count = decoder.decode(&packet.payload, &mut decoded, false)?;
                        audible |= decoded[..count].iter().any(|sample| sample.unsigned_abs() >= 64);
                        audio_packets += 1;
                    }
                    if audible && text.to_ascii_lowercase().contains("passed") && !closing {
                        sideband.send(Message::Text(codec.encode(&ClientEvent::new(Command::Close))?.into())).await?;
                        closing = true;
                    }
                    continue;
                }
            };
            let Message::Text(raw) = event else { continue; };
            let value: Value = serde_json::from_str(&raw)?;
            if matches!(value["type"].as_str(), Some("session.output_audio.delta" | "session.input_audio.append")) { continue; }
            if !seen.accept(&raw)? { continue; }
            match codec.decode_server(&raw)?.event {
                ServerEvent::Started {..} if !sent_request => {
                    sent_request = true;
                    sideband.send(Message::Text(codec.encode(&ClientEvent::new(Command::InstructionsAppend {
                        content: "Immediately say exactly: The synthetic WebRTC test passed. Then remain quiet. Do not delegate work.".into(),
                        delegation_id: Nullable(None),
                    }))?.into())).await?;
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
    peer.close().await?;
    drop(peer);
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
