//! Native adapters enqueue accounting independently of audio and JS lifetimes.
use super::{
    AppStorageError, Ledger, Store, VoiceUsageEvent, VoiceUsageIdentity, VoiceUsageItem,
    VoiceUsageMode, VoiceUsageProvider, VoiceUsageScope, database, save,
};
use parking_lot::Mutex;
use std::{
    collections::VecDeque,
    sync::{
        LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

static PENDING: Mutex<VecDeque<VoiceUsageEvent>> = Mutex::new(VecDeque::new());
static FLUSH: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));
static DRAINING: AtomicBool = AtomicBool::new(false);
static RECOVERED: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

pub(super) async fn commit(event: VoiceUsageEvent) -> Result<(), AppStorageError> {
    database()?
        .request(move |store| commit_recovered(store, event, &RECOVERED))
        .await
}

fn commit_recovered(
    store: &mut Store,
    event: VoiceUsageEvent,
    recovered: &AtomicBool,
) -> Result<(), AppStorageError> {
    let mut ledger = Ledger::load(store)?;
    if !recovered.load(Ordering::Acquire) {
        ledger.apply(VoiceUsageEvent::Recover)?;
    }
    // A later JS subscriber must not recover native sessions that started in
    // this process before the Usage & costs screen was opened.
    if !matches!(event, VoiceUsageEvent::Recover) {
        ledger.apply(event)?;
    }
    save(store, &ledger)?;
    recovered.store(true, Ordering::Release);
    Ok(())
}

pub(crate) async fn flush_native_voice_usage() -> Result<(), AppStorageError> {
    let _guard = FLUSH.lock().await;
    drain_queue(&PENDING, commit).await
}

async fn drain_queue<F, Fut>(
    queue: &Mutex<VecDeque<VoiceUsageEvent>>,
    mut persist: F,
) -> Result<(), AppStorageError>
where
    F: FnMut(VoiceUsageEvent) -> Fut,
    Fut: std::future::Future<Output = Result<(), AppStorageError>>,
{
    loop {
        let Some(event) = queue.lock().front().cloned() else {
            return Ok(());
        };
        persist(event).await?;
        queue.lock().pop_front();
    }
}

fn enqueue(event: VoiceUsageEvent) {
    PENDING.lock().push_back(event);
    if DRAINING.swap(true, Ordering::AcqRel) {
        return;
    }
    let Ok(runtime) = crate::runtime() else {
        DRAINING.store(false, Ordering::Release);
        return;
    };
    runtime.spawn(async {
        loop {
            let result = flush_native_voice_usage().await;
            DRAINING.store(false, Ordering::Release);
            // On storage/migration failure, keep the ordered queue for retry
            // by the next event or summary. Never spin or interrupt playback.
            if result.is_err() || PENDING.lock().is_empty() || DRAINING.swap(true, Ordering::AcqRel)
            {
                break;
            }
        }
    });
}

pub(crate) struct NativeVoiceUsageSession {
    id: String,
    started_at_ms: u64,
    revision: u64,
    emit: Box<dyn Fn(VoiceUsageEvent) + Send + Sync>,
}

impl NativeVoiceUsageSession {
    pub(crate) fn start(
        mode: VoiceUsageMode,
        scope: VoiceUsageScope,
        model: &str,
        voice: &str,
    ) -> Self {
        Self::new(
            VoiceUsageIdentity {
                session_id: format!("voice:{}", uuid::Uuid::new_v4()),
                provider: VoiceUsageProvider::Openai,
                mode,
                scope,
                model: Some(model.into()),
                voice: Some(voice.into()),
                started_at_ms: now_ms(),
            },
            Box::new(enqueue),
        )
    }

    pub(crate) fn new(
        call: VoiceUsageIdentity,
        emit: Box<dyn Fn(VoiceUsageEvent) + Send + Sync>,
    ) -> Self {
        let session = Self {
            id: call.session_id.clone(),
            started_at_ms: call.started_at_ms,
            revision: 0,
            emit,
        };
        (session.emit)(VoiceUsageEvent::Started { call });
        session
    }

    pub(crate) fn record(&mut self, item_id: String, mut item: VoiceUsageItem) {
        self.revision = self.revision.saturating_add(1);
        item.revision = self.revision;
        (self.emit)(VoiceUsageEvent::Usage {
            session_id: self.id.clone(),
            item_id,
            item,
        });
    }
}

impl Drop for NativeVoiceUsageSession {
    fn drop(&mut self) {
        (self.emit)(VoiceUsageEvent::Ended {
            session_id: self.id.clone(),
            ended_at_ms: now_ms().max(self.started_at_ms),
        });
    }
}

#[cfg(test)]
mod tests;
