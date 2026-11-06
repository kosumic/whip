use super::*;

// These fixtures claim the process-wide device speech lease.
static DEVICE_AUDIO_TEST: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    let credential = authorized_credential()?;
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
    let identity = Arc::new(Mutex::new(Identity::live()));
    let owner = playback_owner()?;
    let started = Instant::now();
    let mut peer = Transport::configured(voice_openai::media::transport_config()).await?;
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
    // The POST starts Live. An attached sideband need not replay session.started.
    let request_at = Instant::now() + Duration::from_secs(5);
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
                event = sideband.next() => event.ok_or("Sideband ended")?.map_err(|_| "Sideband failed")?,
                _ = tick.tick() => {
                    if Instant::now() > deadline { return Err("WebRTC smoke deadline exceeded".into()); }
                    if !sent_request && Instant::now() >= request_at {
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
        cue: Mutex::default(),
        started_at: Instant::now(),
        client_elapsed_ms: 0,
        webrtc: true,
        live: false,
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
            media: voice::MediaDiagnostics::default(),
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

fn starting_owner() -> Result<Arc<RealtimeVoiceAdapter>, &'static str> {
    let owner = playback_owner()?;
    owner.ready.store(false, Ordering::Release);
    owner.devices_ready.store(false, Ordering::Release);
    {
        let mut view = owner.view.lock();
        view.media_ready = false;
        view.phase = "starting";
    }
    Ok(owner)
}

#[tokio::test]
async fn hangup_rejects_late_pcm_before_it_can_reach_native_playback()
-> Result<(), Box<dyn std::error::Error>> {
    use voice_openai::Host;
    let _device_audio = DEVICE_AUDIO_TEST.lock().await;
    let owner = playback_owner()?;
    let host = super::super::host::AppHost {
        owner: owner.clone(),
        attempt: recovery::Attempt::new(owner.clone()),
    };
    let tag = voice_call_media::Tag {
        response: "reply".into(),
        item: "audio".into(),
        index: 0,
    };
    host.render(&tag, &[1000; voice::FRAME])?;
    owner.close();
    host.render(&tag, &[2000; voice::FRAME])?;
    assert_eq!(owner.output.lock().read(&mut [0; voice::FRAME]), 0);
    Ok(())
}

#[tokio::test]
async fn live_listening_requires_session_confirmation_devices_and_fresh_uploaded_audio()
-> Result<(), Box<dyn std::error::Error>> {
    let _device_audio = DEVICE_AUDIO_TEST.lock().await;
    for session_first in [false, true] {
        let mut owner = starting_owner()?;
        Arc::get_mut(&mut owner)
            .ok_or("Owner unexpectedly shared")?
            .live = true;
        voice::webrtc::devices_started(&owner);
        if session_first {
            owner.view.lock().startup.settings_confirmed = Some(10);
        }
        voice::webrtc::media_connected(&owner);
        assert_eq!(owner.view.lock().phase, "starting");
        if !session_first {
            assert!(!owner.ready.load(Ordering::Acquire));
            assert!(owner.capture(
                &[111; voice::FRAME],
                owner.input.generation(),
                Instant::now()
            ));
            assert_eq!(owner.input.diagnostics().0, 0);
            owner.view.lock().startup.settings_confirmed = Some(20);
            voice::webrtc::media_connected(&owner);
        }
        assert!(owner.ready.load(Ordering::Acquire));
        assert_eq!(owner.view.lock().phase, "starting");
        assert!(owner.capture(
            &[222; voice::FRAME],
            owner.input.generation(),
            Instant::now()
        ));
        let mut packet = ::audio_ingress::Packet::new(voice::FRAME * 4);
        tokio::time::timeout(Duration::from_secs(1), owner.next_capture(&mut packet)).await??;
        assert_eq!(packet.samples, [222; voice::FRAME]);
        voice::webrtc::input_started(&owner);
        assert_eq!(owner.view.lock().phase, "listening");
    }
    Ok(())
}

#[tokio::test]
async fn early_microphone_discards_startup_audio_and_accepts_fresh_audio_in_either_startup_order()
-> Result<(), Box<dyn std::error::Error>> {
    let _device_audio = DEVICE_AUDIO_TEST.lock().await;
    for devices_first in [true, false] {
        let owner = starting_owner()?;
        if devices_first {
            voice::webrtc::devices_started(&owner);
        } else {
            voice::webrtc::media_connected(&owner);
        }
        assert_eq!(owner.view.lock().phase, "starting");
        assert!(owner.capture(
            &[111; voice::FRAME],
            owner.input.generation(),
            Instant::now()
        ));
        assert_eq!(owner.input.diagnostics().0, 0);

        if devices_first {
            voice::webrtc::media_connected(&owner);
        } else {
            voice::webrtc::devices_started(&owner);
        }
        // Listening still requires a packet actually sent, not merely an open mic.
        assert_eq!(owner.view.lock().phase, "starting");
        assert!(owner.capture(
            &[222; voice::FRAME],
            owner.input.generation(),
            Instant::now()
        ));
        let mut packet = ::audio_ingress::Packet::new(voice::FRAME * 4);
        tokio::time::timeout(Duration::from_secs(1), owner.next_capture(&mut packet)).await??;
        assert_eq!(packet.samples, [222; voice::FRAME]);
        voice::webrtc::input_started(&owner);
        assert_eq!(owner.view.lock().phase, "listening");
    }
    Ok(())
}

#[test]
fn early_device_completion_preserves_mute_and_cannot_reopen_a_closed_call()
-> Result<(), Box<dyn std::error::Error>> {
    let _device_audio = DEVICE_AUDIO_TEST.blocking_lock();
    let owner = starting_owner()?;
    owner.view.lock().muted = true;
    owner.input.set_muted(true);
    voice::webrtc::devices_started(&owner);
    voice::webrtc::media_connected(&owner);
    assert_eq!(owner.view.lock().phase, "muted");
    assert!(owner.capture(
        &[111; voice::FRAME],
        owner.input.generation(),
        Instant::now()
    ));
    assert_eq!(owner.input.diagnostics().0, 0);

    owner.close();
    voice::webrtc::media_connected(&owner);
    voice::webrtc::devices_started(&owner);
    assert_eq!(owner.view.lock().phase, "closed");
    assert!(!owner.view.lock().media_ready);
    assert!(!owner.capture(
        &[222; voice::FRAME],
        owner.input.generation(),
        Instant::now()
    ));
    Ok(())
}

fn authorized_credential() -> Result<NativeCredential, Box<dyn std::error::Error>> {
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
    Ok(credential)
}

#[tokio::test]
async fn local_cue_keeps_microphone_live_without_advancing_assistant_playback()
-> Result<(), Box<dyn std::error::Error>> {
    let _device_audio = DEVICE_AUDIO_TEST.lock().await;
    let owner = playback_owner()?;
    let generation = owner.input.generation();
    let cue = owner.cue.lock().begin();
    assert!(owner.cue.lock().load(cue, vec![2000; voice::FRAME * 2]));
    let input = [1000; voice::FRAME];
    owner.capture(&input, generation, Instant::now());
    let mut packet = ::audio_ingress::Packet::new(voice::FRAME * 4);
    tokio::time::timeout(Duration::from_secs(1), owner.next_capture(&mut packet)).await??;
    assert_eq!(packet.samples, input);
    assert_eq!(owner.input.generation(), generation);

    let mut rendered = [0; voice::FRAME];
    let epoch = {
        let mut output = owner.output.lock();
        assert_eq!(output.read(&mut rendered), 0);
        output.epoch
    };
    owner.cue.lock().mix(&mut rendered);
    assert_eq!(rendered, [1000; voice::FRAME]);
    let mut echo = voice::echo::MediaEchoCanceller::new()?;
    echo.render(epoch, &rendered, false, 0)?;
    assert_eq!(echo.played(epoch, voice::FRAME), 0);
    assert_eq!(owner.output.lock().delivered, 0);
    owner.close();
    assert!(!owner.cue.lock().playing(cue));
    Ok(())
}

/// Explicitly billable: exercise the full application actor beyond its heartbeat deadline.
// Native audio callbacks run independently of network/DSP work in the app.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicitly authorized OPENAI_API_KEY and network access"]
async fn public_live_call_survives_a_minute_with_native_playback()
-> Result<(), Box<dyn std::error::Error>> {
    full_live_playback(false, TestAudio::Normal, Duration::from_secs(65)).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicitly authorized OPENAI_API_KEY and network access"]
async fn public_locally_prepared_live_call_survives_a_minute_with_native_playback()
-> Result<(), Box<dyn std::error::Error>> {
    full_live_playback(true, TestAudio::Normal, Duration::from_secs(65)).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicitly authorized OPENAI_API_KEY and network access"]
async fn public_live_opening_word_without_echo_processing() -> Result<(), Box<dyn std::error::Error>>
{
    full_live_playback(true, TestAudio::WithoutEcho, Duration::from_secs(15)).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicitly authorized OPENAI_API_KEY and network access"]
async fn public_live_opening_word_without_ready_cue() -> Result<(), Box<dyn std::error::Error>> {
    full_live_playback(true, TestAudio::WithoutCue, Duration::from_secs(15)).await
}

enum TestAudio {
    Normal,
    WithoutEcho,
    WithoutCue,
}

async fn full_live_playback(
    prepared: bool,
    audio: TestAudio,
    duration: Duration,
) -> Result<(), Box<dyn std::error::Error>> {
    let software_echo = !matches!(audio, TestAudio::WithoutEcho);
    let play_cue = !matches!(audio, TestAudio::WithoutCue);
    let _storage = test_storage().await?;
    if prepared {
        assert!(voice::webrtc::prepared::configure(true));
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    let credential = authorized_credential()?;
    let config: voice::Config =
        serde_json::from_value(json!({"live":true,"webrtc":true,"voice":"quartz","global":true}))?;
    let input =
        std::fs::read(std::env::var_os("WHIP_LIVE_SMOKE_PCM").ok_or("Synthetic PCM required")?)?;
    let input = input
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(i16::from_le_bytes)
        .collect::<Vec<_>>();
    let mut owner = starting_owner()?;
    Arc::get_mut(&mut owner)
        .ok_or("Owner unexpectedly shared")?
        .live = true;
    // Model Android/iOS acquiring the microphone before the API exchange.
    voice::webrtc::devices_started(&owner);
    owner.output.lock().live_transcript = Some(voice::live::captions::Transcript::default());
    if software_echo {
        *owner.echo.lock() = Some(voice::echo::MediaEchoCanceller::new()?);
    }
    let mut device_clock = (!software_echo)
        .then(voice::echo::MediaEchoCanceller::new)
        .transpose()?
        .map(Box::new);
    let (commands, command_rx) = tokio::sync::mpsc::channel(8);
    let worker = tokio::spawn(voice::live::LiveVoiceAdapter::run(
        owner.clone(),
        config,
        credential,
        None,
        command_rx,
    ));
    let started = Instant::now();
    let mut ready_at = None;
    let mut offset = 0;
    let mut peak = 0_u16;
    let mut highlighted = false;
    let mut device_epoch = 0;
    let mut device_position = 0;
    let mut cue_samples = if play_cue {
        Some(voice::cue::load(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../assets/audio/voice-ready.wav"
        ))?)
    } else {
        None
    };
    let mut local_cue = 0;
    let mut captured_during_cue = false;
    let mut rendered_cue = false;
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    while ready_at.is_none_or(|at: Instant| at.elapsed() < duration) && !worker.is_finished() {
        tick.tick().await;
        if started.elapsed() > Duration::from_secs(100) {
            break;
        }
        if ready_at.is_none() && owner.view.lock().phase == "listening" {
            let view = owner.view.lock();
            assert_eq!(view.startup.prepared_client, prepared);
            assert!(view.startup.settings_confirmed.is_some());
            assert!(view.startup.first_input.is_some());
            drop(view);
            ready_at = Some(Instant::now());
            eprintln!("Full Live media ready_ms={}", startup::elapsed(started));
        }
        let mut pcm = [0_i16; voice::FRAME];
        if ready_at.is_some()
            && let Some(samples) = cue_samples.take()
        {
            local_cue = owner.cue.lock().begin();
            assert!(owner.cue.lock().load(local_cue, samples));
        }
        if ready_at.is_some() {
            let count = pcm.len().min(input.len().saturating_sub(offset));
            pcm[..count].copy_from_slice(&input[offset..offset + count]);
            offset += count;
            captured_during_cue |= count > 0 && owner.cue.lock().playing(local_cue);
        }
        owner.capture(&pcm, owner.input.generation(), Instant::now());
        let mut output = owner.output.lock();
        let count = output.read(&mut pcm);
        peak = pcm[..count]
            .iter()
            .map(|sample| sample.unsigned_abs())
            .max()
            .unwrap_or(0)
            .max(peak);
        // Mirror JNI: classify provider speech before mixing the local cue.
        // Only the original provider count advances transcript playback.
        if count == 0 {
            pcm.fill(0);
        }
        let provider = pcm[..if count == 0 { voice::FRAME } else { count }].to_vec();
        owner
            .cue
            .lock()
            .mix(&mut pcm[..if count == 0 { voice::FRAME } else { count }]);
        rendered_cue |= owner.cue.lock().playing(local_cue)
            && pcm.iter().any(|sample| sample.unsigned_abs() >= 64);
        let epoch = output.epoch;
        let rendered = if count == 0 { voice::FRAME } else { count };
        if device_epoch != epoch {
            device_epoch = epoch;
            device_position = 0;
        }
        device_position += rendered;
        {
            let mut echo = owner.echo.lock();
            if let Some(echo) = echo.as_mut().or(device_clock.as_deref_mut()) {
                echo.queue_reference(&provider)?;
                echo.render(epoch, &pcm[..rendered], count > 0, 40_000_000)?;
                output.acknowledge(epoch, echo.played(epoch, device_position));
            }
        }
        highlighted |= output.live_transcript.as_ref().is_some_and(|transcript| {
            transcript.messages().as_array().is_some_and(|messages| {
                messages.iter().any(|message| {
                    message["role"] == "assistant"
                        && message["spokenUtf16"]
                            .as_u64()
                            .is_some_and(|spoken| spoken > 0)
                })
            })
        });
    }
    owner.close();
    drop(commands);
    let result = tokio::time::timeout(Duration::from_secs(10), worker).await??;
    let media = owner.media.lock().take();
    let cleanup = if let Some(media) = media {
        media.close().await
    } else {
        Ok(())
    };
    let view = owner.view.lock();
    eprintln!(
        "Full Live call: elapsed_ms={} active_ms={} peak={peak} result={result:?} cleanup={cleanup:?} cue_overlap={captured_during_cue} cue_rendered={rendered_cue} input_samples={offset} media={} uploaded={} caption_events={} server_events={} finalized={} phase={} error={:?}",
        startup::elapsed(started),
        ready_at.map_or(0, startup::elapsed),
        serde_json::to_string(&view.media)?,
        view.uploaded_packets,
        view.caption_events,
        view.server_events,
        view.usage_finalized,
        view.phase,
        view.error
    );
    let reliable = view.media.reliable_rtp_packets == view.media.rtp_packets;
    let late_packets = view.media.late_packets;
    let phase = view.phase;
    let error = view.error;
    drop(view);
    result?;
    assert_ne!(phase, "error", "Native call failed: {error:?}");
    assert!(
        ready_at.is_some_and(|at| at.elapsed() >= duration),
        "Call ended before its heartbeat deadline"
    );
    assert!(peak >= 512, "No audible native playback");
    assert!(highlighted, "Captions did not follow acknowledged audio");
    if play_cue {
        assert!(
            captured_during_cue && rendered_cue,
            "Microphone did not remain live through the local cue"
        );
    }
    if reliable {
        assert_eq!(late_packets, 0, "Reliable media lost received speech");
    }
    cleanup?;
    check_first_word(&owner)
}

async fn test_storage() -> Result<tempfile::TempDir, Box<dyn std::error::Error>> {
    let directory = tempfile::tempdir()?;
    let path = std::ffi::CString::new(directory.path().to_string_lossy().as_bytes())?;
    // SAFETY: this test owns the live NUL-terminated path for this call.
    unsafe {
        crate::app_database::whip_set_app_data_directory(path.as_ptr());
    }
    crate::app_database::import_legacy_app_data(Vec::new()).await?;
    Ok(directory)
}

fn check_first_word(owner: &RealtimeVoiceAdapter) -> Result<(), Box<dyn std::error::Error>> {
    if let Ok(word) = std::env::var("WHIP_LIVE_SMOKE_FIRST_WORD") {
        let input_recognized =
            owner
                .output
                .lock()
                .live_transcript
                .as_ref()
                .is_some_and(|transcript| {
                    transcript.messages().as_array().is_some_and(|messages| {
                        messages.iter().any(|message| {
                            message["role"] == "user"
                                && message["text"].as_str().is_some_and(|text| {
                                    text.to_lowercase().contains(&word.to_lowercase())
                                })
                        })
                    })
                });
        eprintln!(
            "Expected synthetic first word in input transcript: {input_recognized}; capture={:?}; signal={}",
            owner.input.diagnostics(),
            serde_json::to_string(
                &owner
                    .echo
                    .lock()
                    .as_ref()
                    .map(voice::echo::MediaEchoCanceller::diagnostics)
            )?
        );
        let recognized = owner
            .output
            .lock()
            .live_transcript
            .as_ref()
            .is_some_and(|transcript| {
                transcript.messages().as_array().is_some_and(|messages| {
                    messages.iter().any(|message| {
                        message["role"] == "assistant"
                            && message["text"].as_str().is_some_and(|text| {
                                text.to_lowercase().contains(&word.to_lowercase())
                            })
                    })
                })
            });
        eprintln!("Immediate first word recognized with ready cue: {recognized}");
        assert!(
            recognized,
            "The assistant did not recognize the initial word"
        );
    }
    Ok(())
}

/// Explicitly billable: verify sideband-only events still identify native RTP audio.
#[tokio::test]
#[ignore = "requires explicitly authorized OPENAI_API_KEY and network access"]
#[allow(
    clippy::significant_drop_tightening,
    reason = "The negotiated peer moves into the media task"
)]
async fn public_realtime_sideband_identifies_native_playback()
-> Result<(), Box<dyn std::error::Error>> {
    let credential = authorized_credential()?;
    let config: voice::Config = serde_json::from_value(
        json!({"webrtc":true,"voice":"cedar","global":true,"vad":{"type":"server_vad","threshold":0.5,"prefix_padding_ms":300,"silence_duration_ms":500}}),
    )?;
    let mut session = super::super::initial_session(config.session_update()?, config.model()?)?;
    session["instructions"] =
        json!("When greeted, say exactly: The synthetic WebRTC test passed. Then remain quiet.");
    session["tools"] = json!([]);
    session["tool_choice"] = json!("none");
    let mut peer = Transport::configured(voice_openai::media::transport_config()).await?;
    let call = api::Call::create(&credential, peer.offer(), session).await?;
    let request = voice::authorized_request(
        &credential,
        &format!("wss://api.openai.com/v1/realtime?call_id={}", call.id),
    )?;
    let (mut sideband, connected) = tokio::try_join!(
        async {
            voice::connect_request(request)
                .await
                .map_err(|error| error.message)
        },
        peer.apply_answer(call.answer.clone())
    )?;
    drop(credential);
    assert_eq!(connected, AnswerOutcome::Ready);
    let input =
        std::fs::read(std::env::var_os("WHIP_LIVE_SMOKE_PCM").ok_or("Synthetic PCM required")?)?;
    let input = input
        .as_chunks::<2>()
        .0
        .iter()
        .copied()
        .map(i16::from_le_bytes)
        .collect::<Vec<_>>();
    let owner = playback_owner()?;
    let identity = Arc::new(Mutex::new(Identity::default()));
    let media_identity = identity.clone();
    let (stop, stopped) = watch::channel(false);
    let attempt = recovery::Attempt::new(owner.clone());
    attempt.activate().map_err(|failure| failure.message)?;
    let media_owner = owner.clone();
    let media = tokio::spawn(async move {
        let result = media::run(&media_owner, &mut peer, media_identity, stopped, &attempt).await;
        peer.close().await?;
        result
    });
    let started = Instant::now();
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut offset = 0;
    let mut peak = 0_u16;
    let mut began = 0;
    let mut ended = 0;
    let mut buffered_boundary = false;
    let mut playback_ticks = 0_u32;
    let result = async {
        loop {
            tokio::select! {
                event = socket::next_sideband_event(&mut sideband) => {
                    let Message::Text(text) = event? else { continue; };
                    let event: Value = serde_json::from_str(&text)?;
                    identity.lock().observe(&event);
                    if event["type"] == "output_audio_buffer.started" {
                        let output = owner.output.lock();
                        buffered_boundary |= began > 0 && output.generated > output.played;
                        began += 1;
                    }
                    if event["type"] == "output_audio_buffer.stopped" {
                        ended += 1;
                        if ended < 3 {
                            sideband.send(Message::Text(json!({"type":"conversation.item.create","item":{"type":"message","role":"user","content":[{"type":"input_text","text":"Repeat the same test sentence."}]}}).to_string().into())).await?;
                            sideband.send(Message::Text(json!({"type":"response.create"}).to_string().into())).await?;
                        }
                    }
                    if event["type"] == "error" { return Err("Synthetic Realtime call rejected".into()); }
                }
                _ = tick.tick() => {
                    if started.elapsed() > Duration::from_secs(45) { return Err("Sideband playback deadline exceeded".into()); }
                    let mut pcm = [0_i16; voice::FRAME];
                    if started.elapsed() > Duration::from_secs(3) {
                        let count = pcm.len().min(input.len().saturating_sub(offset));
                        pcm[..count].copy_from_slice(&input[offset..offset+count]);
                        offset += count;
                    }
                    owner.capture(&pcm, owner.input.generation(), Instant::now());
                    playback_ticks += 1;
                    // A slow first device keeps real audio buffered when the
                    // next response starts; subsequent playback catches up.
                    if began < 2 && !playback_ticks.is_multiple_of(5) { continue; }
                    let mut output = owner.output.lock();
                    let count = output.read(&mut pcm);
                    peak = pcm[..count].iter().map(|sample| sample.unsigned_abs()).max().unwrap_or(0).max(peak);
                    let epoch = output.epoch;
                    let delivered = output.delivered;
                    output.acknowledge(epoch, delivered);
                    let drained = output.played == output.generated;
                    drop(output);
                    if media.is_finished() { return Err("Synthetic Realtime media ended".into()); }
                    if began >= 3 && ended >= 3 && drained && peak >= 512 { break; }
                }
            }
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    }.await;
    stop.send_replace(true);
    let retired = call.hangup().await;
    let drained = media.await?;
    let _ = sideband.close(None).await;
    eprintln!(
        "Realtime sideband: started={began} stopped={ended} buffered_boundary={buffered_boundary} peak={peak}"
    );
    retired?;
    drained?;
    result?;
    assert!(
        buffered_boundary,
        "Replies did not exercise buffered device audio"
    );
    Ok(())
}
