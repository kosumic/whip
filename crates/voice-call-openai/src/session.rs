//! Caller-driven voice sessions. The serialized driver owns wire decoding,
//! capture pacing, turn state, mute acknowledgements and interruption gates.
//! Applications observe typed events and execute their own tools asynchronously.
mod call;
mod live;
mod realtime;
pub use call::{Call, Config, Transport};

use crate::{ClientEvent, RealtimeSocket, ServerEvent};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures::StreamExt;
use std::{future::Future, time::Duration};
use voice_call_media::{Capture, FRAME, capture_worker};

pub use live::{Live, LiveConfig};
pub use realtime::{Realtime, RealtimeConfig};

pub type Result<T = ()> = std::result::Result<T, &'static str>;

/// Native audio and cancellation policy. Mute must invalidate the capture
/// generation even for a rapid mute/unmute; render must enforce bounded playback.
pub trait Audio: Capture {
    fn current(&self) -> bool;
    fn is_muted(&self) -> bool;
    fn credentials_current(&self) -> bool {
        true
    }
    fn set_muted(&self, muted: bool) -> Result;
    fn interrupt(&self) -> Option<ClientEvent>;
    fn render_pcm(&self, item: String, index: u32, pcm: Vec<u8>) -> Result;
    fn cancel_audio(&self, response: Option<&str>);
    fn resume_live_audio(&self);
    fn confirm_live_closed(&self);
    fn uploaded(&self);
}

#[expect(
    clippy::large_enum_variant,
    reason = "The serialized driver processes one wire event at a time without boxing every caption or audio event."
)]
pub enum Event {
    Realtime(ServerEvent),
    Live(oai_rt_rs::live::ServerFrame),
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    Stop,
}

/// Application work is separate from provider receive/capture work. next_work
/// must be cancellation safe (e.g. channel receive or JoinSet::join_next).
/// Callbacks must return promptly; spawn slow tools on the existing runtime and
/// return their completion through next_work so microphone/control work continues.
pub trait Delegate: Send {
    type Work: Send;
    fn next_work(&mut self) -> impl Future<Output = Option<Self::Work>> + Send;
    fn work(
        &mut self,
        session: &mut Session<'_>,
        work: Self::Work,
    ) -> impl Future<Output = Result<Flow>> + Send;
    fn event(
        &mut self,
        session: &mut Session<'_>,
        event: Event,
    ) -> impl Future<Output = Result<Flow>> + Send;
    /// Accounting-only callbacks during shutdown. Never dispatch application work.
    fn usage(&mut self, _event: &ServerEvent) {}
    fn live_usage(&mut self, _seconds: f64, _finalized: bool) {}
    fn tick(&mut self, session: &mut Session<'_>) -> impl Future<Output = Result<Flow>> + Send {
        async {
            session.continue_response().await?;
            Ok(Flow::Continue)
        }
    }
}

pub enum Protocol {
    Realtime(Realtime),
    Live(Live),
}

/// A borrowed transport lets applications retain accounting ownership after
/// cancellation. Call supplies the owning convenience API for other apps.
pub struct Session<'a> {
    pub socket: &'a mut RealtimeSocket,
    pub protocol: Protocol,
    pub webrtc: bool,
    prefix: String,
    capture_reset: bool,
    media: Option<&'a crate::Handle>,
    capture_gate: Option<&'a std::sync::atomic::AtomicBool>,
}

impl<'a> Session<'a> {
    pub fn realtime(socket: &'a mut RealtimeSocket, config: RealtimeConfig, webrtc: bool) -> Self {
        Self {
            socket,
            protocol: Protocol::Realtime(Realtime::new(config)),
            webrtc,
            prefix: crate::EVENT_PREFIX.into(),
            capture_reset: false,
            media: None,
            capture_gate: None,
        }
    }
    pub fn live(socket: &'a mut RealtimeSocket, config: LiveConfig, webrtc: bool) -> Self {
        Self {
            socket,
            protocol: Protocol::Live(Live::new(config)),
            webrtc,
            prefix: crate::live::EVENT_PREFIX.into(),
            capture_reset: false,
            media: None,
            capture_gate: None,
        }
    }
    pub fn with_prefix(mut self, prefix: &str) -> Self {
        self.prefix = prefix.into();
        self
    }
    /// The host owns proactive retirement and replacement. Startup validation
    /// remains enforced; the legacy 55-minute shutdown must not win after sleep.
    pub fn with_managed_lifetime(mut self) -> Self {
        if let Protocol::Realtime(state) = &mut self.protocol {
            state.managed_lifetime = true;
        }
        self
    }
    pub fn realtime_state(&mut self) -> Result<&mut Realtime> {
        match &mut self.protocol {
            Protocol::Realtime(state) => Ok(state),
            _ => Err("Not a Realtime session."),
        }
    }
    pub fn live_state(&mut self) -> Result<&mut Live> {
        match &mut self.protocol {
            Protocol::Live(state) => Ok(state),
            _ => Err("Not a GPT-Live session."),
        }
    }
    pub async fn send(&mut self, event: ClientEvent) -> Result {
        if !matches!(self.protocol, Protocol::Realtime(_)) {
            return Err("Not a Realtime session.");
        }
        crate::events::send_with_prefix(self.socket, event, &self.prefix).await
    }
    pub async fn send_live(&mut self, command: oai_rt_rs::live::Command) -> Result<String> {
        if !matches!(self.protocol, Protocol::Live(_)) {
            return Err("Not a GPT-Live session.");
        }
        crate::live::send_with_prefix(self.socket, command, &self.prefix).await
    }
    pub async fn continue_response(&mut self) -> Result {
        if !self.ready() {
            return Ok(());
        }
        if let Protocol::Realtime(state) = &mut self.protocol
            && state.responses.can_create()
        {
            state.responses.mark_requested();
            self.send(crate::typed(serde_json::json!({"type":"response.create"}))?)
                .await?;
        }
        Ok(())
    }
    /// Realtime creates a user turn; Live appends session-wide factual context.
    /// Backend Responses inputs and tool results use explicit typed Live commands.
    pub async fn send_text(&mut self, text: &str) -> Result {
        if !self.ready() {
            return Err("Voice session is not ready.");
        }
        if text.trim().is_empty() || text.len() > crate::tools::MAX_ARGUMENT_BYTES {
            return Err("Invalid voice text input.");
        }
        match &mut self.protocol {
            Protocol::Realtime(state) => {
                state.responses.request_create();
                self.send(crate::typed(
                    serde_json::json!({"type":"conversation.item.create","item":{
                        "type":"message","role":"user","content":[{"type":"input_text","text":text}]
                    }}),
                )?)
                .await
            }
            Protocol::Live(_) => self.append_context(None, text, Context::Thinking).await,
        }
    }
    pub async fn tool_result(&mut self, call_id: String, value: serde_json::Value) -> Result {
        self.realtime_state()?.responses.request_create();
        self.send(crate::tools::function_output(call_id, value))
            .await
    }
    pub async fn mute(&mut self, audio: &impl Audio, muted: bool) -> Result {
        self.capture_reset = true;
        match &mut self.protocol {
            Protocol::Realtime(state) => {
                audio.set_muted(muted)?;
                state.responses.clear_input();
                self.send(ClientEvent::InputAudioBufferClear { event_id: None })
                    .await
            }
            Protocol::Live(_) => {
                // Both directions close capture until the matching acknowledgement.
                audio.set_muted(true)?;
                let id = self
                    .send_live(if muted {
                        oai_rt_rs::live::Command::InputAudioMute
                    } else {
                        oai_rt_rs::live::Command::InputAudioUnmute
                    })
                    .await?;
                self.live_state()?.control.muted = Some((id, muted, std::time::Instant::now()));
                Ok(())
            }
        }
    }
    pub async fn interrupt(&mut self, audio: &impl Audio) -> Result {
        match &mut self.protocol {
            Protocol::Realtime(state) => {
                let active = state.responses.active().cloned();
                if let Some(media) = self.media {
                    media.cancel_audio(active.as_deref());
                }
                audio.cancel_audio(active.as_deref());
                if let Some(id) = active {
                    state.ignore(id.clone())?;
                    self.send(ClientEvent::ResponseCancel {
                        event_id: None,
                        response_id: Some(id),
                    })
                    .await?;
                }
                let truncated = audio.interrupt();
                if self.webrtc {
                    self.send(ClientEvent::OutputAudioBufferClear { event_id: None })
                        .await?;
                } else if let Some(event) = truncated {
                    self.send(event).await?;
                }
            }
            Protocol::Live(state) => {
                if let Some(media) = self.media {
                    media.cancel_audio(None);
                }
                state
                    .control
                    .interrupted(state.started.elapsed().as_secs_f64() * 1000.0);
                audio.cancel_audio(None);
                let _ = audio.interrupt();
                self.append_context(
                    None,
                    "The user interrupted your spoken reply. Stop speaking now and listen.",
                    Context::Instructions,
                )
                .await?;
            }
        }
        Ok(())
    }
    pub async fn append_context(
        &mut self,
        id: Option<&str>,
        text: &str,
        channel: Context,
    ) -> Result {
        if !matches!(self.protocol, Protocol::Live(_)) {
            return Err("Not a GPT-Live session.");
        }
        crate::live::commands::append_context_with_prefix(
            self.socket,
            id,
            text,
            channel,
            &self.prefix,
        )
        .await
    }
    /// Retain only the Live event stream for final accounting, never tools/audio.
    pub async fn finish_live(
        &mut self,
        credentials_current: impl Fn() -> bool + Sync,
        mut usage: impl FnMut(f64, bool) -> Result + Send,
    ) -> Result {
        if self.live_state()?.usage.finalized {
            let state = self.live_state()?;
            usage(state.usage.seconds, true)?;
            return Ok(());
        }
        let finish = async {
            if !credentials_current() {
                return Err("Voice credentials were revoked.");
            }
            self.send_live(oai_rt_rs::live::Command::Close).await?;
            loop {
                let message = self.socket.next().await;
                let Some(text) = self.socket.receive_text(message).await? else {
                    continue;
                };
                let frame = crate::live::codec()
                    .decode_server(&text)
                    .map_err(|_| "GPT-Live final usage is unavailable.")?;
                let state = self.live_state()?;
                match frame.event {
                    oai_rt_rs::live::ServerEvent::Closed {
                        session,
                        reason,
                        usage: reported,
                        ..
                    } => {
                        state.pin_session(&session)?;
                        state.usage.observe(
                            reported.seconds,
                            reason != oai_rt_rs::live::CloseReason::ConnectionLost,
                        )?;
                        usage(state.usage.seconds, state.usage.finalized)?;
                        return if state.usage.finalized {
                            Ok(())
                        } else {
                            Err("GPT-Live final usage is unavailable.")
                        };
                    }
                    oai_rt_rs::live::ServerEvent::UsageUpdated {
                        usage: reported, ..
                    } => {
                        state.usage.observe(reported.seconds, false)?;
                        usage(state.usage.seconds, false)?;
                    }
                    _ => {}
                }
            }
        };
        let revoked = async {
            loop {
                if !credentials_current() {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        tokio::select! { biased;
            () = revoked => Err("Voice credentials were revoked."),
            result = tokio::time::timeout(LIVE_CLOSE_TIMEOUT, finish) => result.map_err(|_| "GPT-Live final usage timed out.")?,
        }
    }

    /// The only session receive/capture loop, shared by Whip and standalone apps.
    /// No established session or uncertain tool/call creation is automatically replayed.
    pub async fn drive(&mut self, audio: &impl Audio, delegate: &mut impl Delegate) -> Result {
        let period = if matches!(self.protocol, Protocol::Realtime(_)) {
            Duration::from_millis(250)
        } else {
            capture_worker::PACKET_DURATION
        };
        let mut tick = tokio::time::interval(period);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut capture = audio_ingress::Packet::new(audio.packet_samples());
        let mut pending = capture_worker::Pending::new(audio);
        loop {
            if !audio.credentials_current() {
                return Err("Voice credentials were revoked.");
            }
            if !audio.current() {
                return Ok(());
            }
            if self.capture_reset {
                pending.reset(audio)?;
                self.capture_reset = false;
            }
            if !self.webrtc {
                pending.refresh(audio)?;
            }
            tokio::select! {
                biased;
                work = delegate.next_work() => {
                    let Some(work) = work else { return Ok(()); };
                    if delegate.work(self, work).await? == Flow::Stop { return Ok(()); }
                }
                _ = tick.tick() => {
                    match &self.protocol {
                        Protocol::Realtime(state) => state.check_deadline()?,
                        Protocol::Live(state) => state.check_deadline()?,
                    }
                    if delegate.tick(self).await? == Flow::Stop { return Ok(()); }
                    if !self.webrtc && let Protocol::Live(state) = &self.protocol
                        && state.control.started {
                        let samples = pending.take().filter(|frame| frame.current(audio))
                            .map_or([0; FRAME], |frame| frame.samples);
                        self.upload(audio, &samples).await?;
                    }
                }
                message = self.socket.next() => {
                    let Some(text) = self.socket.receive_text(message).await? else { continue; };
                    let was_ready = self.ready();
                    let event = match &mut self.protocol {
                        Protocol::Realtime(state) => state.receive(&text, self.webrtc, audio, &self.prefix)?,
                        Protocol::Live(state) => state.receive(&text, self.webrtc, audio)?,
                    };
                    if !was_ready && self.ready() {
                        // Discard microphone PCM retained before negotiation.
                        let muted = audio.is_muted();
                        audio.set_muted(true)?;
                        audio.set_muted(muted)?;
                        pending.reset(audio)?;
                    }
                    if let Some(gate) = self.capture_gate {
                        gate.store(self.ready(), std::sync::atomic::Ordering::Release);
                    }
                    if let Some(event) = event {
                        let failed = matches!(&event, Event::Realtime(ServerEvent::ResponseDone { response, .. } | ServerEvent::ResponseCancelled { response, .. }) if response.status == oai_rt_rs::ResponseStatus::Failed);
                        let closed = matches!(&event, Event::Live(frame) if matches!(frame.event, oai_rt_rs::live::ServerEvent::Closed { .. }));
                        // Truncation follows the device's played position, not received PCM.
                        if !self.webrtc && let Protocol::Realtime(state) = &mut self.protocol
                            && let Some(event) = state.truncate.take() { self.send(event).await?; }
                        if delegate.event(self, event).await? == Flow::Stop { return Ok(()); }
                        if failed { return Err("OpenAI could not generate a response. Check quota and model access."); }
                        if closed { return if self.live_state()?.usage.finalized { Ok(()) } else { Err("GPT-Live disconnected before final usage was confirmed.") }; }
                    }
                }
                _ = tokio::task::yield_now(), if !self.webrtc && pending.ready() && matches!(self.protocol, Protocol::Realtime(_)) => {
                    pending.refresh(audio)?;
                    if let Some(frame) = pending.take() && frame.current(audio) { self.upload(audio, &frame.samples).await?; }
                }
                packet = audio.next_capture(&mut capture), if !self.webrtc && !pending.ready() && audio.capture_enabled() && self.ready() => {
                    if packet? { pending.reset(audio)?; }
                    pending.refresh(audio)?;
                    audio.process_capture(&mut capture)?;
                    pending.push(&capture)?;
                }
            }
        }
    }
    pub fn ready(&self) -> bool {
        match &self.protocol {
            Protocol::Realtime(state) => state.settings.is_confirmed(),
            Protocol::Live(state) => state.control.started,
        }
    }
    async fn upload(&mut self, audio: &impl Audio, samples: &[i16]) -> Result {
        let bytes: Vec<_> = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        let encoded = STANDARD.encode(bytes);
        match self.protocol {
            Protocol::Realtime(_) => {
                tokio::time::timeout(
                    capture_worker::SEND_TIMEOUT,
                    self.send(ClientEvent::InputAudioBufferAppend {
                        event_id: None,
                        audio: encoded,
                    }),
                )
                .await
                .map_err(|_| "Realtime audio upload timed out.")??;
            }
            Protocol::Live(_) => {
                self.send_live(oai_rt_rs::live::Command::InputAudioAppend { audio: encoded })
                    .await?;
            }
        }
        audio.uploaded();
        Ok(())
    }
}

pub use crate::live::commands::Context;

pub use crate::live::CLOSE_TIMEOUT as LIVE_CLOSE_TIMEOUT;
