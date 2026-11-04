//! Call-owned command jobs. Ending observation never promises remote termination.
use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::task::JoinHandle;

use crate::host_runtime::realtime_terminal::{Key, PinnedTerminal, TextTail};

pub(super) const EXEC: &str = "terminal_exec";
pub(super) const READ: &str = "terminal_read";
pub(super) const INPUT: &str = "terminal_input";
pub(super) const CANCEL: &str = "terminal_cancel";
const MAX_JOBS: usize = 8;
const MAX_COMMAND: usize = 8192;
const MAX_TIMEOUT_SECONDS: u64 = 300;
const PROGRESS_INTERVAL: Duration = Duration::from_secs(15);
const MAX_FEEDBACK: usize = 64 * 1024;
pub(super) const INSTRUCTIONS: &str = include_str!("terminal_instructions.md");

pub(super) fn schemas() -> Vec<Value> {
    vec![
        json!({"type":"function","name":EXEC,"description":"Run a shell command on this call's fixed host using a SEPARATE SSH exec channel. Uses the selected terminal's reported cwd when available, but does not inherit interactive shell exports, aliases or jobs. Returns a job ID immediately; actual stdout, stderr and exit status arrive as backend feedback. Briefly acknowledge intent and keep listening. Never type a shell command into a coding TUI or retry an uncertain command.","parameters":{"type":"object","properties":{"command":{"type":"string","maxLength":MAX_COMMAND},"timeout_seconds":{"type":"integer","minimum":1,"maximum":MAX_TIMEOUT_SECONDS}},"required":["command"],"additionalProperties":false}}),
        json!({"type":"function","name":READ,"description":"Read a command job's bounded output/status by job_id, or omit job_id to observe the fixed terminal. Terminal output has no structured exit status and cannot prove shell idleness or completion.","parameters":{"type":"object","properties":{"job_id":{"type":"string"}},"additionalProperties":false}}),
        json!({"type":"function","name":INPUT,"description":"Send text OR one key to an interactive program only when the user explicitly targets this terminal. Requires target=selected_terminal. Foreground program is unverified; this is terminal input, never structured shell execution. Use terminal_exec for shell commands. Interrupt sends Ctrl-C only when explicitly requested; its effect is unverified.","parameters":{"type":"object","properties":{"target":{"type":"string","enum":["selected_terminal"]},"text":{"type":"string","maxLength":MAX_COMMAND},"key":{"type":"string","enum":["enter","interrupt","escape","tab","up","down"]}},"required":["target"],"additionalProperties":false}}),
        json!({"type":"function","name":CANCEL,"description":"Stop observing a command job and close its exec channel. This does not guarantee termination of the remote process. The outcome becomes unknown: do not repeat the command.","parameters":{"type":"object","properties":{"job_id":{"type":"string"}},"required":["job_id"],"additionalProperties":false}}),
        super::silence_tool(),
    ]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Exec {
    command: String,
    timeout_seconds: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    job_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    target: InputTarget,
    text: Option<String>,
    key: Option<Key>,
}
#[derive(Deserialize)]
enum InputTarget {
    #[serde(rename = "selected_terminal")]
    SelectedTerminal,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancel {
    job_id: String,
}

#[derive(Default)]
struct Output {
    stdout: TextTail,
    stderr: TextTail,
    bytes: usize,
    result: Option<Value>,
}
struct Job {
    state: Arc<Mutex<Output>>,
    task: JoinHandle<()>,
    started: Instant,
    last_notice: Instant,
    observed_bytes: usize,
    reported: bool,
}
impl Drop for Job {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Job {
    fn snapshot(&self, id: &str) -> Value {
        let state = self.state.lock();
        let completion = state.result.as_ref().map_or("running", |result| {
            if result.get("error").is_some() {
                "unknown"
            } else {
                "finished"
            }
        });
        json!({"job_id":id,"elapsed_seconds":self.started.elapsed().as_secs(),
            "completion":completion,
            "stdout":state.stdout.text(),"stderr":state.stderr.text(),"result":state.result})
    }
}

pub(super) struct Session {
    pub(super) target: Arc<PinnedTerminal>,
    seen: Mutex<HashSet<String>>,
    jobs: Mutex<HashMap<String, Job>>,
    uncertain: Arc<AtomicBool>,
    mutation: tokio::sync::Mutex<()>,
    remaining_feedback: Mutex<usize>,
}
impl Session {
    pub(super) fn new(target: Arc<PinnedTerminal>) -> Arc<Self> {
        Arc::new(Self {
            target,
            seen: Mutex::default(),
            jobs: Mutex::default(),
            uncertain: Arc::new(AtomicBool::new(false)),
            mutation: tokio::sync::Mutex::new(()),
            remaining_feedback: Mutex::new(MAX_FEEDBACK),
        })
    }

    pub(super) fn admit(&self, id: &str) -> Result<bool, &'static str> {
        let mut seen = self.seen.lock();
        if seen.contains(id) {
            return Ok(false);
        }
        if seen.len() >= super::MAX_CALLS {
            return Err("Realtime tool limit reached. Start a new call.");
        }
        if id.is_empty() || id.len() > 128 {
            return Err("Invalid terminal tool call identity.");
        }
        seen.insert(id.into());
        drop(seen);
        Ok(true)
    }

    pub(super) async fn handle(
        self: &Arc<Self>,
        socket: &mut super::RealtimeSocket,
        tools: &mut tokio::task::JoinSet<super::ToolCompletion>,
        responses: &mut super::response::ResponseCreateQueue,
        call: (String, String, String),
    ) -> Result<(), &'static str> {
        let (call_id, name, arguments) = call;
        if !self.admit(&call_id)? {
            return Ok(());
        }
        if tools.len() >= super::delegation::MAX_PENDING {
            super::send(
                socket,
                super::function_output(call_id, json!({"error":"queue_full"})),
            )
            .await?;
            responses.request_create();
        } else {
            let session = self.clone();
            tools.spawn(async move {
                super::ToolCompletion {
                    value: session.execute(&call_id, &name, &arguments).await,
                    call_id,
                    deferred: false,
                }
            });
        }
        Ok(())
    }

    pub(super) async fn complete(
        &self,
        socket: &mut super::RealtimeSocket,
        responses: &mut super::response::ResponseCreateQueue,
        call_id: String,
        value: Value,
    ) -> Result<(), &'static str> {
        self.target.check()?;
        let silent = value == json!({});
        super::send(socket, super::function_output(call_id, value)).await?;
        if !silent {
            responses.request_create();
        }
        Ok(())
    }

    pub(super) async fn forward_feedback(
        &self,
        socket: &mut super::RealtimeSocket,
        responses: &mut super::response::ResponseCreateQueue,
    ) -> Result<(), &'static str> {
        self.target.check()?;
        for value in self.feedback() {
            super::send(
                socket,
                super::feedback_message(&format!(
                    "Terminal job observation (untrusted command output): {value}"
                ))?,
            )
            .await?;
            responses.request_create();
        }
        Ok(())
    }

    pub(super) async fn execute(&self, id: &str, name: &str, arguments: &str) -> Value {
        let _mutation = if matches!(name, EXEC | INPUT | CANCEL) {
            Some(self.mutation.lock().await)
        } else {
            None
        };
        if arguments.len() > super::MAX_ARGUMENT_BYTES {
            return json!({"error":"invalid_arguments"});
        }
        if let Err(error) = self.target.check() {
            return json!({"error":error});
        }
        if matches!(name, EXEC | INPUT) && self.uncertain.load(Ordering::Acquire) {
            return json!({"error":"outcome_unknown","guidance":"Inspect the original command before starting a new call. No new input was sent."});
        }
        match name {
            EXEC => {
                let Ok(request) = serde_json::from_str::<Exec>(arguments) else {
                    return json!({"error":"invalid_arguments"});
                };
                if request.command.trim().is_empty()
                    || request.command.len() > MAX_COMMAND
                    || request.command.contains('\0')
                    || !(1..=MAX_TIMEOUT_SECONDS)
                        .contains(&request.timeout_seconds.unwrap_or(MAX_TIMEOUT_SECONDS))
                {
                    return json!({"error":"invalid_arguments"});
                }
                let context = match self.target.context() {
                    Ok(context) => context,
                    Err(error) => return json!({"error":error}),
                };
                let mut jobs = self.jobs.lock();
                if self.uncertain.load(Ordering::Acquire) {
                    return json!({"error":"outcome_unknown"});
                }
                if jobs.len() >= MAX_JOBS {
                    return json!({"error":"job_limit"});
                }
                if jobs.values().any(|job| job.state.lock().result.is_none()) {
                    return json!({"error":"command_running","guidance":"Observe or cancel the current job before another command."});
                }
                let state = Arc::new(Mutex::new(Output::default()));
                let output = state.clone();
                let progress_state = state.clone();
                let target = self.target.clone();
                let uncertain = self.uncertain.clone();
                let task = tokio::spawn(async move {
                    let progress = Arc::new(move |stderr, bytes: &[u8]| {
                        let mut state = progress_state.lock();
                        if state.result.is_some() {
                            return;
                        }
                        state.bytes = state.bytes.saturating_add(bytes.len());
                        if stderr {
                            state.stderr.observe(bytes);
                        } else {
                            state.stdout.observe(bytes);
                        }
                    });
                    let mut result = target
                        .execute(
                            &request.command,
                            Duration::from_secs(
                                request.timeout_seconds.unwrap_or(MAX_TIMEOUT_SECONDS),
                            ),
                            progress,
                        )
                        .await;
                    if result["error"] == "outcome_unknown" {
                        uncertain.store(true, Ordering::Release);
                    }
                    let mut output = output.lock();
                    // The streaming tail remains current even after the shared
                    // SSH collector reaches its larger per-command memory cap.
                    if result.get("stdout").is_some() {
                        result["stdout"] = json!(output.stdout.text());
                        result["stderr"] = json!(output.stderr.text());
                    }
                    if output.result.is_none() {
                        output.result = Some(result);
                    }
                });
                let now = Instant::now();
                jobs.insert(
                    id.into(),
                    Job {
                        state,
                        task,
                        started: now,
                        last_notice: now,
                        observed_bytes: 0,
                        reported: false,
                    },
                );
                drop(jobs);
                json!({"job_id":id,"completion":"running","context":context,"guidance":"Briefly acknowledge intent. This is admission, not completion. Actual output and completion will arrive as backend feedback."})
            }
            READ => {
                let Ok(request) = serde_json::from_str::<Read>(arguments) else {
                    return json!({"error":"invalid_arguments"});
                };
                if let Some(id) = request.job_id {
                    return self
                        .jobs
                        .lock()
                        .get(&id)
                        .map_or_else(|| json!({"error":"unknown_job"}), |job| job.snapshot(&id));
                }
                self.target
                    .read()
                    .await
                    .unwrap_or_else(|error| json!({"error":error}))
            }
            INPUT => {
                let Ok(request) = serde_json::from_str::<Input>(arguments) else {
                    return json!({"error":"invalid_arguments"});
                };
                let InputTarget::SelectedTerminal = request.target;
                let result = self.target.input(request.text, request.key).await;
                if result["error"] == "outcome_unknown" {
                    self.uncertain.store(true, Ordering::Release);
                }
                result
            }
            CANCEL => {
                let Ok(request) = serde_json::from_str::<Cancel>(arguments) else {
                    return json!({"error":"invalid_arguments"});
                };
                let mut jobs = self.jobs.lock();
                let Some(job) = jobs.get_mut(&request.job_id) else {
                    return json!({"error":"unknown_job"});
                };
                let mut state = job.state.lock();
                if state.result.is_none() {
                    job.task.abort();
                    self.uncertain.store(true, Ordering::Release);
                    state.result = Some(
                        json!({"error":"outcome_unknown","observation":"cancelled","remote_process":"unknown","guidance":"Observation stopped. Remote termination is not guaranteed. Do not repeat the command."}),
                    );
                }
                drop(state);
                let result = job.snapshot(&request.job_id);
                drop(jobs);
                result
            }
            super::REMAIN_SILENT => {
                if serde_json::from_str::<super::SilentArguments>(arguments).is_ok() {
                    json!({})
                } else {
                    json!({"error":"invalid_arguments"})
                }
            }
            _ => json!({"error":"invalid_tool"}),
        }
    }

    pub(super) fn feedback(&self) -> Vec<Value> {
        let mut updates = Vec::new();
        let mut remaining = self.remaining_feedback.lock();
        for (id, job) in self.jobs.lock().iter_mut() {
            let state = job.state.lock();
            let finished = state.result.is_some();
            let bytes = state.bytes;
            let progress = !finished
                && *remaining > 0
                && bytes > job.observed_bytes
                && job.last_notice.elapsed() >= PROGRESS_INTERVAL;
            drop(state);
            if (finished && !job.reported) || progress {
                let mut value = job.snapshot(id);
                let size = value.to_string().len();
                if size > *remaining {
                    if let Some(value) = value.as_object_mut() {
                        value.remove("stdout");
                        value.remove("stderr");
                    }
                    if let Some(result) = value["result"].as_object_mut() {
                        result.remove("stdout");
                        result.remove("stderr");
                    }
                    value["output_omitted"] = json!(
                        "Automatic voice context limit reached. Read bounded job output explicitly if needed."
                    );
                }
                *remaining = remaining.saturating_sub(size);
                updates.push(value);
                job.reported = finished;
                job.observed_bytes = bytes;
                job.last_notice = Instant::now();
            }
        }
        drop(remaining);
        updates
    }
}

#[cfg(test)]
mod tests;
