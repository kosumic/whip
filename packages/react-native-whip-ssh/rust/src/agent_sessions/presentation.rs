//! UniFFI's synchronous foreign callback may wait for JavaScript. Keep it off
//! ingestion/runtime threads so a busy or detached UI cannot stall native speech.
//! Each bound source retains at most four deltas, then one lazy snapshot marker.
use super::{
    AgentSessionManagerInner, AgentTranscriptEvent, AgentTranscriptUpdate, TranscriptKey,
    event_sink, merge_updates,
};
use parking_lot::{Condvar, Mutex};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, OnceLock, Weak},
};

const MAX_UPDATES_PER_SOURCE: usize = 4;
type Key = (u64, TranscriptKey);

struct Job {
    manager: Weak<AgentSessionManagerInner>,
    key: TranscriptKey,
    epoch: u64,
    revision: u64,
    updates: Option<Vec<AgentTranscriptUpdate>>,
}

#[derive(Default)]
struct Pending {
    order: VecDeque<Key>,
    jobs: HashMap<Key, Job>,
}

impl Pending {
    fn push(
        &mut self,
        manager: &Arc<AgentSessionManagerInner>,
        key: TranscriptKey,
        epoch: u64,
        update: AgentTranscriptUpdate,
    ) {
        let identity = (manager.runtime_incarnation, key.clone());
        if let Some(job) = self.jobs.get_mut(&identity) {
            if epoch < job.epoch {
                return;
            }
            if epoch != job.epoch || update.revision <= job.revision {
                job.updates = None;
            }
            job.epoch = epoch;
            job.revision = job.revision.max(update.revision);
            if let Some(updates) = &mut job.updates {
                if updates.len() < MAX_UPDATES_PER_SOURCE {
                    updates.push(update);
                } else {
                    job.updates = None;
                }
            }
        } else {
            self.order.push_back(identity.clone());
            self.jobs.insert(
                identity,
                Job {
                    manager: Arc::downgrade(manager),
                    key,
                    epoch,
                    revision: update.revision,
                    updates: Some(vec![update]),
                },
            );
        }
    }

    fn pop(&mut self) -> Option<Job> {
        let key = self.order.pop_front()?;
        self.jobs.remove(&key)
    }
}

#[derive(Default)]
struct Delivery {
    pending: Mutex<Pending>,
    ready: Condvar,
}
static DELIVERY: OnceLock<Option<Arc<Delivery>>> = OnceLock::new();

pub(super) fn enqueue(
    manager: &Arc<AgentSessionManagerInner>,
    key: TranscriptKey,
    epoch: u64,
    update: AgentTranscriptUpdate,
) {
    if event_sink().read().is_none() {
        return;
    }
    let Some(delivery) = DELIVERY.get_or_init(|| {
        let delivery = Arc::new(Delivery::default());
        let worker = delivery.clone();
        match std::thread::Builder::new()
            .name("whip-transcript-presentation".into())
            .spawn(move || worker.run())
        {
            Ok(_) => Some(delivery),
            Err(error) => {
                log::error!("Cannot start transcript presentation delivery: {error}");
                None
            }
        }
    }) else {
        return;
    };
    delivery.pending.lock().push(manager, key, epoch, update);
    delivery.ready.notify_one();
}

impl Delivery {
    fn run(&self) {
        loop {
            let job = {
                let mut pending = self.pending.lock();
                loop {
                    if let Some(job) = pending.pop() {
                        drop(pending);
                        break job;
                    }
                    self.ready.wait(&mut pending);
                }
            };
            let Some(event) = prepare(job) else {
                continue;
            };
            let sink = event_sink().read().clone();
            if let Some(sink) = sink
                && std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink.event(event)))
                    .is_err()
            {
                log::warn!("Transcript presentation callback failed");
            }
        }
    }
}

fn prepare(job: Job) -> Option<AgentTranscriptEvent> {
    let manager = job.manager.upgrade()?;
    let state = manager.state.lock();
    let session = state
        .sessions
        .get(&job.key)
        .filter(|session| session.operation_epoch == job.epoch)?;
    let update = if job.revision != session.core.revision() || job.updates.is_none() {
        AgentTranscriptUpdate::reset(session.core.state())
    } else {
        job.updates?
            .into_iter()
            .fold(None, |merged, update| merge_updates(merged, Some(update)))?
    };
    drop(state);
    Some(AgentTranscriptEvent {
        runtime_id: manager.runtime_id.clone(),
        runtime_incarnation: manager.runtime_incarnation,
        operation_epoch: job.epoch,
        key: job.key.into(),
        update,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const SESSION_ID: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn a_busy_presentation_retains_one_bounded_job_per_source_and_catches_up_from_rust() {
        let manager = super::super::tests::test_manager("presentation");
        let binding = manager
            .bind_codex("terminal".into(), SESSION_ID.into())
            .unwrap();
        let epoch = manager.inner.state.lock().sessions[&binding.transcript_key].operation_epoch;
        let mut pending = Pending::default();
        for revision in 1..1_000 {
            pending.push(
                &manager.inner,
                binding.transcript_key.clone(),
                epoch,
                AgentTranscriptUpdate {
                    revision,
                    deltas: Vec::new(),
                },
            );
        }
        assert_eq!(pending.jobs.len(), 1);
        let job = pending.pop().unwrap();
        assert!(job.updates.is_none());
        let event = prepare(job).unwrap();
        assert_eq!(
            event.update.revision,
            manager.state(&binding.transcript_key).unwrap().revision
        );
        assert!(matches!(
            event.update.deltas.as_slice(),
            [crate::AgentTranscriptDelta::Reset { .. }]
        ));
    }

    #[test]
    fn a_replaced_source_cannot_deliver_an_old_snapshot() {
        let manager = super::super::tests::test_manager("presentation-replacement");
        let binding = manager
            .bind_codex("terminal".into(), SESSION_ID.into())
            .unwrap();
        let epoch = manager.inner.state.lock().sessions[&binding.transcript_key].operation_epoch;
        let mut pending = Pending::default();
        pending.push(
            &manager.inner,
            binding.transcript_key,
            epoch,
            AgentTranscriptUpdate {
                revision: 1,
                deltas: Vec::new(),
            },
        );
        manager.close_terminal(&"terminal".into());
        assert!(prepare(pending.pop().unwrap()).is_none());
    }
}
