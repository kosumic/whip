use std::error::Error;
use std::sync::atomic::AtomicU64;

use super::*;

#[derive(Default)]
struct Wire {
    generation: AtomicU64,
    writes: Mutex<Vec<(String, Vec<String>)>>,
    outcomes: Mutex<VecDeque<WriteOutcome>>,
    hold: AtomicBool,
    release: Notify,
}

struct Transport {
    wire: Arc<Wire>,
    generation: u64,
}

#[async_trait::async_trait]
impl SubmissionTransport for Transport {
    fn valid(&self) -> bool {
        self.generation == self.wire.generation.load(Ordering::Acquire)
    }
    async fn send(&self, parts: Vec<String>, permit: &TerminalSubmissionPermit) -> WriteOutcome {
        if !self.valid() || !permit.active() {
            return WriteOutcome::Unsent;
        }
        self.wire.writes.lock().push((permit.key.clone(), parts));
        if self.wire.hold.load(Ordering::Acquire) {
            self.wire.release.notified().await;
        }
        self.wire
            .outcomes
            .lock()
            .pop_front()
            .unwrap_or(WriteOutcome::Accepted)
    }
}

#[derive(Default)]
struct Platform {
    permits: Mutex<Vec<Arc<TerminalSubmissionPermit>>>,
    hold: AtomicBool,
    release: Notify,
    fail: AtomicBool,
    skip_dispatch: AtomicBool,
}

#[async_trait::async_trait]
impl TerminalSubmissionPlatform for Platform {
    async fn submit(
        &self,
        permit: Arc<TerminalSubmissionPermit>,
        _key: String,
        parts: Vec<String>,
        _first: bool,
    ) -> Result<(), TerminalSubmissionPlatformError> {
        self.permits.lock().push(permit.clone());
        if self.hold.load(Ordering::Acquire) {
            self.release.notified().await;
        }
        if self.fail.load(Ordering::Acquire) {
            return Err(TerminalSubmissionPlatformError::Unavailable);
        }
        if !self.skip_dispatch.load(Ordering::Acquire) {
            permit
                .dispatch(parts)
                .await
                .map_err(|_| TerminalSubmissionPlatformError::Unavailable)?;
        }
        Ok(())
    }
    fn changed(&self, _key: String) {}
}

fn queue(wire: &Arc<Wire>) -> Arc<TerminalSubmissionQueue> {
    let wire = wire.clone();
    Arc::new(TerminalSubmissionQueue {
        state: Mutex::default(),
        transport: Arc::new(move |_| {
            Some(Arc::new(Transport {
                wire: wire.clone(),
                generation: wire.generation.load(Ordering::Acquire),
            }))
        }),
    })
}

fn target(key: &str, online: bool) -> TerminalSubmissionTarget {
    TerminalSubmissionTarget {
        key: key.into(),
        runtime_id: key.into(),
        runtime_incarnation: 1,
        terminal_id: "terminal".into(),
        pane_id: "pane".into(),
        ssh: false,
        online,
    }
}

async fn until(predicate: impl Fn() -> bool) -> Result<(), Box<dyn Error>> {
    tokio::time::timeout(Duration::from_secs(4), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await?;
    Ok(())
}

fn enqueue(
    queue: &Arc<TerminalSubmissionQueue>,
    key: &str,
    text: &str,
) -> Result<TerminalSubmissionMessage, Box<dyn Error>> {
    queue
        .clone()
        .enqueue(key.into(), text.into(), vec![])
        .ok_or_else(|| "message missing".into())
}

#[test]
fn admission_keeps_paste_boundaries_attachment_ids_and_history() -> Result<(), Box<dyn Error>> {
    let queue = TerminalSubmissionQueue::new();
    assert!(
        queue
            .clone()
            .enqueue("a".into(), " \n".into(), vec![])
            .is_none()
    );
    let message = queue
        .clone()
        .enqueue(
            "a".into(),
            "compare   ".into(),
            vec![
                TerminalSubmissionAttachment {
                    id: -1,
                    remote_path: "/file one.png".into(),
                },
                TerminalSubmissionAttachment {
                    id: -2,
                    remote_path: "/two.png".into(),
                },
            ],
        )
        .ok_or("missing submission")?;
    assert_eq!(
        message.paste_events,
        ["compare", "/file one.png", "/two.png"]
    );
    assert_eq!(message.history_entry, "compare /file one.png /two.png");
    assert_eq!(message.attachments[0].id, -1);
    let second = enqueue(&queue, "a", "next")?;
    assert_ne!(message.id, second.id);
    assert_eq!(
        queue
            .clone()
            .unqueue("a".into(), message.id)
            .ok_or("unqueue failed")?
            .text,
        "compare   "
    );
    assert_eq!(queue.view("a".into())[0].id, second.id);
    Ok(())
}

#[test]
fn offline_admission_drains_in_order_once_online_across_two_terminals() -> Result<(), Box<dyn Error>>
{
    crate::runtime()?.block_on(async {
        let wire = Arc::new(Wire::default());
        let queue = queue(&wire);
        queue.clone().attach(Arc::new(Platform::default()));
        queue
            .clone()
            .update_targets(vec![target("a", false), target("b", true)]);
        enqueue(&queue, "a", "first")?;
        enqueue(&queue, "a", "second")?;
        enqueue(&queue, "b", "other")?;
        queue.clone().start();
        until(|| queue.view("b".into()).is_empty()).await?;
        assert_eq!(queue.view("a".into()).len(), 2);
        queue
            .clone()
            .update_targets(vec![target("a", true), target("b", true)]);
        until(|| queue.view("a".into()).is_empty()).await?;
        for _ in 0..3 {
            queue.clone().start();
        }
        let writes = wire.writes.lock();
        assert_eq!(
            writes
                .iter()
                .filter(|(key, _)| key == "a")
                .map(|(_, parts)| parts[0].as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert_eq!(writes.len(), 3);
        drop(writes);
        assert_eq!(queue.take_completed("a".into()).len(), 2);
        assert!(queue.take_completed("a".into()).is_empty());
        queue.detach();
        Ok(())
    })
}

#[test]
fn renderer_success_without_native_dispatch_never_acknowledges_a_message()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let wire = Arc::new(Wire::default());
        let queue = queue(&wire);
        let platform = Arc::new(Platform::default());
        platform.skip_dispatch.store(true, Ordering::Release);
        queue.clone().attach(platform.clone());
        queue.clone().update_targets(vec![target("a", true)]);
        enqueue(&queue, "a", "keep")?;
        queue.clone().start();
        until(|| queue.view("a".into())[0].status == TerminalSubmissionStatus::Retrying).await?;
        let late = platform.permits.lock()[0].clone();
        assert!(late.dispatch(vec!["late callback".into()]).await.is_err());
        assert!(wire.writes.lock().is_empty());
        assert!(queue.take_completed("a".into()).is_empty());
        queue.detach();
        Ok(())
    })
}

#[test]
fn unsent_renderer_failure_can_retry_but_partial_write_blocks_the_queue()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let wire = Arc::new(Wire::default());
        let queue = queue(&wire);
        let platform = Arc::new(Platform::default());
        platform.fail.store(true, Ordering::Release);
        queue.clone().attach(platform.clone());
        queue.clone().update_targets(vec![target("a", true)]);
        enqueue(&queue, "a", "first")?;
        enqueue(&queue, "a", "must wait")?;
        queue.clone().start();
        until(|| queue.view("a".into())[0].status == TerminalSubmissionStatus::Retrying).await?;
        platform.fail.store(false, Ordering::Release);
        wire.outcomes.lock().push_back(WriteOutcome::Ambiguous(1));
        until(|| queue.view("a".into())[0].status == TerminalSubmissionStatus::Ambiguous).await?;
        assert_eq!(wire.writes.lock().len(), 1);
        assert_eq!(queue.view("a".into())[0].accepted_parts, 1);
        for _ in 0..5 {
            queue.clone().update_targets(vec![target("a", true)]);
            queue.clone().start();
        }
        assert_eq!(wire.writes.lock().len(), 1);
        assert!(queue.take_completed("a".into()).is_empty());
        let message = queue.view("a".into())[0].clone();
        queue
            .clone()
            .unqueue("a".into(), message.id)
            .ok_or("restore failed")?;
        until(|| queue.view("a".into()).is_empty()).await?;
        assert_eq!(wire.writes.lock()[1].1, ["must wait"]);
        queue.detach();
        Ok(())
    })
}

#[test]
fn remount_revokes_late_encoding_without_redirecting_or_duplicating_input()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let wire = Arc::new(Wire::default());
        let queue = queue(&wire);
        let old = Arc::new(Platform::default());
        old.hold.store(true, Ordering::Release);
        queue.clone().attach(old.clone());
        queue.clone().update_targets(vec![target("a", true)]);
        let message = enqueue(&queue, "a", "once")?;
        queue.clone().start();
        until(|| !old.permits.lock().is_empty()).await?;
        let late = old.permits.lock()[0].clone();
        assert!(queue.clone().unqueue("a".into(), message.id).is_none());
        queue.detach();
        queue.clone().attach(Arc::new(Platform::default()));
        until(|| queue.view("a".into()).is_empty()).await?;
        assert!(late.dispatch(vec!["wrong target".into()]).await.is_err());
        assert_eq!(
            wire.writes.lock().as_slice(),
            [("a".into(), vec!["once".into()])]
        );
        queue.detach();
        Ok(())
    })
}

#[test]
fn disconnect_and_reconnect_cannot_revalidate_an_old_permit() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let wire = Arc::new(Wire::default());
        let queue = queue(&wire);
        let platform = Arc::new(Platform::default());
        platform.hold.store(true, Ordering::Release);
        queue.clone().attach(platform.clone());
        queue.clone().update_targets(vec![target("a", true)]);
        enqueue(&queue, "a", "queued")?;
        queue.clone().start();
        until(|| !platform.permits.lock().is_empty()).await?;
        let old = platform.permits.lock()[0].clone();
        queue.clone().update_targets(vec![target("a", false)]);
        queue.clone().update_targets(vec![target("a", true)]);
        assert!(old.dispatch(vec!["late".into()]).await.is_err());
        assert!(wire.writes.lock().is_empty());
        queue.detach();
        Ok(())
    })
}

#[test]
fn replacing_runtime_or_closing_terminal_fences_delayed_callbacks() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        for remove in [false, true] {
            let wire = Arc::new(Wire::default());
            let queue = queue(&wire);
            let platform = Arc::new(Platform::default());
            platform.hold.store(true, Ordering::Release);
            queue.clone().attach(platform.clone());
            queue.clone().update_targets(vec![target("a", true)]);
            enqueue(&queue, "a", "old identity")?;
            queue.clone().start();
            until(|| !platform.permits.lock().is_empty()).await?;
            let old = platform.permits.lock()[0].clone();
            if remove {
                queue.remove("a".into());
            } else {
                let mut replacement = target("a", true);
                replacement.runtime_incarnation += 1;
                queue.clone().update_targets(vec![replacement]);
            }
            assert!(old.dispatch(vec!["late".into()]).await.is_err());
            assert!(wire.writes.lock().is_empty());
            queue.detach();
        }
        Ok(())
    })
}

#[test]
fn cancelling_an_in_progress_transport_write_never_automatically_replays_it()
-> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let wire = Arc::new(Wire::default());
        wire.hold.store(true, Ordering::Release);
        let queue = queue(&wire);
        queue.clone().attach(Arc::new(Platform::default()));
        queue.clone().update_targets(vec![target("a", true)]);
        enqueue(&queue, "a", "possibly sent")?;
        queue.clone().start();
        until(|| !wire.writes.lock().is_empty()).await?;
        queue.detach();
        queue.clone().attach(Arc::new(Platform::default()));
        until(|| queue.view("a".into())[0].status == TerminalSubmissionStatus::Ambiguous).await?;
        wire.release.notify_one();
        queue.clone().start();
        assert_eq!(wire.writes.lock().len(), 1);
        assert!(queue.take_completed("a".into()).is_empty());
        queue.detach();
        Ok(())
    })
}

#[test]
fn a_transport_generation_change_before_dispatch_is_safe_to_retry() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let wire = Arc::new(Wire::default());
        let queue = queue(&wire);
        let platform = Arc::new(Platform::default());
        platform.hold.store(true, Ordering::Release);
        queue.clone().attach(platform.clone());
        queue.clone().update_targets(vec![target("a", true)]);
        enqueue(&queue, "a", "once")?;
        queue.clone().start();
        until(|| !platform.permits.lock().is_empty()).await?;
        wire.generation.fetch_add(1, Ordering::AcqRel);
        platform.hold.store(false, Ordering::Release);
        platform.release.notify_one();
        until(|| queue.view("a".into()).is_empty()).await?;
        assert_eq!(wire.writes.lock().len(), 1);
        assert_eq!(
            queue.take_completed("a".into())[0].status,
            TerminalSubmissionStatus::Accepted
        );
        queue.detach();
        Ok(())
    })
}

#[test]
fn repeated_unsent_failures_stop_at_the_native_retry_limit() -> Result<(), Box<dyn Error>> {
    crate::runtime()?.block_on(async {
        let wire = Arc::new(Wire::default());
        let queue = queue(&wire);
        let platform = Arc::new(Platform::default());
        platform.fail.store(true, Ordering::Release);
        queue.clone().attach(platform.clone());
        queue.clone().update_targets(vec![target("a", true)]);
        enqueue(&queue, "a", "keep for editing")?;
        queue
            .state
            .lock()
            .targets
            .get_mut("a")
            .ok_or("target missing")?
            .queue
            .front_mut()
            .ok_or("message missing")?
            .attempts = MAX_ATTEMPTS - 1;
        queue.clone().start();
        until(|| queue.view("a".into())[0].status == TerminalSubmissionStatus::Failed).await?;
        queue.clone().start();
        assert_eq!(platform.permits.lock().len(), 1);
        assert!(wire.writes.lock().is_empty());
        queue.detach();
        Ok(())
    })
}
