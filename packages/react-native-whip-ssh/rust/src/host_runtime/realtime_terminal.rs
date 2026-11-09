//! A terminal call has no host selection or coding-agent authority.
use std::collections::VecDeque;
use std::sync::{Arc, LazyLock, OnceLock, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    HostConnectionState, HostRuntime, HostTerminalState, RuntimeInner, current_ssh,
    get_host_runtime,
};
use crate::herdr_api::{HerdrControlRequest, HerdrControlResult};
use crate::herdr_connection::HerdrRequestReplay;
use crate::host_state::{HostFreshness, HostSyncStatus};

pub(crate) const MAX_OUTPUT: usize = 12 * 1024;
pub(crate) const CHANGED: &str = "The bound terminal disconnected or changed. Please call again.";
static PROCESS_EPOCH: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TerminalTarget {
    pub runtime_id: String,
    pub runtime_incarnation: u64,
    pub connection_generation: u64,
    pub terminal_id: String,
    pub pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_epoch: Option<String>,
}

pub(crate) struct PinnedTerminal {
    runtime: Arc<HostRuntime>,
    target: TerminalTarget,
    operation_epoch: Option<u64>,
    recovery: u64,
    output: Mutex<TextTail>,
}

static OBSERVERS: OnceLock<Mutex<Vec<Weak<PinnedTerminal>>>> = OnceLock::new();

fn observers() -> &'static Mutex<Vec<Weak<PinnedTerminal>>> {
    OBSERVERS.get_or_init(Mutex::default)
}

pub(super) fn observe_output(inner: &Arc<RuntimeInner>, terminal: &str, epoch: u64, bytes: &[u8]) {
    let mut observers = observers().lock();
    observers.retain(|observer| {
        let Some(observer) = observer.upgrade() else {
            return false;
        };
        if Arc::ptr_eq(&observer.runtime.inner, inner)
            && observer.target.terminal_id == terminal
            && observer.operation_epoch == Some(epoch)
        {
            observer.output.lock().observe(bytes);
        }
        true
    });
}

impl PinnedTerminal {
    pub(crate) fn pin(target: TerminalTarget) -> Result<Arc<Self>, &'static str> {
        if target
            .process_epoch
            .as_ref()
            .is_some_and(|saved| saved != &*PROCESS_EPOCH)
        {
            return Err(CHANGED);
        }
        let runtime = get_host_runtime(target.runtime_id.clone()).ok_or(CHANGED)?;
        let (operation_epoch, recovery) = {
            let state = runtime.inner.state.lock();
            let epoch = if target.pane_id.is_none() {
                Some(
                    state
                        .ssh_shells
                        .get(&target.terminal_id)
                        .ok_or(CHANGED)?
                        .operation_epoch,
                )
            } else {
                None
            };
            (epoch, state.herdr_recovery_revision)
        };
        if target
            .operation_epoch
            .is_some_and(|saved| Some(saved) != operation_epoch)
            || target
                .recovery_revision
                .is_some_and(|saved| saved != recovery)
        {
            return Err(CHANGED);
        }
        let pinned = Arc::new(Self {
            runtime,
            target,
            operation_epoch,
            recovery,
            output: Mutex::default(),
        });
        pinned.check_fresh()?;
        let mut observers = observers().lock();
        observers.retain(|observer| observer.strong_count() > 0);
        observers.push(Arc::downgrade(&pinned));
        drop(observers);
        Ok(pinned)
    }

    pub(crate) fn check(&self) -> Result<(), &'static str> {
        if !super::runtimes()
            .read()
            .get(&self.target.runtime_id)
            .is_some_and(|runtime| Arc::ptr_eq(runtime, &self.runtime.inner))
        {
            return Err(CHANGED);
        }
        let state = self.runtime.inner.state.lock();
        if state.connection != HostConnectionState::Connected
            || state.explicit_disconnect
            || state.generation != self.target.connection_generation
            || self.runtime.inner.incarnation != self.target.runtime_incarnation
        {
            return Err(CHANGED);
        }
        if let Some(pane_id) = &self.target.pane_id {
            if state.herdr_recovery_revision != self.recovery {
                return Err(CHANGED);
            }
            let host = state.host_state.projection();
            let pane = host
                .snapshot
                .as_ref()
                .and_then(|snapshot| {
                    snapshot.panes.iter().find(|pane| {
                        pane.pane_id == *pane_id && pane.terminal_id == self.target.terminal_id
                    })
                })
                .ok_or(CHANGED)?;
            // A newly launched coding TUI must never inherit a shell call's input.
            if pane.agent_session.is_some()
                || pane.agent.as_deref().is_some_and(is_coding_agent)
                || pane.display_agent.as_deref().is_some_and(is_coding_agent)
            {
                return Err(CHANGED);
            }
        } else if !state
            .ssh_shells
            .get(&self.target.terminal_id)
            .is_some_and(|shell| {
                shell.desired_open
                    && shell.state == HostTerminalState::Attached
                    && Some(shell.operation_epoch) == self.operation_epoch
            })
        {
            return Err(CHANGED);
        }
        drop(state);
        Ok(())
    }

    pub(crate) fn history_target(&self) -> TerminalTarget {
        TerminalTarget {
            operation_epoch: self.operation_epoch,
            recovery_revision: self.target.pane_id.as_ref().map(|_| self.recovery),
            process_epoch: Some(PROCESS_EPOCH.clone()),
            ..self.target.clone()
        }
    }

    fn check_fresh(&self) -> Result<(), &'static str> {
        self.check()?;
        if self.target.pane_id.is_some() {
            let host = self.runtime.inner.state.lock().host_state.projection();
            if host.sync_status != HostSyncStatus::Synced || host.freshness != HostFreshness::Fresh
            {
                return Err("terminal_state_refreshing");
            }
        }
        Ok(())
    }

    pub(crate) fn context(&self) -> Result<Value, &'static str> {
        self.check_fresh()?;
        let cwd = if let Some(pane_id) = &self.target.pane_id {
            self.runtime
                .inner
                .state
                .lock()
                .host_state
                .projection()
                .snapshot
                .and_then(|snapshot| {
                    snapshot
                        .panes
                        .into_iter()
                        .find(|pane| pane.pane_id == *pane_id)
                })
                .and_then(|pane| pane.foreground_cwd.or(pane.cwd))
        } else {
            self.runtime
                .ssh_shell_directory(self.target.terminal_id.clone())
        };
        Ok(
            json!({"runtime_id":self.target.runtime_id,"terminal_id":self.target.terminal_id,
            "pane_id":self.target.pane_id,"cwd":cwd,"execution_context":"separate_ssh_exec",
            "environment":"SSH exec environment; interactive shell exports and state are not inherited",
            "foreground_program":"unknown","shell_idle":"unknown"}),
        )
    }

    pub(crate) async fn execute(
        &self,
        command: &str,
        timeout: Duration,
        progress: crate::ssh::CommandProgress,
    ) -> Value {
        let context = match self.context() {
            Ok(context) => context,
            Err(error) => return json!({"error":error}),
        };
        let Ok(ssh) = current_ssh(&self.runtime.inner) else {
            return json!({"error":CHANGED});
        };
        let command = exec_command(command, context["cwd"].as_str());
        if let Err(error) = self.check_fresh() {
            return json!({"error":error});
        }
        let result = ssh.execute_observed(&command, timeout, progress).await;
        if self.check().is_err() {
            return json!({"error":"outcome_unknown","reason":"terminal_changed","remote_process":"unknown"});
        }
        match result {
            Ok(output) => {
                let mut result = json!({"context":context,"completion":"finished","exit_status":output.exit_status,
                "stdout":clean(&output.stdout),"stderr":clean(&output.stderr),
                "truncated":output.stdout_truncated || output.stdout.len() > MAX_OUTPUT || output.stderr.len() > MAX_OUTPUT});
                if output.exit_status.is_none() {
                    result["completion"] = json!("unknown");
                    result["error"] = json!("outcome_unknown");
                    result["guidance"] =
                        json!("SSH closed without an exit status. Do not repeat the command.");
                }
                result
            }
            Err(_) => json!({"error":"outcome_unknown","remote_process":"unknown",
                "guidance":"Observation ended or SSH failed. The command may still be running. Do not repeat it."}),
        }
    }

    pub(crate) async fn read(&self) -> Result<Value, &'static str> {
        self.check_fresh()?;
        let output = if let Some(pane_id) = &self.target.pane_id {
            let result = crate::herdr_api::request_on_runtime(
                self.runtime.inner.herdr.clone(),
                HerdrControlRequest::PaneReadVisible {
                    pane_id: pane_id.clone(),
                },
                HerdrRequestReplay::Never,
            )
            .await
            .map_err(|_| "terminal_read_failed")?;
            let HerdrControlResult::PaneRead { read } = result else {
                return Err("terminal_read_failed");
            };
            if read.pane_id != *pane_id {
                return Err(CHANGED);
            }
            clean(read.text.as_bytes())
        } else {
            self.output.lock().text()
        };
        self.check()?;
        Ok(
            json!({"context":self.context()?,"kind":"terminal_output","output":output,
            "exit_status":null,"guidance":"A bounded terminal observation, not a structured command result. Foreground program and idle state are unverified."}),
        )
    }

    pub(crate) async fn input(&self, text: Option<String>, key: Option<Key>) -> Value {
        if text
            .as_ref()
            .is_some_and(|text| text.len() > 8192 || text.contains('\0'))
            || text.is_some() == key.is_some()
        {
            return json!({"error":"invalid_arguments"});
        }
        if let Err(error) = self.check_fresh() {
            return json!({"error":error});
        }
        let result = if let Some(pane_id) = &self.target.pane_id {
            let request = if let Some(key) = key {
                HerdrControlRequest::PaneSendKeys {
                    pane_id: pane_id.clone(),
                    keys: vec![key.name().into()],
                }
            } else {
                HerdrControlRequest::PaneSendText {
                    pane_id: pane_id.clone(),
                    text: text.unwrap_or_default(),
                }
            };
            crate::herdr_api::request_on_runtime(
                self.runtime.inner.herdr.clone(),
                request,
                HerdrRequestReplay::Never,
            )
            .await
            .map(|_| ())
            .map_err(|_| ())
        } else {
            let bytes = key.map_or_else(
                || text.unwrap_or_default().into_bytes(),
                |key| key.bytes().to_vec(),
            );
            match current_ssh(&self.runtime.inner) {
                Ok(ssh) if self.check().is_ok() => ssh
                    .shell_input(&self.target.terminal_id, bytes)
                    .map_err(|_| ()),
                _ => return json!({"error":CHANGED}),
            }
        };
        if result.is_err() || self.check().is_err() {
            return json!({"error":"outcome_unknown","guidance":"Input may have been delivered. Do not repeat it."});
        }
        json!({"delivery":"sent","kind":"terminal_input","completion":"unknown","exit_status":null,
            "guidance":"Input was sent to the explicitly selected terminal. This does not establish shell execution or process completion."})
    }
}

fn is_coding_agent(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "codex" | "claude" | "claude-code" | "opencode" | "pi"
    )
}

fn exec_command(command: &str, cwd: Option<&str>) -> String {
    cwd.map_or_else(
        || command.to_owned(),
        |cwd| {
            format!(
                "cd -- {} || exit\n{command}",
                crate::remote_ops::shell_quote(cwd)
            )
        },
    )
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Key {
    Enter,
    Interrupt,
    Escape,
    Tab,
    Up,
    Down,
}
impl Key {
    fn name(self) -> &'static str {
        match self {
            Self::Enter => "enter",
            Self::Interrupt => "ctrl+c",
            Self::Escape => "esc",
            Self::Tab => "tab",
            Self::Up => "up",
            Self::Down => "down",
        }
    }
    fn bytes(self) -> &'static [u8] {
        match self {
            Self::Enter => b"\r",
            Self::Interrupt => b"\x03",
            Self::Escape => b"\x1b",
            Self::Tab => b"\t",
            Self::Up => b"\x1b[A",
            Self::Down => b"\x1b[B",
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
enum Escape {
    #[default]
    Text,
    Start,
    Csi,
    String,
    StringEnd,
    Charset,
}

/// Incremental filtering prevents split OSC/CSI payloads from leaking into speech.
#[derive(Debug, Default)]
pub(crate) struct TextTail {
    bytes: VecDeque<u8>,
    escape: Escape,
}
impl TextTail {
    pub(crate) fn observe(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.escape = match (self.escape, byte) {
                (Escape::Text, 0x1b) => Escape::Start,
                (Escape::Text, b'\n' | b'\r' | b'\t' | 0x20..=0x7e | 0x80..=0xff) => {
                    if self.bytes.len() == MAX_OUTPUT {
                        self.bytes.pop_front();
                    }
                    self.bytes.push_back(byte);
                    Escape::Text
                }
                (Escape::Start, b'[') => Escape::Csi,
                (Escape::Start, b']' | b'P' | b'_' | b'^' | b'X') => Escape::String,
                (Escape::Start, b'(' | b')' | b'*' | b'+') => Escape::Charset,
                (Escape::Text | Escape::Start | Escape::Charset, _)
                | (Escape::Csi, 0x40..=0x7e)
                | (Escape::String | Escape::StringEnd, 7)
                | (Escape::StringEnd, b'\\') => Escape::Text,
                (Escape::Csi, _) => Escape::Csi,
                (Escape::String | Escape::StringEnd, 0x1b) => Escape::StringEnd,
                (Escape::String | Escape::StringEnd, _) => Escape::String,
            };
        }
    }
    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.iter().copied().collect::<Vec<_>>())
            .chars()
            .filter(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
            .collect()
    }
}
pub(crate) fn clean(bytes: &[u8]) -> String {
    let mut tail = TextTail::default();
    tail.observe(bytes);
    tail.text()
}

#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) use tests::{shell_fixture, shell_fixture_with_ssh};
