//! Process-owned transcript integration. mobile-speech owns the portable queue;
//! native adapters wake and complete it without a JavaScript playback loop.
use crate::{
    AgentMessageRole, AgentScalarValue, AgentTranscriptKind, AgentTranscriptMessage,
    AgentTranscriptPart, AgentTranscriptState, AgentTranscriptStatus, AutomaticChatSpeechQueue,
    ChatSpeechMessage, ChatSpeechPart,
};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char},
    sync::{LazyLock, OnceLock},
    time::{Duration, Instant},
};

pub(crate) const OWNER: &str = "automatic-chat-speech";
const SHAKE_PAUSE_MS: u64 = 1_000;
static AUTOMATIC: LazyLock<Mutex<Coordinator>> = LazyLock::new(Mutex::default);
static WAKE: OnceLock<extern "C" fn()> = OnceLock::new();
static START: LazyLock<Instant> = LazyLock::new(Instant::now);

fn now_ms() -> u64 {
    u64::try_from(START.elapsed().as_millis()).unwrap_or(u64::MAX)
}
fn source_key(incarnation: u64, key: &str) -> String {
    format!("{incarnation}/{key}")
}

struct Source {
    runtime_id: String,
    authority: Option<crate::agent_sessions::AutomaticSpeechSource>,
    pending_baseline: bool,
    epoch: u64,
    revision: u64,
    agent: AgentTranscriptKind,
    status: AgentTranscriptStatus,
    host_id: String,
    pane_id: String,
    tab_name: String,
    bindings: HashMap<String, Binding>,
}

struct Binding {
    token: String,
    pane: String,
}

#[derive(Default)]
struct Coordinator {
    enabled: bool,
    paused: bool,
    locked: bool,
    silenced: bool,
    initializing: bool,
    baseline_generation: u64,
    resume_at: Option<u64>,
    sources: HashMap<String, Source>,
    queue: AutomaticChatSpeechQueue,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum EndReason {
    Completed,
    Stopped,
    Shake,
    Replaced,
    Interrupted,
    Busy,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum Command {
    Enable {
        enabled: bool,
    },
    Pause {
        paused: bool,
    },
    Lock {
        locked: bool,
    },
    Bind {
        binding_token: String,
        host_id: String,
        tab_name: String,
    },
    Take,
    Valid {
        id: u64,
    },
    Completed {
        id: u64,
    },
    Ended {
        id: u64,
        reason: EndReason,
        failed: bool,
    },
}

impl Coordinator {
    fn restore_baseline(
        &mut self,
        generation: u64,
        key: &str,
        epoch: u64,
        status: AgentTranscriptStatus,
        view: crate::AgentTranscriptView<'_>,
        now: u64,
    ) -> bool {
        if !self.enabled
            || self.baseline_generation != generation
            || !self
                .sources
                .get(key)
                .is_some_and(|source| source.pending_baseline && source.epoch <= epoch)
        {
            return false;
        }
        self.accept(
            key,
            epoch,
            view.revision,
            status,
            view.messages.iter(),
            true,
            now,
        );
        true
    }
    fn needs_baseline(&self, key: &str, epoch: u64, status: AgentTranscriptStatus) -> bool {
        self.enabled
            && self.sources.get(key).is_some_and(|source| {
                source.pending_baseline
                    || source.epoch != epoch
                    || (source.status != AgentTranscriptStatus::Live
                        && status == AgentTranscriptStatus::Live)
            })
    }
    fn allowed(&self) -> bool {
        self.enabled && !self.initializing && !self.paused && !self.locked && !self.silenced
    }

    fn command(&mut self, command: Command, now: u64) -> Value {
        match command {
            Command::Enable { enabled } => {
                if self.enabled != enabled {
                    let Some(generation) = self.baseline_generation.checked_add(1) else {
                        self.enabled = false;
                        self.queue.reset();
                        return Value::Null;
                    };
                    self.baseline_generation = generation;
                    self.enabled = enabled;
                    self.silenced = false;
                    self.resume_at = None;
                    self.queue.reset();
                    for source in self.sources.values_mut() {
                        source.pending_baseline = enabled;
                    }
                    self.initializing = enabled && !self.sources.is_empty();
                }
            }
            Command::Pause { paused } => {
                self.paused = paused;
                if paused {
                    self.queue.clear_pending();
                }
            }
            Command::Lock { locked } => {
                self.locked = locked;
                if locked {
                    self.queue.clear_pending();
                }
            }
            Command::Bind {
                binding_token,
                host_id,
                tab_name,
            } => {
                for source in self.sources.values_mut() {
                    if let Some(binding) = source
                        .bindings
                        .values()
                        .find(|binding| binding.token == binding_token)
                    {
                        source.host_id.clone_from(&host_id);
                        source.pane_id.clone_from(&binding.pane);
                        source.tab_name = tab_name.chars().take(80).collect();
                    }
                }
            }
            Command::Take => {
                if !self.allowed() || self.resume_at.is_some_and(|at| now < at) {
                    return Value::Null;
                }
                let Some(playback) = self.queue.take_native(now) else {
                    return Value::Null;
                };
                let Some(source) = self.sources.get(&playback.item.source) else {
                    self.queue.remove(playback.item.source);
                    return Value::Null;
                };
                return json!({ "id": playback.id, "token": OWNER, "text": playback.item.text,
                    "hostId": source.host_id, "paneId": source.pane_id, "label": source.tab_name });
            }
            Command::Valid { id } => {
                return json!(self.allowed() && self.queue.active_id() == Some(id));
            }
            Command::Completed { id } => return json!(self.queue.complete_native(id)),
            Command::Ended { id, reason, failed } => {
                if self.queue.active_id() != Some(id) {
                    return Value::Null;
                }
                if matches!(reason, EndReason::Shake) && !failed {
                    self.queue.dismiss_current();
                    self.resume_at = Some(now.saturating_add(SHAKE_PAUSE_MS));
                } else {
                    self.silenced = matches!(reason, EndReason::Stopped) && !failed;
                    self.queue.clear_pending();
                }
            }
        }
        Value::Null
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "Internal authoritative transcript identity and borrowed content"
    )]
    fn accept<'a>(
        &mut self,
        key: &str,
        epoch: u64,
        revision: u64,
        status: AgentTranscriptStatus,
        messages: impl Iterator<Item = &'a AgentTranscriptMessage>,
        reset: bool,
        now: u64,
    ) {
        let allowed = self.allowed();
        let Some(source) = self.sources.get_mut(key) else {
            return;
        };
        if epoch < source.epoch
            || (epoch == source.epoch
                && revision <= source.revision
                && !(reset && source.pending_baseline))
        {
            return;
        }
        let baseline = reset
            || epoch != source.epoch
            || source.status != AgentTranscriptStatus::Live
            || !allowed;
        if reset || epoch != source.epoch {
            self.queue.remove(key.into());
        }
        source.epoch = epoch;
        source.revision = revision;
        source.status = status;
        if status == AgentTranscriptStatus::Closed {
            // Keep only binding presentation metadata for a possible reopen;
            // closed histories must not retain another speech-prefix index.
            self.queue.remove(key.into());
            source.pending_baseline = false;
            return;
        }
        if !self.enabled {
            return;
        }
        // Muted/stale updates advance baselines while the enabled reader is
        // paused. Disabled readers retain no prose or spoken-prefix index.
        self.queue.update(
            key.into(),
            source.agent,
            source.tab_name.clone(),
            true,
            baseline || status != AgentTranscriptStatus::Live,
            messages
                .filter(|message| message.role == AgentMessageRole::Assistant)
                .map(speech_message)
                .collect(),
            now,
        );
        if status != AgentTranscriptStatus::Live {
            self.queue.clear_source_pending(key);
        }
        if reset {
            source.pending_baseline = false;
        }
        if self.initializing && self.sources.values().all(|source| !source.pending_baseline) {
            self.initializing = false;
        }
    }
}

fn speech_message(message: &AgentTranscriptMessage) -> ChatSpeechMessage {
    ChatSpeechMessage {
        id: message.id.clone(),
        assistant: message.role == AgentMessageRole::Assistant,
        completed: message.completed_at_ms.is_some(),
        prose: message
            .parts
            .iter()
            .filter_map(|part| match part {
                AgentTranscriptPart::Text { id, text, .. } => Some(ChatSpeechPart::Text {
                    id: id.clone(),
                    text: text.clone(),
                }),
                AgentTranscriptPart::Tool {
                    id, tool, state, ..
                } if crate::agent_transcript::is_question_tool(tool) => {
                    let summary = state
                        .input
                        .iter()
                        .find(|field| field.key == "question_summary")
                        .and_then(|field| match &field.value {
                            AgentScalarValue::String { value } => Some(value.clone()),
                            _ => None,
                        })
                        .unwrap_or_default();
                    Some(ChatSpeechPart::Tool {
                        id: id.clone(),
                        tool: tool.clone(),
                        summary,
                        questions: state.questions.clone(),
                    })
                }
                AgentTranscriptPart::Notice { id, questions, .. } if !questions.is_empty() => {
                    Some(ChatSpeechPart::Notice {
                        id: id.clone(),
                        questions: questions.clone(),
                    })
                }
                _ => None,
            })
            .collect(),
    }
}

/// Called while the manager's authoritative binding is current. No native work.
#[allow(
    clippy::too_many_arguments,
    reason = "Binding identity stays at the application integration boundary"
)]
pub(crate) fn bound(
    runtime_id: &str,
    incarnation: u64,
    key: &str,
    epoch: u64,
    terminal: &str,
    pane: &str,
    token: &str,
    state: &AgentTranscriptState,
    authority: crate::agent_sessions::AutomaticSpeechSource,
) {
    let mut coordinator = AUTOMATIC.lock();
    let key = source_key(incarnation, key);
    let enabled = coordinator.enabled;
    let indexed = coordinator.queue.has_source(&key);
    let source = coordinator
        .sources
        .entry(key.clone())
        .or_insert_with(|| Source {
            runtime_id: runtime_id.into(),
            authority: None,
            pending_baseline: false,
            epoch,
            revision: state.revision,
            agent: state.agent,
            status: state.status,
            host_id: runtime_id.into(),
            pane_id: pane.into(),
            tab_name: String::new(),
            bindings: HashMap::new(),
        });
    if epoch < source.epoch {
        return;
    }
    source.authority = Some(authority);
    source.bindings.insert(
        terminal.into(),
        Binding {
            token: token.into(),
            pane: pane.into(),
        },
    );
    let baseline = enabled && (!indexed || source.pending_baseline);
    if baseline {
        source.pending_baseline = false;
        source.epoch = epoch;
        source.revision = state.revision;
        source.status = state.status;
    }
    // A fresh enabled source is silent; disabled bindings store only metadata.
    if baseline && state.status != AgentTranscriptStatus::Closed {
        coordinator.queue.update(
            key,
            state.agent,
            String::new(),
            true,
            true,
            state
                .messages
                .iter()
                .filter(|message| message.role == AgentMessageRole::Assistant)
                .map(speech_message)
                .collect(),
            now_ms(),
        );
    }
}

pub(crate) fn tracking_enabled() -> bool {
    AUTOMATIC.lock().enabled
}

fn prepare_baselines(
    generation: u64,
    sources: Vec<(String, crate::agent_sessions::AutomaticSpeechSource)>,
) {
    let Ok(runtime) = crate::runtime() else {
        let mut coordinator = AUTOMATIC.lock();
        if coordinator.baseline_generation == generation {
            coordinator.initializing = false;
        }
        drop(coordinator);
        wake();
        return;
    };
    runtime.spawn_blocking(move || {
        for (key, source) in sources {
            source.baseline(|epoch, status, view| {
                AUTOMATIC
                    .lock()
                    .restore_baseline(generation, &key, epoch, status, view, now_ms());
            });
        }
        let mut coordinator = AUTOMATIC.lock();
        if coordinator.baseline_generation == generation {
            coordinator.initializing = false;
        }
        drop(coordinator);
        wake();
    });
}

#[allow(
    clippy::too_many_arguments,
    reason = "Borrow canonical records instead of copying transcript histories"
)]
pub(crate) fn accept<'a>(
    incarnation: u64,
    key: &str,
    epoch: u64,
    revision: u64,
    status: AgentTranscriptStatus,
    messages: impl Iterator<Item = &'a AgentTranscriptMessage>,
    reset: bool,
) {
    AUTOMATIC.lock().accept(
        &source_key(incarnation, key),
        epoch,
        revision,
        status,
        messages,
        reset,
        now_ms(),
    );
}

pub(crate) fn needs_baseline(
    incarnation: u64,
    key: &str,
    epoch: u64,
    status: AgentTranscriptStatus,
) -> bool {
    AUTOMATIC
        .lock()
        .needs_baseline(&source_key(incarnation, key), epoch, status)
}

pub(crate) fn removed(incarnation: u64, key: &str, epoch: u64) {
    let key = source_key(incarnation, key);
    let mut coordinator = AUTOMATIC.lock();
    if coordinator
        .sources
        .get(&key)
        .is_some_and(|source| source.epoch <= epoch)
    {
        coordinator.sources.remove(&key);
        coordinator.queue.remove(key);
    }
    drop(coordinator);
    wake();
}

pub(crate) fn runtime_removed(runtime_id: &str, incarnation: u64) {
    let prefix = format!("{incarnation}/");
    let mut coordinator = AUTOMATIC.lock();
    let keys: Vec<_> = coordinator
        .sources
        .iter()
        .filter(|(key, source)| key.starts_with(&prefix) && source.runtime_id == runtime_id)
        .map(|(key, _)| key.clone())
        .collect();
    for key in keys {
        coordinator.sources.remove(&key);
        coordinator.queue.remove(key);
    }
    drop(coordinator);
    wake();
}

pub(crate) fn wake() {
    if let Some(wake) = WAKE.get() {
        wake();
    }
}

/// Remove a terminal binding before accepting its replacement. Called under the
/// manager lock, and deliberately performs no platform callbacks.
pub(crate) fn unbound(incarnation: u64, key: &str, terminal: &str) {
    let key = source_key(incarnation, key);
    let mut coordinator = AUTOMATIC.lock();
    let Some(source) = coordinator.sources.get_mut(&key) else {
        return;
    };
    source.bindings.remove(terminal);
    if source.bindings.is_empty() {
        coordinator.sources.remove(&key);
        coordinator.queue.remove(key);
    } else if let Some(binding) = source.bindings.values().next() {
        source.pane_id.clone_from(&binding.pane);
    }
    drop(coordinator);
}

/// Registers a process-lifetime native wake function. It must only enqueue work
/// onto the platform thread, never run playback inline on a transcript thread.
#[unsafe(no_mangle)]
pub extern "C" fn whip_automatic_speech_register(wake: extern "C" fn()) {
    let _ = WAKE.set(wake);
}

/// # Safety
/// `command` points to a live NUL-terminated UTF-8 JSON command for this call.
/// Free the result once with whip_alert_speech_free.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn whip_automatic_speech_command(command: *const c_char) -> *mut c_char {
    if command.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: The native adapters provide a live NUL-terminated command.
    let input = unsafe { CStr::from_ptr(command) }.to_bytes();
    let Ok(command) = serde_json::from_slice::<Command>(input) else {
        return std::ptr::null_mut();
    };
    let shake = matches!(
        &command,
        Command::Ended {
            reason: EndReason::Shake,
            failed: false,
            ..
        }
    );
    let changed = !matches!(command, Command::Take | Command::Valid { .. });
    let enable = matches!(command, Command::Enable { enabled: true });
    let mut coordinator = AUTOMATIC.lock();
    let previous_generation = coordinator.baseline_generation;
    let result = coordinator.command(command, now_ms());
    let baselines = (enable
        && coordinator.initializing
        && coordinator.baseline_generation != previous_generation)
        .then(|| {
            (
                coordinator.baseline_generation,
                coordinator
                    .sources
                    .iter()
                    .filter_map(|(key, source)| {
                        source
                            .authority
                            .as_ref()
                            .map(|source| (key.clone(), source.clone()))
                    })
                    .collect(),
            )
        });
    drop(coordinator);
    if let Some((generation, sources)) = baselines {
        prepare_baselines(generation, sources);
    }
    if changed {
        wake();
    }
    if shake && let Ok(runtime) = crate::runtime() {
        runtime.spawn(async {
            tokio::time::sleep(Duration::from_millis(SHAKE_PAUSE_MS)).await;
            wake();
        });
    }
    CString::new(result.to_string()).map_or(std::ptr::null_mut(), CString::into_raw)
}

#[cfg(test)]
mod tests;
