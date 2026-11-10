//! OpenAI voice provider on a caller-owned runtime and native audio path.
//! The host supplies credentials, session instructions/tools, PCM and sinks;
//! this crate owns provider signaling, sideband transport and media control.
pub mod captions;
pub mod connection;
pub mod continuity;
pub mod events;
pub mod live;
pub mod models;
pub mod prepared;
pub mod recovery;
pub mod response;
pub mod session;
pub mod settings;
pub mod shutdown;
pub mod socket;
pub mod startup;
pub mod tools;
mod webrtc;
pub mod wire;

pub use connection::{authorized_request, connect_raw, connect_request};
pub use events::{send, send_value};
pub use oai_rt_rs::{ClientEvent, ServerEvent};
pub use session::{Call, Config as CallConfig, Transport as CallTransport};
pub use socket::Socket as RealtimeSocket;
use voice_call_media::{Capture, Statistics, Tag};
pub use webrtc::live::{Call as LiveCall, start as connect_live};
pub use webrtc::{Handle, api, identity, initial_session, media, start as connect_realtime};

pub const MAX_WIRE: usize = 512 * 1024;
pub const IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
pub const EVENT_PREFIX: &str = "voice-call-openai";
pub const DATA_CHANNEL_ID: u16 = 4;

/// Return a temporary authorization value; plaintext is wiped after header creation.
/// Never implement Debug or serialization for the credential owner.
pub trait Credential: Sync {
    fn authorization(&self) -> zeroize::Zeroizing<Vec<u8>>;
}
impl Credential for native_credentials::NativeCredential {
    fn authorization(&self) -> zeroize::Zeroizing<Vec<u8>> {
        self.authorization()
    }
}

#[derive(Clone, Copy)]
pub enum Timing {
    Accepted,
    Prepared(bool),
    Offer(u64),
    Configuration(u64),
    Negotiation(u64),
    Sideband(u64),
}
/// A call-attempt adapter. Current/cancellation and credentials are host policy;
/// activation and failure callbacks preserve that identity through retirement.
/// No callback may hold a lock across an await or introduce a second recorder.
pub trait Host: Capture + Send + 'static {
    fn current(&self) -> bool;
    fn collecting_usage(&self) -> bool;
    fn activate(&self) -> Result<(), recovery::Failure>;
    fn failure(&self) -> Option<recovery::Failure>;
    fn fail(&self, error: recovery::Failure);
    fn retiring(&self);
    fn timing(&self, timing: Timing);
    fn render(&self, tag: &Tag, pcm: &[i16]) -> Result<(), &'static str>;
    fn render_timed(
        &self,
        tag: &Tag,
        pcm: &[i16],
        _rtp_timestamp: Option<u32>,
    ) -> Result<(), &'static str> {
        self.render(tag, pcm)
    }
    fn finish_audio(&self, tag: &Tag);
    fn statistics(&self, delta: Statistics);
    fn uploaded(&self);
}

pub fn typed(value: serde_json::Value) -> Result<ClientEvent, &'static str> {
    serde_json::from_value(value).map_err(|_| "Invalid Realtime event.")
}
pub fn validate_model(id: &str) -> Result<(), &'static str> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    {
        return Err(models::UNSUPPORTED);
    }
    Ok(())
}
