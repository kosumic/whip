//! Durable v2 log reads invalidate individual API messages, rather than the
//! whole transcript. The CLI keeps service discovery and authentication local.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{
    AgentSessionError, fetch_opencode_v2_info, fetch_opencode_v2_snapshot, opencode_v2_api_command,
};
use crate::agent_transcript::{OpenCodeV2History, OpenCodeV2ReadState, OpenCodeV2Sync};

struct LogRead {
    sequence: Option<u64>,
    events: Vec<DurableEvent>,
}

struct DurableEvent {
    sequence: u64,
    value: Value,
}

fn log_command(session_id: &str, after: Option<u64>) -> String {
    let path = format!("/api/experimental/session/{session_id}/log?follow=false");
    let command = opencode_v2_api_command(&match after {
        Some(after) => format!("{path}&after={after}"),
        None => path,
    });
    if after.is_some() {
        command
    } else {
        // Only the final SSE frame (log.synced) crosses SSH on a cold read.
        // Preserve CLI failures before filtering; no extra remote runtime.
        format!(
            "whip_log=$({command}) || exit $?; printf '%s\\n' \"$whip_log\" | awk 'BEGIN {{ RS=\"\"; ORS=\"\\n\\n\" }} {{ last=$0 }} END {{ print last }}'"
        )
    }
}

fn parse_log(session_id: &str, output: &str) -> Result<LogRead, AgentSessionError> {
    let invalid = || AgentSessionError::ReadFailed("Invalid OpenCode v2 durable log".into());
    let mut frames = Vec::new();
    let mut data = Vec::new();
    for line in output.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if !data.is_empty() {
                frames
                    .push(serde_json::from_str::<Value>(&data.join("\n")).map_err(|_| invalid())?);
                data.clear();
            }
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.strip_prefix(' ').unwrap_or(value));
        }
    }
    let marker = frames.pop().ok_or_else(invalid)?;
    if marker["type"] != "log.synced" || marker["aggregateID"] != session_id {
        return Err(invalid());
    }
    let sequence = match marker.get("seq") {
        Some(value) => Some(value.as_u64().ok_or_else(invalid)?),
        None => None,
    };
    let mut previous = None;
    let mut events = Vec::new();
    for event in frames {
        let seq = event["durable"]["seq"].as_u64().ok_or_else(invalid)?;
        if event["durable"]["aggregateID"] != session_id
            || event["data"]["sessionID"] != session_id
            || previous.is_some_and(|previous| seq <= previous)
            || sequence.is_none_or(|sequence| seq > sequence)
        {
            return Err(invalid());
        }
        previous = Some(seq);
        events.push(DurableEvent {
            sequence: seq,
            value: event,
        });
    }
    Ok(LogRead { sequence, events })
}

struct Changes {
    ids: Vec<String>,
    dirty: HashSet<String>,
    pending_assistants: Vec<String>,
    shells: HashMap<String, String>,
}

impl Changes {
    fn touch(&mut self, id: &str) {
        self.dirty.insert(id.to_owned());
        if !self.ids.iter().any(|old| old == id) {
            self.ids.push(id.to_owned());
        }
    }

    fn touch_pending(&mut self) {
        self.dirty.extend(self.pending_assistants.iter().cloned());
    }

    fn event(&mut self, event: &Value) -> Option<()> {
        let kind = event["type"].as_str()?;
        let data = &event["data"];
        let version = match kind {
            "session.instructions.updated" | "session.tool.success" | "session.tool.failed" => 2,
            _ => 1,
        };
        if event["durable"]["version"].as_u64()? != version {
            return None;
        }
        let field = |field: &str| data[field].as_str().filter(|id| !id.is_empty());
        let event_message_id = || {
            event["id"]
                .as_str()?
                .strip_prefix("evt_")
                .map(|id| format!("msg_{id}"))
        };
        match kind {
            "session.step.started"
            | "session.step.streamed"
            | "session.step.ended"
            | "session.step.failed"
            | "session.text.started"
            | "session.text.ended"
            | "session.reasoning.started"
            | "session.reasoning.ended"
            | "session.tool.input.started"
            | "session.tool.input.ended"
            | "session.tool.called"
            | "session.tool.success"
            | "session.tool.failed"
            | "session.retry.scheduled" => {
                if kind == "session.step.started" {
                    self.touch_pending();
                }
                self.touch(field("assistantMessageID")?);
            }
            "session.message.content.updated" => self.touch(field("messageID")?),
            "session.inbox.delivered" => self.touch(field("inboxID")?),
            "session.shell.started" => {
                let id = event_message_id()?;
                self.shells
                    .insert(data["shell"]["id"].as_str()?.to_owned(), id.clone());
                self.touch(&id);
            }
            "session.shell.ended" => {
                let id = self.shells.get(data["shell"]["id"].as_str()?)?.clone();
                self.touch(&id);
            }
            "session.execution.succeeded"
            | "session.execution.failed"
            | "session.execution.interrupted" => {
                self.touch_pending();
                if kind != "session.execution.interrupted" || data["reason"] != "shutdown" {
                    self.touch(&event_message_id()?);
                }
            }
            "session.agent.selected"
            | "session.model.selected"
            | "session.moved"
            | "session.synthetic"
            | "session.skill.activated" => self.touch(&event_message_id()?),
            "session.instructions.updated" => {
                if data.get("text").is_some() {
                    self.touch(&event_message_id()?);
                }
            }
            "session.revert.committed" => {
                let boundary = self
                    .ids
                    .iter()
                    .position(|id| Some(id.as_str()) == field("to"))?;
                self.ids.truncate(boundary);
                self.dirty.retain(|id| self.ids.contains(id));
                self.pending_assistants.retain(|id| self.ids.contains(id));
                self.shells.retain(|_, id| self.ids.contains(id));
            }
            "session.renamed"
            | "session.metadata.updated"
            | "session.permissions"
            | "session.viewed"
            | "session.usage.recorded"
            | "session.execution.started"
            | "session.inbox.enqueued"
            | "session.inbox.cancelled"
            | "session.inbox.delivery.changed"
            | "session.revert.staged"
            | "session.revert.cleared" => {}
            // Forks/imports, compaction and future event contracts require an
            // authoritative API order instead of guessing projection effects.
            _ => return None,
        }
        Some(())
    }
}

pub(super) async fn fetch<F, Fut>(
    session_id: &str,
    cached: Option<OpenCodeV2ReadState>,
    mut execute: F,
) -> Result<OpenCodeV2Sync, AgentSessionError>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, AgentSessionError>>,
{
    let after = cached.as_ref().map(|cached| cached.history.sequence);
    let log = execute(log_command(session_id, after))
        .await
        .and_then(|output| parse_log(session_id, &output));
    let Ok(log) = log else {
        // Older v2 servers or an untrustworthy log retain snapshot compatibility.
        return Ok(OpenCodeV2Sync::Full {
            snapshot: fetch_opencode_v2_snapshot(session_id, execute).await?,
            sequence: None,
        });
    };
    let full = |snapshot, sequence| OpenCodeV2Sync::Full { snapshot, sequence };
    let Some(cached) = cached else {
        return Ok(full(
            fetch_opencode_v2_snapshot(session_id, execute).await?,
            log.sequence,
        ));
    };
    let Some(sequence) = log
        .sequence
        .filter(|sequence| *sequence >= cached.history.sequence)
    else {
        return Ok(full(
            fetch_opencode_v2_snapshot(session_id, execute).await?,
            log.sequence,
        ));
    };
    let mut changes = Changes {
        ids: cached.history.message_ids,
        dirty: HashSet::new(),
        pending_assistants: cached.pending_assistants,
        shells: cached.shells,
    };
    let mut previous = cached.history.sequence;
    for event in &log.events {
        let seq = event.sequence;
        if previous.checked_add(1) != Some(seq) || changes.event(&event.value).is_none() {
            return Ok(full(
                fetch_opencode_v2_snapshot(session_id, execute).await?,
                Some(sequence),
            ));
        }
        previous = seq;
    }
    if previous != sequence {
        return Ok(full(
            fetch_opencode_v2_snapshot(session_id, execute).await?,
            Some(sequence),
        ));
    }
    let info = fetch_opencode_v2_info(session_id, &mut execute).await?;
    let mut messages = Vec::new();
    for id in &changes.ids {
        if !changes.dirty.contains(id) {
            continue;
        }
        let output = execute(opencode_v2_api_command(&format!(
            "/api/session/{session_id}/message/{id}"
        )))
        .await;
        let value = output
            .ok()
            .and_then(|output| serde_json::from_str::<Value>(&output).ok())
            .and_then(|mut value| value.as_object_mut()?.remove("data"));
        let Some(value) = value.filter(|value| value["id"].as_str() == Some(id)) else {
            // A concurrent rollback may delete a row after the captured log
            // watermark. Rebase now and replay that rollback on the next poll.
            return Ok(full(
                fetch_opencode_v2_snapshot(session_id, execute).await?,
                Some(sequence),
            ));
        };
        messages.push(value);
    }
    Ok(OpenCodeV2Sync::Changes {
        info,
        history: OpenCodeV2History {
            sequence,
            message_ids: changes.ids,
        },
        messages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_sessions::shell_quote;
    use crate::agent_transcript::{AgentMessageRole, AgentTranscriptPart};
    use crate::{AgentTranscriptDelta, OpenCodeSessionCore, OpenCodeV2Snapshot};
    use std::fmt::Write;

    fn info() -> Value {
        serde_json::json!({ "id": "ses_v2" })
    }

    fn user(id: &str, text: &str) -> Value {
        serde_json::json!({ "id": id, "type": "user", "text": text })
    }

    fn assistant(id: &str, text: &str) -> Value {
        serde_json::json!({ "id": id, "type": "assistant", "content": [{"type":"text", "text":text}] })
    }

    fn core(messages: Vec<Value>, sequence: u64) -> OpenCodeSessionCore {
        let mut core = OpenCodeSessionCore::new("ses_v2");
        core.apply_v2_sync(OpenCodeV2Sync::Full {
            snapshot: OpenCodeV2Snapshot {
                info: info(),
                messages,
            },
            sequence: Some(sequence),
        })
        .unwrap();
        core.mark_live();
        core
    }

    fn event(seq: u64, kind: &str, mut data: Value) -> Value {
        data["sessionID"] = "ses_v2".into();
        serde_json::json!({
            "id": format!("evt_{seq}"), "type":kind, "created":seq,
            "durable": {"aggregateID":"ses_v2", "seq":seq, "version":1}, "data":data
        })
    }

    fn log(events: Vec<Value>, sequence: u64) -> String {
        events
            .into_iter()
            .chain(std::iter::once(serde_json::json!({
                "type":"log.synced", "aggregateID":"ses_v2", "seq":sequence
            })))
            .fold(String::new(), |mut output, event| {
                write!(output, "data: {event}\n\n").unwrap();
                output
            })
    }

    fn read(
        cached: Option<OpenCodeV2ReadState>,
        log: &str,
        responses: HashMap<String, Value>,
    ) -> (OpenCodeV2Sync, Vec<String>, usize) {
        let mut commands = Vec::new();
        let mut bytes = 0;
        let sync = futures::executor::block_on(fetch("ses_v2", cached, |command| {
            let output = if command.starts_with("whip_log=") || command.contains("/log?") {
                log.to_owned()
            } else {
                let argv = shlex::split(&command).unwrap();
                assert_eq!(&argv[..3], ["opencode", "api", "GET"]);
                let path = &argv[3];
                if path == "/api/session/ses_v2" {
                    serde_json::json!({"data":info()}).to_string()
                } else {
                    responses
                        .get(path)
                        .unwrap_or_else(|| panic!("Unexpected history request: {path}"))
                        .to_string()
                }
            };
            bytes += output.len();
            commands.push(command);
            std::future::ready(Ok(output))
        }))
        .unwrap();
        (sync, commands, bytes)
    }

    fn response(id: &str, message: Value) -> (String, Value) {
        (
            format!("/api/session/ses_v2/message/{id}"),
            serde_json::json!({"data":message}),
        )
    }

    #[test]
    fn unchanged_restored_history_transfers_no_message_bodies_or_pages() {
        let messages: Vec<_> = (0..450)
            .map(|index| user(&format!("msg_{index}"), &"large history ".repeat(500)))
            .collect();
        let full_bytes = serde_json::to_vec(&messages).unwrap().len();
        let original = core(messages, 500);
        let mut restored = OpenCodeSessionCore::new("ses_v2");
        restored
            .restore_cache(&original.cache_blob().unwrap())
            .unwrap();
        let before = restored.state().messages;
        let cursor = restored.cursor();
        let (sync, commands, bytes) =
            read(restored.v2_read_state(), &log(vec![], 500), HashMap::new());
        assert!(restored.apply_v2_sync(sync).unwrap().is_none());
        assert_eq!(restored.cursor(), cursor);
        assert_eq!(restored.state().messages, before);
        assert_eq!(commands.len(), 2);
        assert!(commands[0].ends_with("after=500'"));
        assert!(bytes < full_bytes / 100);
    }

    #[test]
    fn changed_assistant_is_fetched_once_and_new_step_refreshes_previous_pending_message() {
        let mut core = core(
            vec![user("msg_user", "hello"), assistant("msg_old", "working")],
            10,
        );
        let mut completed = assistant("msg_old", "finished");
        completed["time"] = serde_json::json!({"completed":20});
        let next = assistant("msg_next", "next response");
        let events = vec![
            event(
                11,
                "session.text.ended",
                serde_json::json!({"assistantMessageID":"msg_old"}),
            ),
            event(
                12,
                "session.step.started",
                serde_json::json!({"assistantMessageID":"msg_next"}),
            ),
            event(
                13,
                "session.text.ended",
                serde_json::json!({"assistantMessageID":"msg_next"}),
            ),
        ];
        let (sync, commands, _) = read(
            core.v2_read_state(),
            &log(events, 13),
            HashMap::from([response("msg_old", completed), response("msg_next", next)]),
        );
        let update = core.apply_v2_sync(sync).unwrap().unwrap();
        assert_eq!(commands.len(), 4);
        assert!(!commands.iter().any(|command| command.contains("message?")));
        assert!(
            !update
                .deltas
                .iter()
                .any(|delta| matches!(delta, AgentTranscriptDelta::Reset { .. }))
        );
        let state = core.state();
        assert_eq!(state.messages[1].completed_at_ms, Some(20));
        assert_eq!(state.messages[2].id, "msg_next");
        assert_eq!(
            state.turns[0].assistant_message_ids,
            ["msg_old", "msg_next"]
        );
    }

    #[test]
    fn rollback_at_hidden_boundary_reuses_prefix_and_only_reads_new_branch() {
        let mut core = core(
            vec![
                user("msg_user", "keep"),
                serde_json::json!({"id":"msg_context", "type":"synthetic", "text":"private"}),
                assistant("msg_old", "discard"),
            ],
            10,
        );
        let events = vec![
            event(
                11,
                "session.text.ended",
                serde_json::json!({"assistantMessageID":"msg_old"}),
            ),
            event(
                12,
                "session.revert.committed",
                serde_json::json!({"to":"msg_context"}),
            ),
            event(
                13,
                "session.inbox.delivered",
                serde_json::json!({"inboxID":"msg_new_user"}),
            ),
            event(
                14,
                "session.step.started",
                serde_json::json!({"assistantMessageID":"msg_new"}),
            ),
        ];
        let (sync, commands, _) = read(
            core.v2_read_state(),
            &log(events, 14),
            HashMap::from([
                response("msg_new_user", user("msg_new_user", "new branch")),
                response("msg_new", assistant("msg_new", "new answer")),
            ]),
        );
        let update = core.apply_v2_sync(sync).unwrap().unwrap();
        assert_eq!(commands.len(), 4);
        assert!(
            !commands
                .iter()
                .any(|command| command.contains("/message/msg_old"))
        );
        assert!(update.deltas.iter().any(|delta| matches!(delta, AgentTranscriptDelta::MessageRemoved { message_id, .. } if message_id == "msg_old")));
        assert_eq!(
            core.state()
                .messages
                .iter()
                .map(|message| message.id.as_str())
                .collect::<Vec<_>>(),
            ["msg_user", "msg_new_user", "msg_new"]
        );
        assert_eq!(
            core.v2_read_state().unwrap().history.message_ids,
            ["msg_user", "msg_new_user", "msg_new"]
        );
    }

    #[test]
    fn shell_completion_fetches_the_cached_shell_and_preserves_its_order() {
        let shell = serde_json::json!({"id":"msg_shell", "type":"shell", "shellID":"shell_one", "command":"pwd", "status":"running", "output":""});
        let mut core = core(vec![user("msg_user", "hello"), shell.clone()], 10);
        let mut completed = shell;
        completed["status"] = "exited".into();
        completed["output"] =
            serde_json::json!({"output":"/repo", "cursor":5, "size":5, "truncated":false});
        completed["exit"] = 0.into();
        let (sync, commands, _) = read(
            core.v2_read_state(),
            &log(
                vec![event(
                    11,
                    "session.shell.ended",
                    serde_json::json!({"shell":{"id":"shell_one"}}),
                )],
                11,
            ),
            HashMap::from([response("msg_shell", completed)]),
        );
        core.apply_v2_sync(sync).unwrap();
        assert_eq!(commands.len(), 3);
        let state = core.state();
        assert_eq!(state.messages[1].role, AgentMessageRole::Assistant);
        assert!(
            matches!(&state.messages[1].parts[0], AgentTranscriptPart::Tool {state, ..} if state.output.as_deref() == Some("/repo"))
        );
    }

    #[test]
    fn tool_completion_reads_one_message_and_projects_its_final_output() {
        let mut core = core(
            vec![user("msg_user", "build"), assistant("msg_build", "working")],
            10,
        );
        let mut completion = event(
            11,
            "session.tool.success",
            serde_json::json!({"assistantMessageID":"msg_build"}),
        );
        completion["durable"]["version"] = 2.into();
        let updated = serde_json::json!({"id":"msg_build", "type":"assistant", "content":[{
            "type":"tool", "id":"call_build", "name":"bash", "state":{
                "status":"completed", "input":{"command":"cargo check"},
                "content":[{"type":"text", "text":"Build succeeded"}], "metadata":{"exitCode":0}
            }
        }]});
        let (sync, commands, _) = read(
            core.v2_read_state(),
            &log(vec![completion], 11),
            HashMap::from([response("msg_build", updated)]),
        );
        core.apply_v2_sync(sync).unwrap();
        assert_eq!(commands.len(), 3);
        assert!(
            matches!(&core.state().messages[1].parts[0], AgentTranscriptPart::Tool {state, ..} if state.output.as_deref() == Some("Build succeeded") && state.exit_code == Some(0))
        );
    }

    #[test]
    fn cold_snapshot_replays_events_committed_during_pagination_without_duplicate_rows() {
        let messages = vec![
            user("msg_user", "hello"),
            assistant("msg_new", "committed during read"),
        ];
        let (sync, commands, _) = read(
            None,
            &log(vec![], 10),
            HashMap::from([(
                "/api/session/ses_v2/message?limit=200&order=asc".into(),
                serde_json::json!({"data":messages, "cursor":{}}),
            )]),
        );
        assert!(commands[0].contains("/log?follow=false"));
        assert_eq!(commands.len(), 3);
        let mut core = OpenCodeSessionCore::new("ses_v2");
        core.apply_v2_sync(sync).unwrap();
        assert_eq!(core.v2_sequence(), Some(10));
        let (sync, commands, _) = read(
            core.v2_read_state(),
            &log(
                vec![event(
                    11,
                    "session.step.started",
                    serde_json::json!({"assistantMessageID":"msg_new"}),
                )],
                11,
            ),
            HashMap::from([response(
                "msg_new",
                assistant("msg_new", "committed during read"),
            )]),
        );
        assert!(core.apply_v2_sync(sync).unwrap().is_none());
        assert_eq!(commands.len(), 3);
        assert_eq!(core.v2_sequence(), Some(11));
        assert_eq!(core.state().messages.len(), 2);
    }

    #[test]
    fn unsafe_logs_rebase_instead_of_skipping_changes() {
        let original = core(vec![user("msg_old", "old")], 10);
        let unknown = event(11, "session.future.mutation", serde_json::json!({}));
        let mut wrong_version = event(
            11,
            "session.text.ended",
            serde_json::json!({"assistantMessageID":"msg_old"}),
        );
        wrong_version["durable"]["version"] = 9.into();
        let mut foreign = event(11, "session.renamed", serde_json::json!({}));
        foreign["durable"]["aggregateID"] = "ses_other".into();
        for output in [
            log(vec![], 9),
            log(vec![], 11),
            log(vec![unknown], 11),
            log(vec![wrong_version], 11),
            log(
                vec![event(12, "session.renamed", serde_json::json!({}))],
                12,
            ),
            log(vec![foreign], 11),
            "data: {\"type\":\"log.synced\"}\n\n".into(),
            format!(
                "data: {}\n\n",
                event(11, "session.renamed", serde_json::json!({}))
            ),
        ] {
            let (sync, commands, _) = read(
                original.v2_read_state(),
                &output,
                HashMap::from([(
                    "/api/session/ses_v2/message?limit=200&order=asc".into(),
                    serde_json::json!({"data":[user("msg_new", "authoritative")], "cursor":{}}),
                )]),
            );
            assert!(matches!(&sync, OpenCodeV2Sync::Full { .. }));
            let mut updated = original.clone();
            updated.apply_v2_sync(sync).unwrap();
            assert_eq!(updated.state().messages[0].id, "msg_new");
            assert_eq!(commands.len(), 3);
        }
    }

    #[test]
    fn failed_incremental_and_fallback_reads_preserve_history_and_log_cursor() {
        let original = core(vec![user("msg_user", "hello")], 10);
        let output = log(
            vec![event(
                11,
                "session.inbox.delivered",
                serde_json::json!({"inboxID":"msg_next"}),
            )],
            11,
        );
        let mut calls = 0;
        let result = futures::executor::block_on(fetch("ses_v2", original.v2_read_state(), |_| {
            calls += 1;
            std::future::ready(match calls {
                1 => Ok(output.clone()),
                2 | 4 => Ok(serde_json::json!({"data":info()}).to_string()),
                _ => Err(AgentSessionError::ReadFailed("SSH disconnected".into())),
            })
        }));
        assert!(result.is_err());
        assert_eq!(original.v2_read_state().unwrap().history.sequence, 10);
        assert_eq!(original.state().messages.len(), 1);
    }

    #[test]
    fn cold_log_command_sends_only_watermark_and_preserves_cli_failure() {
        let output = log(
            vec![event(
                0,
                "session.created",
                serde_json::json!({"text":"heavy history".repeat(1000)}),
            )],
            0,
        );
        let command = log_command("ses_v2", None);
        let shell = std::process::Command::new("sh")
            .args([
                "-c",
                &format!(
                    "opencode() {{ printf '%s' {}; }}; {command}",
                    shell_quote(&output)
                ),
            ])
            .output()
            .unwrap();
        assert!(shell.status.success());
        let transferred = String::from_utf8(shell.stdout).unwrap();
        let parsed = parse_log("ses_v2", &transferred).unwrap();
        assert_eq!(parsed.sequence, Some(0));
        assert!(parsed.events.is_empty());
        assert!(transferred.len() < output.len() / 100);
        let failure = std::process::Command::new("sh")
            .args(["-c", &format!("opencode() {{ return 7; }}; {command}")])
            .output()
            .unwrap();
        assert_eq!(failure.status.code(), Some(7));
        assert!(failure.stdout.is_empty());
    }
}
