//! Owning convenience API over the same Session driver used by Whip.
use super::{Audio, Delegate, LiveConfig, Protocol, RealtimeConfig, Result, Session};
use crate::{ClientEvent, Credential, Handle, Host, RealtimeSocket};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub enum Transport {
    WebRtc,
    WebSocket,
}
pub enum Config {
    Realtime {
        settings: RealtimeConfig,
        update: ClientEvent,
    },
    Live {
        session: oai_rt_rs::live::SessionConfig,
    },
}
#[must_use = "Run the call through hangup and bounded cleanup on the host runtime."]
pub struct Call {
    socket: RealtimeSocket,
    protocol: Protocol,
    media: Option<Handle>,
    capture_gate: Arc<AtomicBool>,
}
impl Call {
    /// Uses the caller's existing Tokio runtime and native media adapter. A failed
    /// or established conversation is never silently recreated or replayed.
    pub async fn connect(
        host: Arc<impl Host>,
        key: &impl Credential,
        config: Config,
        transport: Transport,
    ) -> std::result::Result<Self, crate::recovery::Failure> {
        let webrtc = matches!(transport, Transport::WebRtc);
        if !host.current() {
            return Err(crate::recovery::CANCELLED.into());
        }
        let capture_gate = Arc::new(AtomicBool::new(false));
        let host = Arc::new(GatedHost {
            inner: host,
            gate: capture_gate.clone(),
        });
        match config {
            Config::Realtime { settings, update } => {
                crate::validate_model(&settings.model)?;
                let (socket, media) = if webrtc {
                    let (socket, media) =
                        crate::connect_realtime(host.clone(), key, update, &settings.model).await?;
                    (socket, Some(media))
                } else {
                    let raw = crate::connect_raw(
                        key,
                        &format!("wss://api.openai.com/v1/realtime?model={}", settings.model),
                    )
                    .await?;
                    let mut socket = RealtimeSocket::Direct(Box::new(raw));
                    if !host.current() {
                        return Err(crate::recovery::CANCELLED.into());
                    }
                    crate::send(&mut socket, update).await?;
                    (socket, None)
                };
                Ok(Self {
                    socket,
                    media,
                    capture_gate,
                    protocol: Protocol::Realtime(super::Realtime::new(settings)),
                })
            }
            Config::Live { session } => {
                let voice = session
                    .audio
                    .as_ref()
                    .and_then(|audio| audio.output.as_ref())
                    .and_then(|output| output.voice.as_ref());
                let Some(oai_rt_rs::live::Voice::Named(voice)) = voice else {
                    return Err("Select a GPT-Live voice.".into());
                };
                crate::validate_model(&session.model)?;
                let mut settings = LiveConfig {
                    model: session.model.clone(),
                    voice: voice.clone(),
                    backend_model: None,
                    session_id: None,
                };
                if let oai_rt_rs::live::Field::Value(
                    oai_rt_rs::live::DelegationConfig::Responses { responses },
                ) = &session.delegation
                {
                    settings.backend_model = Some(responses.model.clone());
                }
                let (socket, media) = if webrtc {
                    let (socket, media, id) = crate::connect_live(
                        host.clone(),
                        key,
                        serde_json::to_value(session).map_err(|_| "Invalid GPT-Live session.")?,
                    )
                    .await?;
                    settings.session_id = Some(id);
                    (socket, Some(media))
                } else {
                    let raw = crate::connect_raw(key, crate::live::URL).await?;
                    let mut socket = RealtimeSocket::Direct(Box::new(raw));
                    if !host.current() {
                        return Err(crate::recovery::CANCELLED.into());
                    }
                    crate::live::send(&mut socket, oai_rt_rs::live::Command::Start { session })
                        .await?;
                    (socket, None)
                };
                Ok(Self {
                    socket,
                    media,
                    capture_gate,
                    protocol: Protocol::Live(super::Live::new(settings)),
                })
            }
        }
    }
    /// Run on a caller-provided test/custom transport; no credential or network.
    pub fn from_realtime(socket: RealtimeSocket, config: RealtimeConfig) -> Self {
        Self {
            socket,
            protocol: Protocol::Realtime(super::Realtime::new(config)),
            media: None,
            capture_gate: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn from_live(socket: RealtimeSocket, config: LiveConfig) -> Self {
        Self {
            socket,
            protocol: Protocol::Live(super::Live::new(config)),
            media: None,
            capture_gate: Arc::new(AtomicBool::new(false)),
        }
    }
    /// Run through hangup and bounded final accounting, then retire media. Stop
    /// by returning Flow::Stop (or None from next_work); keep this future alive
    /// until cleanup finishes. Native devices and tool tasks remain app-owned.
    pub async fn run(mut self, audio: &impl Audio, delegate: &mut impl Delegate) -> Result {
        let bridge = MediaAudio {
            audio,
            media: self.media.as_ref(),
        };
        let prefix = if matches!(self.protocol, Protocol::Live(_)) {
            crate::live::EVENT_PREFIX
        } else {
            crate::EVENT_PREFIX
        };
        let mut session = Session {
            socket: &mut self.socket,
            protocol: self.protocol,
            webrtc: self.media.is_some(),
            prefix: prefix.into(),
            capture_reset: false,
            media: self.media.as_ref(),
            capture_gate: Some(&self.capture_gate),
        };
        let result = session.drive(&bridge, delegate).await;
        self.capture_gate.store(false, Ordering::Release);
        let _ = audio.set_muted(true);
        bridge.cancel_audio(None);
        let finalized = match &session.protocol {
            Protocol::Realtime(_) => {
                struct Sink<'a, D>(&'a mut D);
                impl<D: Delegate> crate::shutdown::UsageSink for Sink<'_, D> {
                    fn has_pending_usage(&self) -> bool {
                        true
                    }
                    fn observe(&mut self, event: &crate::ServerEvent) {
                        self.0.usage(event);
                    }
                }
                crate::shutdown::collect(
                    session.socket,
                    &mut Sink(delegate),
                    session.webrtc,
                    || audio.credentials_current(),
                )
                .await;
                Ok(())
            }
            Protocol::Live(_) => {
                let closed = session
                    .finish_live(
                        || audio.credentials_current(),
                        |seconds, finalized| {
                            delegate.live_usage(seconds, finalized);
                            Ok(())
                        },
                    )
                    .await;
                if closed.is_ok() {
                    bridge.confirm_live_closed();
                }
                closed
            }
        };
        use futures::SinkExt;
        let _ = tokio::time::timeout(crate::IO_TIMEOUT, session.socket.close()).await;
        let cleanup = if let Some(media) = self.media {
            media.close().await
        } else {
            Ok(())
        };
        result.and(finalized).and(cleanup)
    }
}

// A call cannot send native capture until effective provider settings arrive.
struct GatedHost<H> {
    inner: Arc<H>,
    gate: Arc<AtomicBool>,
}
impl<H: Host> voice_call_media::Capture for GatedHost<H> {
    fn packet_samples(&self) -> usize {
        self.inner.packet_samples()
    }
    fn generation(&self) -> u64 {
        self.inner.generation()
    }
    fn accepts(&self, generation: u64) -> bool {
        self.inner.accepts(generation)
    }
    fn capture_enabled(&self) -> bool {
        self.gate.load(Ordering::Acquire) && self.inner.capture_enabled()
    }
    fn recover(&self) -> bool {
        self.inner.recover()
    }
    fn reset_capture(&self) -> Result {
        self.inner.reset_capture()
    }
    async fn next_capture(&self, packet: &mut audio_ingress::Packet) -> Result<bool> {
        self.inner.next_capture(packet).await
    }
    fn process_capture(&self, packet: &mut audio_ingress::Packet) -> Result {
        self.inner.process_capture(packet)
    }
}
impl<H: Host> Host for GatedHost<H> {
    fn current(&self) -> bool {
        self.inner.current()
    }
    fn collecting_usage(&self) -> bool {
        self.inner.collecting_usage()
    }
    fn activate(&self) -> std::result::Result<(), crate::recovery::Failure> {
        self.inner.activate()
    }
    fn failure(&self) -> Option<crate::recovery::Failure> {
        self.inner.failure()
    }
    fn fail(&self, error: crate::recovery::Failure) {
        self.inner.fail(error);
    }
    fn retiring(&self) {
        self.inner.retiring();
    }
    fn timing(&self, timing: crate::Timing) {
        self.inner.timing(timing);
    }
    fn render(&self, tag: &voice_call_media::Tag, pcm: &[i16]) -> Result {
        self.inner.render(tag, pcm)
    }
    fn finish_audio(&self, tag: &voice_call_media::Tag) {
        self.inner.finish_audio(tag);
    }
    fn statistics(&self, delta: voice_call_media::Statistics) {
        self.inner.statistics(delta);
    }
    fn uploaded(&self) {
        self.inner.uploaded();
    }
}

struct MediaAudio<'a, A> {
    audio: &'a A,
    media: Option<&'a Handle>,
}
impl<A: Audio> voice_call_media::Capture for MediaAudio<'_, A> {
    fn packet_samples(&self) -> usize {
        self.audio.packet_samples()
    }
    fn generation(&self) -> u64 {
        self.audio.generation()
    }
    fn accepts(&self, generation: u64) -> bool {
        self.audio.accepts(generation)
    }
    fn capture_enabled(&self) -> bool {
        self.audio.capture_enabled()
    }
    fn recover(&self) -> bool {
        self.audio.recover()
    }
    fn reset_capture(&self) -> Result {
        self.audio.reset_capture()
    }
    async fn next_capture(&self, packet: &mut audio_ingress::Packet) -> Result<bool> {
        self.audio.next_capture(packet).await
    }
    fn process_capture(&self, packet: &mut audio_ingress::Packet) -> Result {
        self.audio.process_capture(packet)
    }
}
impl<A: Audio> Audio for MediaAudio<'_, A> {
    fn is_muted(&self) -> bool {
        self.audio.is_muted()
    }
    fn current(&self) -> bool {
        self.audio.current()
    }
    fn credentials_current(&self) -> bool {
        self.audio.credentials_current()
    }
    fn set_muted(&self, muted: bool) -> Result {
        self.audio.set_muted(muted)
    }
    fn interrupt(&self) -> Option<ClientEvent> {
        self.audio.interrupt()
    }
    fn render_pcm(&self, item: String, index: u32, pcm: Vec<u8>) -> Result {
        self.audio.render_pcm(item, index, pcm)
    }
    fn cancel_audio(&self, response: Option<&str>) {
        if let Some(media) = self.media {
            media.cancel_audio(response);
        }
        self.audio.cancel_audio(response);
    }
    fn resume_live_audio(&self) {
        if let Some(media) = self.media {
            media.resume_live_audio();
        }
        self.audio.resume_live_audio();
    }
    fn confirm_live_closed(&self) {
        if let Some(media) = self.media {
            media.confirm_live_closed();
        }
        self.audio.confirm_live_closed();
    }
    fn uploaded(&self) {
        self.audio.uploaded();
    }
}
