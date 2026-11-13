//! Durable SFTP jobs. The database worker serializes decisions; Expo only executes
//! leased destination/OS effects. Transfer tasks outlive foreign bridge wrappers.
use super::{AppStorageEntry, AppStorageError, Store, database};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

mod native;
#[cfg(test)]
mod tests;

pub(super) const KEY: &str = "whip.sftp-downloads.v2";
const LEGACY_KEY: &str = "whip.sftp-downloads.v1";
const MAX_ACTIVE: usize = 3;
const INTERRUPTED: &str = "Interrupted. Retry restarts safely from the remote source.";
const UNCERTAIN_SAVE: &str = "Saving was interrupted. Check the selected folder before retrying; an incomplete copy may remain.";
type Result<T> = std::result::Result<T, AppStorageError>;
fn invalid(message: impl Into<String>) -> AppStorageError {
    AppStorageError::InvalidEntry(message.into())
}
fn token() -> String {
    uuid::Uuid::new_v4().to_string()
}
fn now_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Phase {
    Selecting,
    Queued,
    Downloading,
    Saving,
    Completed,
    Paused,
    Failed,
    Cancelled,
}
impl Phase {
    fn active(self) -> bool {
        matches!(
            self,
            Self::Selecting | Self::Queued | Self::Downloading | Self::Saving
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Saved {
    pub uri: String,
    pub directory_uri: String,
    pub is_directory: bool,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Step {
    Select,
    Begin,
    Transfer,
    Save,
    End,
    Delete,
    #[default]
    Idle,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Operation {
    generation: u64,
    incarnation: u64,
    host_identity: Option<String>,
    execution_id: String,
    step: Step,
    effect_id: String,
    #[serde(skip)]
    owner: Option<String>,
    staging: Option<String>,
    source: Option<String>,
    remove: bool,
    delete_local: bool,
    uncertain_save: bool,
    resume_cache: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Job {
    pub id: String,
    pub host_id: String,
    pub remote_path: String,
    pub name: String,
    pub created_at: u64,
    pub phase: Phase,
    pub bytes_transferred: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_id: Option<String>,
    #[serde(default)]
    pub cancel_requested: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved: Option<Saved>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_phase: Option<Phase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_per_second: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_calculating: Option<bool>,
    #[serde(default)]
    operation: Operation,
}
impl Job {
    fn detach_adapter(&mut self) {
        if !matches!(self.operation.step, Step::Select | Step::Begin | Step::Save) {
            self.operation.owner = None;
            return;
        }
        let saving = self.operation.step == Step::Save;
        self.phase = match (self.cancel_requested, saving) {
            (true, _) => Phase::Cancelled,
            (false, true) => Phase::Failed,
            (false, false) => Phase::Paused,
        };
        self.error = Some(if saving { UNCERTAIN_SAVE } else { INTERRUPTED }.into());
        self.failed_phase = saving.then_some(Phase::Saving);
        self.operation.uncertain_save = saving;
        self.schedule(Step::End);
    }
    fn busy(&self) -> bool {
        self.phase.active() || self.operation.step != Step::Idle
    }
    fn schedule(&mut self, step: Step) {
        self.operation.step = step;
        self.operation.effect_id = token();
        self.operation.owner = None;
    }
    fn clear_rate(&mut self) {
        self.bytes_per_second = None;
        self.remaining_seconds = None;
        self.rate_calculating = None;
    }
    fn observe(
        &mut self,
        bytes: u64,
        total: Option<u64>,
        speed: Option<u64>,
        remaining: Option<u64>,
        calculating: bool,
    ) {
        self.bytes_transferred = bytes;
        self.total_bytes = total;
        self.bytes_per_second = speed;
        self.remaining_seconds = remaining;
        self.rate_calculating = Some(calculating);
    }
    fn stop(&mut self, cancelled: bool) {
        if self.phase == Phase::Completed {
            return;
        }
        self.cancel_requested |= cancelled;
        if self.cancel_requested {
            self.operation.resume_cache = None;
        }
        self.phase = if self.cancel_requested {
            Phase::Cancelled
        } else {
            Phase::Paused
        };
        self.error = (!self.cancel_requested)
            .then(|| "Background time expired. Retry restarts safely when Whip returns.".into());
        self.clear_rate();
        // A picker/copy cannot be interrupted. Keep its lease and capacity until
        // the actual acknowledgement; cancellation wins over a late success.
        if self.operation.owner.is_none() && self.operation.step != Step::Transfer {
            self.schedule(Step::End);
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    jobs: Vec<Job>,
}
#[derive(Clone)]
pub(super) struct Manager {
    ledger: Ledger,
    revision: u64,
    checkpoint: Instant,
    owner: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum Command {
    Attach {
        owner: String,
    },
    Snapshot,
    Claim {
        owner: String,
    },
    Start {
        host_id: String,
        remote_path: String,
        cache_directory: String,
        #[serde(default)]
        incarnation: u64,
    },
    Retry {
        id: String,
        cache_directory: String,
        #[serde(default)]
        choose_destination: bool,
        #[serde(default)]
        incarnation: u64,
    },
    Resume {
        host_id: Option<String>,
        cache_directory: String,
    },
    Cancel {
        id: String,
    },
    Pause {
        id: String,
    },
    Expire {
        execution_id: String,
        cancelled: bool,
    },
    Remove {
        id: String,
        delete_local: bool,
    },
    Ack {
        id: String,
        effect_id: String,
        owner: String,
        #[serde(default)]
        directory: Option<String>,
        #[serde(default)]
        permission: Option<String>,
        #[serde(default)]
        saved: Option<Saved>,
        #[serde(default)]
        error: Option<String>,
        #[serde(default)]
        cancelled: bool,
    },
    Bound {
        id: String,
        generation: u64,
        transfer_id: String,
    },
    Progress {
        id: String,
        generation: u64,
        bytes: u64,
        total: Option<u64>,
        speed: Option<u64>,
        remaining: Option<u64>,
        calculating: bool,
    },
    Finished {
        id: String,
        generation: u64,
        source: Option<String>,
        error: Option<String>,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Effect {
    id: String,
    #[serde(rename = "effectId")]
    token: String,
    kind: Step,
    job: Job,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Response {
    revision: u64,
    items: Vec<serde_json::Value>,
    effects: Vec<Effect>,
    accepted: bool,
    created_id: Option<String>,
}
#[derive(Clone)]
pub(super) enum Action {
    Start(Box<Job>),
    Cancel(String),
    Cleanup(String),
}
impl Manager {
    fn load(store: &Store) -> Result<Self> {
        let entries = store.read(vec![KEY.into(), LEGACY_KEY.into()])?;
        let mut ledger = if let Some(value) = &entries[0].value {
            let ledger: Ledger = serde_json::from_str(value)
                .map_err(|_| invalid("Downloads history could not be read; data was preserved"))?;
            if ledger.version != 2 {
                return Err(AppStorageError::Incompatible);
            }
            ledger
        } else {
            let jobs = entries[1]
                .value
                .as_deref()
                .map(serde_json::from_str::<Vec<Job>>)
                .transpose()
                .map_err(|_| {
                    invalid("Downloads history could not be migrated; data was preserved")
                })?
                .unwrap_or_default();
            Ledger { version: 2, jobs }
        };
        let mut ids = std::collections::HashSet::new();
        for job in &mut ledger.jobs {
            if job.id.is_empty() || job.host_id.is_empty() || !ids.insert(job.id.clone()) {
                return Err(invalid("Duplicate or invalid download identity"));
            }
            if job.phase.active() {
                let saving = job.phase == Phase::Saving || job.operation.step == Step::Save;
                job.phase = if job.cancel_requested {
                    Phase::Cancelled
                } else if saving {
                    Phase::Failed
                } else {
                    Phase::Paused
                };
                job.error = (!job.cancel_requested)
                    .then(|| if saving { UNCERTAIN_SAVE } else { INTERRUPTED }.into());
                job.failed_phase = saving.then_some(Phase::Saving);
                job.operation.uncertain_save |= saving;
            }
            job.operation.step = Step::Idle;
            job.operation.remove = false;
            // Native process restart cannot revive old task IDs or leases.
            job.operation.owner = None;
            job.clear_rate();
        }
        ledger
            .jobs
            .sort_by_key(|job| std::cmp::Reverse(job.created_at));
        Ok(Self {
            ledger,
            revision: 0,
            checkpoint: Instant::now(),
            owner: None,
        })
    }
    fn save(&self, store: &mut Store) -> Result<()> {
        let value =
            serde_json::to_string(&self.ledger).map_err(|error| invalid(error.to_string()))?;
        // The v2 document itself is the migration receipt. Retain v1 as an
        // untouched recovery source; an empty v2 never reimports deleted rows.
        store.write(
            vec![AppStorageEntry {
                key: KEY.into(),
                value: Some(value),
            }],
            false,
        )
    }
    fn response(&self, accepted: bool, created_id: Option<String>) -> Result<Response> {
        let items = self
            .ledger
            .jobs
            .iter()
            .map(|job| {
                let mut value =
                    serde_json::to_value(job).map_err(|error| invalid(error.to_string()))?;
                value["busy"] = job.busy().into();
                Ok(value)
            })
            .collect::<Result<_>>()?;
        Ok(Response {
            revision: self.revision,
            items,
            effects: Vec::new(),
            accepted,
            created_id,
        })
    }
    fn admit(&self, picker: bool) -> Result<()> {
        if self.ledger.jobs.iter().filter(|job| job.busy()).count() >= MAX_ACTIVE {
            return Err(invalid("Wait for an active download to finish"));
        }
        if picker
            && self.ledger.jobs.iter().any(|job| {
                job.operation.step == Step::Select && job.destination_directory.is_none()
            })
        {
            return Err(invalid("Finish choosing the other download folder first"));
        }
        Ok(())
    }
    fn retry_job(
        &mut self,
        id: &str,
        cache_directory: String,
        choose_destination: bool,
        incarnation: u64,
    ) -> Result<Vec<Action>> {
        let mut actions = Vec::new();
        let job = self
            .ledger
            .jobs
            .iter()
            .find(|job| job.id == id)
            .ok_or_else(|| invalid("Unknown download"))?;
        let host_identity =
            crate::get_host_runtime(job.host_id.clone()).map(|runtime| runtime.download_identity());
        if job
            .operation
            .host_identity
            .as_ref()
            .is_some_and(|original| Some(original) != host_identity.as_ref())
        {
            return Err(invalid(
                "This host now points to a different server or account. Start a new download from that host.",
            ));
        }
        if job.busy() || job.phase == Phase::Completed {
            return Err(invalid("Wait for this download to settle"));
        }
        self.admit(choose_destination || job.destination_directory.is_none())?;
        let job = self
            .ledger
            .jobs
            .iter_mut()
            .find(|job| job.id == id)
            .ok_or_else(|| invalid("Unknown download"))?;
        let next_generation = job.operation.generation + 1;
        let parent = PathBuf::from(cache_directory);
        if !parent.is_absolute() {
            return Err(invalid("Invalid cache directory"));
        }
        if !job.operation.uncertain_save
            && let Some(staging) = job.operation.staging.take()
        {
            actions.push(Action::Cleanup(staging));
        }
        job.operation = Operation {
            generation: next_generation,
            incarnation,
            host_identity,
            execution_id: token(),
            staging: Some(
                parent
                    .join(format!("whip-job-{id}-{next_generation}"))
                    .to_string_lossy()
                    .into(),
            ),
            ..Operation::default()
        };
        job.phase = Phase::Selecting;
        job.bytes_transferred = 0;
        job.total_bytes = None;
        job.error = None;
        job.failed_phase = None;
        job.cancel_requested = false;
        job.transfer_id = None;
        // A failed deletion must retain its descriptor until explicitly
        // removed; silently retrying could orphan that local copy.
        if job.saved.is_some() {
            return Err(invalid("Remove the saved local copy before retrying"));
        }
        if choose_destination {
            job.destination_directory = None;
            job.permission = None;
        }
        job.clear_rate();
        job.schedule(Step::Select);

        Ok(actions)
    }
    fn resume_ready(&mut self) -> (Vec<Action>, bool) {
        let candidates: Vec<_> = self
            .ledger
            .jobs
            .iter()
            .filter(|job| job.phase == Phase::Paused && !job.cancel_requested && !job.busy())
            .filter_map(|job| {
                job.operation
                    .resume_cache
                    .clone()
                    .map(|cache| (job.id.clone(), job.host_id.clone(), cache))
            })
            .collect();
        let mut actions = Vec::new();
        let mut changed = false;
        for (id, host, cache) in candidates {
            let Some(runtime) = crate::get_host_runtime(host) else {
                continue;
            };
            if runtime.status().state != crate::HostConnectionState::Connected {
                continue;
            }
            // A failed candidate must not alter a retained descriptor or lease.
            let mut candidate = self.clone();
            if let Ok(next_actions) =
                candidate.retry_job(&id, cache, false, runtime.runtime_incarnation())
            {
                *self = candidate;
                changed = true;
                actions.extend(next_actions);
            }
        }
        (actions, changed)
    }
    fn start_job(
        &mut self,
        host_id: String,
        remote_path: String,
        cache_directory: String,
        incarnation: u64,
    ) -> Result<String> {
        self.admit(true)?;
        if remote_path.is_empty() || !PathBuf::from(&cache_directory).is_absolute() {
            return Err(invalid("Invalid download path"));
        }
        let id = token();
        let host_identity =
            crate::get_host_runtime(host_id.clone()).map(|runtime| runtime.download_identity());
        let mut job = Job {
            id: id.clone(),
            host_id,
            name: remote_path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or("download")
                .into(),
            remote_path,
            created_at: now_ms(),
            phase: Phase::Selecting,
            bytes_transferred: 0,
            total_bytes: None,
            destination_directory: None,
            permission: None,
            transfer_id: None,
            cancel_requested: false,
            saved: None,
            error: None,
            failed_phase: None,
            bytes_per_second: None,
            remaining_seconds: None,
            rate_calculating: None,
            operation: Operation {
                generation: 1,
                incarnation,
                host_identity,
                execution_id: token(),
                staging: Some(
                    PathBuf::from(cache_directory)
                        .join(format!("whip-job-{id}-1"))
                        .to_string_lossy()
                        .into(),
                ),
                ..Operation::default()
            },
        };
        job.schedule(Step::Select);
        self.ledger.jobs.insert(0, job);
        Ok(id)
    }
    fn acknowledge(&mut self, command: Command) -> Result<(bool, Vec<Action>)> {
        let Command::Ack {
            id,
            effect_id,
            owner,
            directory,
            permission,
            saved,
            error,
            cancelled,
        } = command
        else {
            return Err(invalid("Expected destination effect acknowledgement"));
        };
        let mut actions = Vec::new();
        let Some(index) = self.ledger.jobs.iter().position(|job| {
            job.id == id
                && job.operation.effect_id == effect_id
                && job.operation.owner.as_ref() == Some(&owner)
        }) else {
            return Ok((false, actions));
        };
        let job = &mut self.ledger.jobs[index];
        let step = job.operation.step;
        job.operation.owner = None;
        if let Some(directory) = directory.as_ref() {
            job.destination_directory = Some(directory.clone());
        }
        if let Some(permission) = permission.as_ref() {
            job.permission = Some(permission.clone());
        }
        if let Some(saved) = saved {
            job.saved = Some(saved);
        }
        if let Some(error) = error {
            job.error = Some(error);
            job.failed_phase = Some(if step == Step::Save || step == Step::Delete {
                Phase::Saving
            } else {
                job.phase
            });
            if !(job.cancel_requested
                || matches!(step, Step::End | Step::Delete) && job.phase == Phase::Completed)
            {
                job.phase = Phase::Failed;
            }
            if matches!(step, Step::End | Step::Delete) {
                job.operation.remove = false;
                job.schedule(Step::Idle);
            } else {
                job.schedule(Step::End);
            }
        } else if cancelled {
            job.stop(true);
            job.schedule(Step::End);
        } else {
            match step {
                Step::Select if job.phase == Phase::Selecting => {
                    job.destination_directory =
                        Some(directory.ok_or_else(|| invalid("Missing selected destination"))?);
                    job.permission = Some(permission.unwrap_or_default());
                    job.phase = Phase::Queued;
                    job.schedule(Step::Begin);
                }
                Step::Begin if job.phase == Phase::Queued => {
                    job.phase = Phase::Downloading;
                    job.rate_calculating = Some(true);
                    job.schedule(Step::Transfer);
                    actions.push(Action::Start(Box::new(job.clone())));
                }
                Step::Save if job.phase == Phase::Saving && !job.cancel_requested => {
                    if job.saved.is_none() {
                        return Err(invalid("Save completion requires the verified destination"));
                    }
                    job.phase = Phase::Completed;
                    job.schedule(Step::End);
                }
                Step::End => {
                    if !job.operation.uncertain_save
                        && let Some(staging) = &job.operation.staging
                    {
                        actions.push(Action::Cleanup(staging.clone()));
                    }
                    if job.saved.is_some()
                        && (matches!(job.phase, Phase::Paused | Phase::Cancelled)
                            || job.operation.remove && job.operation.delete_local)
                    {
                        job.schedule(Step::Delete);
                    } else if job.operation.remove {
                        self.ledger.jobs.remove(index);
                    } else {
                        job.schedule(Step::Idle);
                    }
                }
                Step::Delete => {
                    job.saved = None;
                    if job.operation.remove {
                        self.ledger.jobs.remove(index);
                    } else {
                        job.schedule(Step::Idle);
                    }
                }
                _ => {
                    job.schedule(Step::End);
                }
            }
        }
        if let Some(job) = self
            .ledger
            .jobs
            .get_mut(index)
            .filter(|job| job.id == id && job.phase != Phase::Downloading)
        {
            job.clear_rate();
        }

        Ok((true, actions))
    }
    fn apply(&mut self, command: Command) -> Result<(Response, Vec<Action>, bool)> {
        let mut actions = Vec::new();
        let mut accepted = true;
        let mut created_id = None;
        let mut durable = true;
        let mut claimed = Vec::new();
        match command {
            Command::Snapshot => durable = false,
            Command::Attach { owner } => {
                if self
                    .owner
                    .as_ref()
                    .is_some_and(|previous| previous != &owner)
                {
                    for job in self
                        .ledger
                        .jobs
                        .iter_mut()
                        .filter(|job| job.operation.owner.is_some())
                    {
                        job.detach_adapter();
                    }
                }
                self.owner = Some(owner);
            }
            Command::Claim { owner } => {
                if self.owner.as_ref() != Some(&owner) {
                    return Err(invalid("Download adapter was replaced"));
                }
                for job in &mut self.ledger.jobs {
                    if !matches!(job.operation.step, Step::Idle | Step::Transfer)
                        && job.operation.owner.is_none()
                    {
                        job.operation.owner = Some(owner.clone());
                        claimed.push(Effect {
                            id: job.id.clone(),
                            token: job.operation.effect_id.clone(),
                            kind: job.operation.step,
                            job: job.clone(),
                        });
                    }
                }
                durable = false;
            }
            Command::Start {
                host_id,
                remote_path,
                cache_directory,
                incarnation,
            } => {
                created_id =
                    Some(self.start_job(host_id, remote_path, cache_directory, incarnation)?);
            }
            Command::Retry {
                id,
                cache_directory,
                choose_destination,
                incarnation,
            } => {
                actions.extend(self.retry_job(
                    &id,
                    cache_directory,
                    choose_destination,
                    incarnation,
                )?);
            }
            Command::Resume {
                host_id,
                cache_directory,
            } => {
                for job in &mut self.ledger.jobs {
                    if job.phase == Phase::Paused
                        && !job.cancel_requested
                        && host_id.as_ref().is_none_or(|host| host == &job.host_id)
                    {
                        job.operation.resume_cache = Some(cache_directory.clone());
                    }
                }
            }
            Command::Cancel { ref id } | Command::Pause { ref id } => {
                let cancelled = matches!(&command, Command::Cancel { .. });
                if let Some(job) = self.ledger.jobs.iter_mut().find(|job| &job.id == id) {
                    job.stop(cancelled);
                    actions.push(Action::Cancel(job.operation.execution_id.clone()));
                }
            }
            Command::Expire {
                execution_id,
                cancelled,
            } => {
                if let Some(job) = self
                    .ledger
                    .jobs
                    .iter_mut()
                    .find(|job| job.operation.execution_id == execution_id && job.busy())
                {
                    job.stop(cancelled);
                    actions.push(Action::Cancel(job.operation.execution_id.clone()));
                } else {
                    accepted = false;
                }
            }
            Command::Remove { id, delete_local } => {
                if let Some(job) = self.ledger.jobs.iter_mut().find(|job| job.id == id) {
                    job.operation.remove = true;
                    job.operation.delete_local =
                        delete_local || job.busy() || job.phase == Phase::Paused;
                    if job.busy() {
                        job.stop(true);
                        actions.push(Action::Cancel(job.operation.execution_id.clone()));
                    } else if job.operation.delete_local && job.saved.is_some() {
                        job.schedule(Step::Delete);
                    } else {
                        self.ledger.jobs.retain(|job| job.id != id);
                    }
                }
            }
            command @ Command::Ack { .. } => {
                let (acknowledged, next_actions) = self.acknowledge(command)?;
                accepted = acknowledged;
                durable = acknowledged;
                actions.extend(next_actions);
            }
            Command::Bound {
                id,
                generation,
                transfer_id,
            } => {
                if let Some(job) = self.ledger.jobs.iter_mut().find(|job| {
                    job.id == id
                        && job.operation.generation == generation
                        && job.operation.step == Step::Transfer
                }) {
                    job.transfer_id = Some(transfer_id);
                    accepted = !job.cancel_requested && job.phase == Phase::Downloading;
                } else {
                    accepted = false;
                }
            }
            Command::Progress {
                id,
                generation,
                bytes,
                total,
                speed,
                remaining,
                calculating,
            } => {
                if let Some(job) = self.ledger.jobs.iter_mut().find(|job| {
                    job.id == id
                        && job.operation.generation == generation
                        && job.phase == Phase::Downloading
                }) {
                    job.observe(bytes, total, speed, remaining, calculating);
                } else {
                    accepted = false;
                }
                durable = self.checkpoint.elapsed() >= Duration::from_secs(1);
            }
            Command::Finished {
                id,
                generation,
                source,
                error,
            } => {
                if let Some(job) = self.ledger.jobs.iter_mut().find(|job| {
                    job.id == id
                        && job.operation.generation == generation
                        && job.operation.step == Step::Transfer
                }) {
                    job.clear_rate();
                    if job.phase != Phase::Downloading || job.cancel_requested {
                        job.schedule(Step::End);
                    } else if let Some(error) = error {
                        job.phase = Phase::Failed;
                        job.failed_phase = Some(Phase::Downloading);
                        job.error = Some(error);
                        job.schedule(Step::End);
                    } else if let Some(source) = source {
                        if let Ok(metadata) = std::fs::metadata(&source)
                            && metadata.is_file()
                        {
                            job.bytes_transferred = metadata.len();
                            job.total_bytes = Some(metadata.len());
                        }
                        job.operation.source = Some(source);
                        job.phase = Phase::Saving;
                        job.schedule(Step::Save);
                    } else {
                        return Err(invalid("Native transfer returned no local path"));
                    }
                } else {
                    accepted = false;
                }
            }
        }
        let (resumed, changed) = self.resume_ready();
        durable |= changed;
        actions.extend(resumed);
        self.revision = self.revision.saturating_add(1);
        let mut response = self.response(accepted, created_id)?;
        response.effects = claimed;
        Ok((response, actions, durable))
    }
}

fn transact(store: &mut Store, command: Command) -> Result<(Response, Vec<Action>)> {
    let initial = store.downloads.is_none();
    let mut next = match &store.downloads {
        Some(manager) => manager.clone(),
        None => Manager::load(store)?,
    };
    let mut actions = Vec::new();
    if initial {
        actions.extend(
            next.ledger
                .jobs
                .iter()
                .filter(|job| !job.operation.uncertain_save)
                .filter_map(|job| job.operation.staging.clone())
                .map(Action::Cleanup),
        );
    }
    let expirations = native::pending_expirations();
    for (execution_id, cancelled) in &expirations {
        let (_, expiry_actions, _) = next.apply(Command::Expire {
            execution_id: execution_id.clone(),
            cancelled: *cancelled,
        })?;
        actions.extend(expiry_actions);
    }
    let (response, next_actions, durable) = next.apply(command)?;
    actions.extend(next_actions);
    if initial || durable || !expirations.is_empty() {
        next.save(store)?;
        next.checkpoint = Instant::now();
    }
    store.downloads = Some(next);
    native::acknowledge_expirations(expirations.len());
    Ok((response, actions))
}

async fn dispatch(command: Command) -> Result<Response> {
    let (response, actions) = database()?
        .request(move |store| transact(store, command))
        .await?;
    for action in actions {
        native::execute(action);
    }
    Ok(response)
}

/// JSON command protocol shared by the mobile destination adapters. Internal
/// transfer events cannot be submitted by a foreign caller.
#[uniffi::export]
pub async fn download_manager_command(command_json: String) -> Result<String> {
    let mut command: Command =
        serde_json::from_str(&command_json).map_err(|error| invalid(error.to_string()))?;
    native::validate_external(&mut command).await?;
    let response = dispatch(command).await?;
    serde_json::to_string(&response).map_err(|error| invalid(error.to_string()))
}
