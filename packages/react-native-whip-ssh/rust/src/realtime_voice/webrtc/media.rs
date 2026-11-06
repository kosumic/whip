//! Existing app-level media fixtures use the provider's media control path.
use super::super::{RealtimeVoiceAdapter, recovery};
use super::{host::AppHost, identity::Identity, transport::Transport};
use parking_lot::Mutex;
use std::sync::Arc;
use tokio::sync::watch;
pub(super) async fn run(
    owner: &Arc<RealtimeVoiceAdapter>,
    peer: &mut Transport,
    identity: Arc<Mutex<Identity>>,
    stop: watch::Receiver<bool>,
    attempt: &Arc<recovery::Attempt>,
) -> Result<(), &'static str> {
    voice_openai::media::run(
        &AppHost {
            owner: owner.clone(),
            attempt: attempt.clone(),
        },
        peer,
        identity,
        stop,
    )
    .await
}
