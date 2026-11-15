//! Explicit global-call operations, sharing the Phone Use parsers and executors.
use super::{
    Arc, AtomicBool, BrowserError, Deserialize, Duration, ErrorCode, Ordering, Value,
    WhipToolSession, application, decode, hosts, identifier, json, schema,
};
use crate::host_runtime::realtime_terminal::{ControlTarget, PinnedTerminal};
use crate::realtime_voice::terminal;

const WATCH: &str = "watch_operation";
const MAX_JOBS: usize = 8;
const MAX_STREAM_RESULT: usize = 4096;
const REMOTE: &[&str] = &[
    "hosts.connect",
    "hosts.disconnect",
    "agents.start",
    "agents.stop",
    "agents.restart",
    "agents.inspect",
    "agents.wait",
    "workspaces.create",
    "workspaces.focus",
    "workspaces.rename",
    "workspaces.close",
    "tabs.create",
    "tabs.focus",
    "tabs.rename",
    "tabs.close",
    "panes.split",
    "panes.focus",
    "panes.rename",
    "panes.zoom",
    "panes.close",
    "panes.inspect",
    "panes.read",
    "panes.read_visible",
];

pub(super) fn recognizes(name: &str) -> bool {
    matches!(name, terminal::EXEC | terminal::READ | terminal::CANCEL)
        || REMOTE.contains(&name.replacen('_', ".", 1).as_str())
}

fn read_only(name: &str) -> bool {
    matches!(
        name,
        "agents.inspect" | "agents.wait" | "panes.inspect" | "panes.read" | "panes.read_visible"
    )
}

fn saved_profiles(host: &str) -> Result<Vec<crate::HostProfileRecord>, BrowserError> {
    let profiles = hosts::voice_context()?.hosts;
    if !profiles.iter().any(|profile| profile.id == host) {
        return Err(BrowserError::new(ErrorCode::NotFound, "Unknown saved host"));
    }
    Ok(profiles)
}

pub(super) struct CommandSession {
    host: String,
    id: String,
    session: Arc<terminal::Session>,
    monitor: tokio::task::JoinHandle<()>,
}
impl Drop for CommandSession {
    fn drop(&mut self) {
        self.monitor.abort();
        self.session.cancel_all();
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Exec {
    host_id: String,
    command: String,
    cwd: Option<String>,
    timeout_seconds: Option<u64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Job {
    host_id: String,
    job_id: String,
}

/// Parse before dispatch; unknown arguments never reach UI/effects.
fn parse(name: &str, args: &Value) -> Result<application::Action, BrowserError> {
    let host = args["host_id"]
        .as_str()
        .ok_or_else(|| BrowserError::invalid("Explicit host_id required"))?;
    identifier(host)?;
    let mut wire = args.clone();
    if matches!(name, "agents.inspect" | "agents.wait") {
        let pane = wire
            .as_object_mut()
            .and_then(|args| args.remove("pane_id"))
            .ok_or_else(|| BrowserError::invalid("Explicit pane_id required"))?;
        identifier(
            pane.as_str()
                .ok_or_else(|| BrowserError::invalid("Invalid pane_id"))?,
        )?;
        if wire.get("target").is_some() {
            return Err(BrowserError::invalid("Use pane_id"));
        }
        wire["target"] = pane;
    }
    if matches!(name, "agents.stop" | "agents.restart") {
        let pane = wire
            .as_object_mut()
            .and_then(|args| args.remove("pane_id"))
            .ok_or_else(|| BrowserError::invalid("Explicit pane_id and terminal_id required"))?;
        identifier(
            pane.as_str()
                .ok_or_else(|| BrowserError::invalid("Invalid pane_id"))?,
        )?;
    }
    application::Action::parse(name, &wire)
}

impl WhipToolSession {
    pub(super) fn mutation_uncertain(&self) -> bool {
        self.uncertain.load(Ordering::Acquire)
            || self
                .commands
                .lock()
                .iter()
                .any(|command| command.session.outcome_unknown())
    }

    pub(super) fn cancel_commands(&self) {
        for command in self.commands.lock().iter() {
            command.session.cancel_all();
            command.monitor.abort();
        }
    }

    /// The pending foreign watch checks foreground before yielding, then ends on
    /// background/lock/hangup. Native authority is independently checked throughout.
    pub(super) async fn guarded<T>(
        self: &Arc<Self>,
        work: impl Future<Output = Result<T, BrowserError>>,
    ) -> Result<T, BrowserError> {
        tokio::select! {
            biased;
            _ = self.platform(WATCH, json!({})) => Err(BrowserError::new(ErrorCode::Cancelled, "Whip left the foreground or the operation was cancelled")),
            result = async {
                loop {
                    if let Err(error) = self.check() { break Err(error); }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            } => result,
            result = work => result,
        }
    }

    pub(super) async fn operation(
        self: &Arc<Self>,
        name: &str,
        args: Value,
        dispatched: &AtomicBool,
    ) -> Result<Value, BrowserError> {
        let result = self
            .guarded(self.operation_inner(name, args, dispatched))
            .await;
        result.map_err(|mut error| {
            if dispatched.load(Ordering::Acquire) && error.details.get("outcome_unknown").is_none()
            {
                error.details["outcome_unknown"] = json!(true);
            }
            error
        })
    }

    fn check_mutation(&self, name: &str) -> Result<(), BrowserError> {
        if name != "hosts_disconnect" && self.mutation_uncertain() {
            return Err(BrowserError::new(
                ErrorCode::Cancelled,
                "Inspect the earlier unknown outcome before further mutations",
            ));
        }
        Ok(())
    }

    async fn command_job(&self, name: &str, args: Value) -> Result<Value, BrowserError> {
        let job: Job = decode(args)?;
        identifier(&job.host_id)?;
        identifier(&job.job_id)?;
        let session = self
            .commands
            .lock()
            .iter()
            .find(|command| command.host == job.host_id && command.id == job.job_id)
            .map(|command| command.session.clone())
            .ok_or_else(|| {
                BrowserError::new(ErrorCode::NotFound, "No job on this call and host")
            })?;
        let mut value = session
            .execute("", name, &json!({"job_id":job.job_id}).to_string())
            .await;
        // Streaming tails are authoritative; do not duplicate them in the final result.
        if let Some(result) = value["result"].as_object_mut() {
            result.remove("stdout");
            result.remove("stderr");
        }
        for stream in ["stdout", "stderr"] {
            if let Some(text) = value[stream].as_str()
                && text.len() > MAX_STREAM_RESULT
            {
                let mut start = text.len() - MAX_STREAM_RESULT;
                while !text.is_char_boundary(start) {
                    start += 1;
                }
                value[stream] = json!(&text[start..]);
                value["truncated"] = json!(true);
            }
        }
        value["host_id"] = json!(job.host_id);
        Ok(value)
    }

    async fn operation_inner(
        self: &Arc<Self>,
        name: &str,
        args: Value,
        dispatched: &AtomicBool,
    ) -> Result<Value, BrowserError> {
        if matches!(name, terminal::READ | terminal::CANCEL) {
            return self.command_job(name, args).await;
        }
        if name == terminal::EXEC {
            let request: Exec = decode(args.clone())?;
            identifier(&request.host_id)?;
            if !terminal::valid_exec(&request.command, request.timeout_seconds)
                || request.cwd.as_ref().is_some_and(|cwd| {
                    cwd.is_empty() || cwd.len() > 4096 || cwd.chars().any(char::is_control)
                })
            {
                return Err(BrowserError::invalid("Invalid command, cwd or deadline"));
            }
            let profiles = saved_profiles(&request.host_id)?;
            let Ok(_serial) = self.delegation.try_lock() else {
                return Ok(json!({"error":"operation_busy","submitted":false}));
            };
            {
                let commands = self.commands.lock();
                if commands.len() >= MAX_JOBS {
                    return Err(BrowserError::invalid("Call command limit reached"));
                }
                if commands.iter().any(|command| command.session.busy()) {
                    return Ok(json!({"error":"command_running","submitted":false}));
                }
            }
            let target =
                PinnedTerminal::pin_host(request.host_id.clone(), request.cwd).map_err(|_| {
                    BrowserError::new(ErrorCode::HostDisconnected, "Selected host unavailable")
                })?;
            self.check_mutation(name)?;
            self.check()?;
            if hosts::voice_context()?.hosts != profiles {
                return Err(BrowserError::new(
                    ErrorCode::Cancelled,
                    "Saved host configuration changed before dispatch",
                ));
            }
            target.check().map_err(|_| {
                BrowserError::new(ErrorCode::Cancelled, "Connection changed before dispatch")
            })?;
            let session = terminal::Session::new(target);
            let id = uuid::Uuid::new_v4().to_string();
            let wire = json!({"command":request.command,"timeout_seconds":request.timeout_seconds.unwrap_or(terminal::MAX_TIMEOUT_SECONDS)});
            dispatched.store(true, Ordering::Release);
            let mut value = session
                .execute(&id, terminal::EXEC, &wire.to_string())
                .await;
            value["host_id"] = json!(request.host_id);
            if value.get("error").is_some() {
                value["submitted"] = json!(false);
                return Ok(value);
            }
            value["guidance"] = json!(
                "Admitted, not completed. Poll terminal_read with this host_id and job_id for bounded progress, stdout/stderr and actual exit status. Never retry unknown outcomes."
            );
            let owner = Arc::downgrade(self);
            let observed = session.clone();
            let monitor = tokio::spawn(async move {
                if let Some(owner) = owner.upgrade() {
                    let _ = owner
                        .guarded(async {
                            while observed.busy() && observed.target.check().is_ok() {
                                tokio::time::sleep(Duration::from_millis(100)).await;
                            }
                            Ok(())
                        })
                        .await;
                    observed.cancel_all();
                } else {
                    observed.cancel_all();
                }
            });
            self.commands.lock().push(CommandSession {
                host: request.host_id,
                id,
                session,
                monitor,
            });
            return Ok(value);
        }
        let operation = name.replacen('_', ".", 1);
        let action = parse(&operation, &args)?;
        let host = args["host_id"]
            .as_str()
            .ok_or_else(|| BrowserError::invalid("host_id required"))?;
        let host_operation = matches!(action, application::Action::Host(_));
        let profiles = saved_profiles(host)?;
        let disconnect_target = if operation == application::DISCONNECT
            && crate::host_runtime::get_host_runtime(host.to_owned()).is_some()
        {
            Some(
                PinnedTerminal::pin_host(host.to_owned(), None).map_err(|_| {
                    BrowserError::new(ErrorCode::HostDisconnected, "Selected connection changed")
                })?,
            )
        } else {
            None
        };
        let target = if host_operation {
            None
        } else {
            Some(Arc::new(
                ControlTarget::pin(host.to_owned(), args.clone()).map_err(|_| {
                    BrowserError::new(
                        ErrorCode::HostDisconnected,
                        "Explicit target unavailable or stale",
                    )
                })?,
            ))
        };
        let _serial = if read_only(&operation) {
            None
        } else {
            let Ok(serial) = self.delegation.try_lock() else {
                return Ok(json!({"error":"operation_busy","submitted":false}));
            };
            self.check_mutation(name)?;
            Some(serial)
        };
        self.check()?;
        if hosts::voice_context()?.hosts != profiles {
            return Err(BrowserError::new(
                ErrorCode::Cancelled,
                "Saved host configuration changed before dispatch",
            ));
        }
        if operation == application::DISCONNECT {
            if let Some(target) = &disconnect_target {
                target.check().map_err(|_| {
                    BrowserError::new(ErrorCode::Cancelled, "Connection changed before disconnect")
                })?;
            } else if crate::host_runtime::get_host_runtime(host.to_owned()).is_some() {
                return Err(BrowserError::new(
                    ErrorCode::Cancelled,
                    "A new connection appeared before disconnect",
                ));
            }
        }
        if let Some(target) = &target {
            target.check_targets().map_err(|_| {
                BrowserError::new(
                    ErrorCode::Cancelled,
                    "Explicit target changed before dispatch",
                )
            })?;
        }
        if !read_only(&operation) {
            dispatched.store(true, Ordering::Release);
        }
        let work = async {
            match action {
                application::Action::Host(action) => {
                    if operation == application::DISCONNECT {
                        for command in self
                            .commands
                            .lock()
                            .iter()
                            .filter(|command| command.host == host)
                        {
                            command.session.cancel_all();
                        }
                    }
                    action.run_voice(self).await
                }
                application::Action::Herdr { operation, .. } => {
                    application::run_herdr_pinned(host.to_owned(), operation, target.clone()).await
                }
                application::Action::Local(_) => {
                    Err(BrowserError::invalid("Unexpected local operation"))
                }
            }
        };
        let value = if let Some(target) = &target {
            tokio::select! {
                value = work => value?,
                error = async {
                    loop {
                        if (if read_only(&operation) { target.check_targets() } else { target.check_connection() }).is_err() {
                            break BrowserError::new(ErrorCode::HostDisconnected, "Connection changed during operation");
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                } => return Err(error),
            }
        } else {
            work.await?
        };
        self.check()?;
        if read_only(&operation)
            && let Some(target) = &target
        {
            target.check_targets().map_err(|_| {
                BrowserError::new(ErrorCode::Cancelled, "Target changed during inspection")
            })?;
        }
        Ok(value)
    }
}

pub(super) fn schemas() -> Vec<Value> {
    let string = || json!({"type":"string","minLength":1,"maxLength":256});
    let mut tools = Vec::new();
    for tool in application::tools() {
        let Some(name) = tool["name"].as_str() else {
            continue;
        };
        if !REMOTE.contains(&name) {
            continue;
        }
        let mut properties = tool["inputSchema"]["properties"].clone();
        properties["host_id"] = string();
        let mut required: Vec<String> = tool["inputSchema"]["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if !required.iter().any(|field| field == "host_id") {
            required.insert(0, "host_id".into());
        }
        if matches!(name, "agents.inspect" | "agents.wait") {
            properties
                .as_object_mut()
                .map(|fields| fields.remove("target"));
            required.retain(|field| field != "target");
        }
        if matches!(
            name,
            "agents.inspect" | "agents.wait" | "agents.stop" | "agents.restart"
        ) {
            properties["pane_id"] = string();
            required.push("pane_id".into());
        }
        let operation_description = match name {
            "hosts.connect" => {
                "Connect one saved host using its protected credentials, jump hosts, biometric and host-key checks. Does not navigate."
            }
            "hosts.disconnect" => {
                "Disconnect only the explicit saved host and cancel its command observations. The independent global call continues."
            }
            "agents.stop" => {
                "Stop only the explicit agent terminal using the existing lifecycle controls. Preserves its pane and conversation data; may interrupt work."
            }
            "agents.restart" => {
                "Restart only the explicit agent terminal using the existing conversation-preserving lifecycle controls. May interrupt work; inspect readiness separately."
            }
            _ => tool["description"].as_str().unwrap_or_default(),
        };
        let description = format!(
            "{} Requires explicit discovered host/target IDs. {} Never close unrelated work. Never retry an uncertain mutation.",
            operation_description,
            if read_only(name) {
                "Read only."
            } else {
                "Executes directly without an approval dialog."
            }
        );
        tools.push(schema(
            &name.replacen('.', "_", 1),
            &description,
            properties,
            &required.iter().map(String::as_str).collect::<Vec<_>>(),
        ));
    }
    tools.push(schema(terminal::EXEC, "Run an explicitly requested command on one saved connected host in a separate SSH exec channel, without an approval dialog. No interactive exports are inherited. Returns a job ID; poll terminal_read for progress and actual completion. No keystrokes or agent input.",
        json!({"host_id":string(),"command":{"type":"string","minLength":1,"maxLength":terminal::MAX_COMMAND},"cwd":{"type":"string","minLength":1,"maxLength":4096},"timeout_seconds":{"type":"integer","minimum":1,"maximum":terminal::MAX_TIMEOUT_SECONDS}}), &["host_id","command"]));
    for name in [terminal::READ, terminal::CANCEL] {
        tools.push(schema(name, if name == terminal::READ { "Read this call's job on the explicit original host, including bounded stdout/stderr and exit status. Poll while running; unknown is never success." } else { "Stop observing this call's job and close its SSH exec channel. Remote termination is not guaranteed; never repeat the command." }, json!({"host_id":string(),"job_id":string()}), &["host_id","job_id"]));
    }
    tools
}

#[cfg(test)]
#[path = "voice_operations_tests.rs"]
mod tests;
