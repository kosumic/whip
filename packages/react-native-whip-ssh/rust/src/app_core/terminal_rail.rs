use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::herdr_api::{HerdrPaneInfo, HerdrSessionSnapshot};
use crate::host_runtime::HostTerminalState;

pub const SSH_SHELL_TERMINAL_ID: &str = "__whip_ssh_shell__";
static NEXT_SSH_SHELL_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TerminalKind {
    Herdr,
    Ssh,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum TerminalUiState {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct TerminalEntryView {
    pub terminal_id: String,
    pub pane_id: String,
    pub title: String,
    pub kind: TerminalKind,
    pub chat_selected: bool,
    pub state: TerminalUiState,
    pub error: Option<String>,
    pub reconnect_attempt: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, uniffi::Record)]
pub struct TerminalRailView {
    pub terminals: Vec<TerminalEntryView>,
    pub active_terminal_id: Option<String>,
    pub resume_blob: String,
}

const RESUME_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResume {
    version: u32,
    terminal_ids: Vec<String>,
    active_terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    chat_terminal_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyResume {
    sessions: Vec<serde_json::Value>,
    active_terminal_id: Option<String>,
}

impl TerminalResume {
    fn decode(blob: Option<&str>) -> Self {
        let Some(blob) = blob else {
            return Self::default();
        };
        if let Ok(resume) = serde_json::from_str::<Self>(blob) {
            return if resume.version == RESUME_VERSION {
                resume
            } else {
                Self::default()
            };
        }
        // Older clients stored pane/title/font metadata alongside terminal IDs.
        // Only identity and selection belong to the rail.
        serde_json::from_str::<LegacyResume>(blob).map_or_else(
            |_| Self::default(),
            |legacy| Self {
                version: RESUME_VERSION,
                terminal_ids: legacy
                    .sessions
                    .iter()
                    .filter_map(|entry| {
                        entry
                            .get("terminalId")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    })
                    .collect(),
                active_terminal_id: legacy.active_terminal_id,
                chat_terminal_ids: Vec::new(),
            },
        )
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct TerminalRail {
    terminals: Vec<TerminalEntryView>,
    active_terminal_id: Option<String>,
    pending_resume: Option<TerminalResume>,
}

impl TerminalRail {
    pub(super) fn seed_cached(&mut self, snapshot: &HerdrSessionSnapshot) {
        let active = snapshot
            .panes
            .iter()
            .find(|pane| Some(pane.pane_id.as_str()) == snapshot.focused_pane_id.as_deref())
            .or_else(|| snapshot.panes.iter().find(|pane| pane.focused));
        self.restore(
            snapshot
                .panes
                .iter()
                .filter(|pane| !pane.terminal_id.is_empty())
                .map(|pane| pane.terminal_id.clone())
                .collect(),
            active.map(|pane| pane.terminal_id.clone()),
            snapshot,
        );
        self.mark_cached();
    }

    pub(super) fn mark_cached(&mut self) {
        for terminal in &mut self.terminals {
            if terminal.kind == TerminalKind::Herdr {
                terminal.state = TerminalUiState::Disconnected;
                terminal.error = None;
                terminal.reconnect_attempt = 0;
            }
        }
    }

    pub(super) fn view(&self) -> TerminalRailView {
        TerminalRailView {
            terminals: self.terminals.clone(),
            active_terminal_id: self.active_terminal_id.clone(),
            resume_blob: self.resume_blob(),
        }
    }

    fn resume_blob(&self) -> String {
        if let Some(resume) = &self.pending_resume {
            return serde_json::to_string(resume).unwrap_or_default();
        }
        let terminal_ids: Vec<_> = self
            .terminals
            .iter()
            .filter(|terminal| terminal.kind == TerminalKind::Herdr)
            .map(|terminal| terminal.terminal_id.clone())
            .collect();
        let active_terminal_id = self
            .active_terminal_id
            .clone()
            .filter(|active| terminal_ids.contains(active))
            .or_else(|| terminal_ids.first().cloned());
        // This record contains only strings, integers and options; serialization cannot fail.
        serde_json::to_string(&TerminalResume {
            version: RESUME_VERSION,
            chat_terminal_ids: self
                .terminals
                .iter()
                .filter(|terminal| terminal.kind == TerminalKind::Herdr && terminal.chat_selected)
                .map(|terminal| terminal.terminal_id.clone())
                .collect(),
            terminal_ids,
            active_terminal_id,
        })
        .unwrap_or_default()
    }

    pub(super) fn restore_blob(
        &mut self,
        blob: Option<&str>,
        snapshot: &HerdrSessionSnapshot,
    ) -> bool {
        let resume = TerminalResume::decode(blob);
        self.restore_resume(resume, snapshot)
    }

    fn restore_resume(&mut self, resume: TerminalResume, snapshot: &HerdrSessionSnapshot) -> bool {
        self.restore(resume.terminal_ids, resume.active_terminal_id, snapshot);
        for terminal in &mut self.terminals {
            if terminal.kind == TerminalKind::Herdr {
                terminal.chat_selected = resume.chat_terminal_ids.contains(&terminal.terminal_id);
            }
        }
        true
    }

    pub(super) fn defer_restore(&mut self, blob: Option<&str>) {
        let mut resume = TerminalResume::decode(blob);
        resume.version = RESUME_VERSION;
        self.pending_resume = Some(resume);
    }

    pub(super) fn restore(
        &mut self,
        terminal_ids: Vec<String>,
        active_terminal_id: Option<String>,
        snapshot: &HerdrSessionSnapshot,
    ) -> bool {
        self.pending_resume = None;
        let shells: Vec<_> = self
            .terminals
            .iter()
            .filter(|terminal| terminal.kind == TerminalKind::Ssh)
            .cloned()
            .collect();
        let active_shell = self
            .active_terminal_id
            .clone()
            .filter(|id| shells.iter().any(|terminal| terminal.terminal_id == *id));
        let panes_by_terminal: HashMap<_, _> = snapshot
            .panes
            .iter()
            .map(|pane| (pane.terminal_id.as_str(), pane))
            .collect();
        let mut terminals = Vec::new();
        for terminal_id in terminal_ids {
            if terminals
                .iter()
                .any(|terminal: &TerminalEntryView| terminal.terminal_id == terminal_id)
            {
                continue;
            }
            if let Some(pane) = panes_by_terminal.get(terminal_id.as_str()) {
                terminals.push(entry_for_pane(pane));
            }
        }
        let selected = active_terminal_id
            .filter(|active| {
                terminals
                    .iter()
                    .any(|terminal| terminal.terminal_id == *active)
            })
            .or_else(|| {
                terminals
                    .first()
                    .map(|terminal| terminal.terminal_id.clone())
            });
        self.terminals = terminals;
        self.active_terminal_id = selected;
        if let Some(focused) = snapshot
            .focused_pane_id
            .as_deref()
            .and_then(|id| snapshot.panes.iter().find(|pane| pane.pane_id == id))
            .or_else(|| snapshot.panes.iter().find(|pane| pane.focused))
        {
            self.open_pane(focused);
        }
        self.terminals.extend(shells);
        if active_shell.is_some() {
            self.active_terminal_id = active_shell;
        }
        true
    }

    pub(super) fn open_pane(&mut self, pane: &HerdrPaneInfo) -> bool {
        if let Some(existing) = self
            .terminals
            .iter_mut()
            .find(|terminal| terminal.terminal_id == pane.terminal_id)
        {
            let pane_id = pane.pane_id.clone();
            let title = title_for_pane(pane);
            let changed = existing.pane_id != pane_id
                || existing.title != title
                || self.active_terminal_id.as_deref() != Some(pane.terminal_id.as_str());
            existing.pane_id = pane_id;
            existing.title = title;
            self.active_terminal_id = Some(pane.terminal_id.clone());
            return changed;
        }
        self.terminals.push(entry_for_pane(pane));
        self.active_terminal_id = Some(pane.terminal_id.clone());
        true
    }

    pub(super) fn open_ssh_shell(&mut self, title: String) -> bool {
        let id = NEXT_SSH_SHELL_ID.fetch_add(1, Ordering::Relaxed);
        let terminal_id = format!("{SSH_SHELL_TERMINAL_ID}:{id}");
        self.terminals.push(TerminalEntryView {
            terminal_id: terminal_id.clone(),
            pane_id: terminal_id.clone(),
            title,
            kind: TerminalKind::Ssh,
            chat_selected: false,
            state: TerminalUiState::Connecting,
            error: None,
            reconnect_attempt: 0,
        });
        self.active_terminal_id = Some(terminal_id);
        true
    }

    pub(super) fn select_ssh_shell(&mut self, terminal_id: &str) -> bool {
        if self.active_terminal_id.as_deref() == Some(terminal_id)
            || !self.terminals.iter().any(|terminal| {
                terminal.kind == TerminalKind::Ssh && terminal.terminal_id == terminal_id
            })
        {
            return false;
        }
        self.active_terminal_id = Some(terminal_id.to_owned());
        true
    }

    pub(super) fn rename_ssh_shell(&mut self, terminal_id: &str, title: String) -> bool {
        let Some(terminal) = self.terminals.iter_mut().find(|terminal| {
            terminal.kind == TerminalKind::Ssh && terminal.terminal_id == terminal_id
        }) else {
            return false;
        };
        let title = title.trim();
        if title.is_empty() || terminal.title == title {
            return false;
        }
        title.clone_into(&mut terminal.title);
        true
    }

    pub(super) fn close(&mut self, terminal_id: &str) -> bool {
        let Some(index) = self
            .terminals
            .iter()
            .position(|terminal| terminal.terminal_id == terminal_id)
        else {
            return false;
        };
        self.terminals.remove(index);
        if self.active_terminal_id.as_deref() == Some(terminal_id) {
            self.active_terminal_id = self
                .terminals
                .get(index.min(self.terminals.len().saturating_sub(1)))
                .map(|terminal| terminal.terminal_id.clone());
        }
        true
    }

    pub(super) fn select_chat(&mut self, terminal_id: &str, selected: bool) -> bool {
        let Some(terminal) = self.terminals.iter_mut().find(|terminal| {
            terminal.kind == TerminalKind::Herdr && terminal.terminal_id == terminal_id
        }) else {
            return false;
        };
        if terminal.chat_selected == selected {
            return false;
        }
        terminal.chat_selected = selected;
        true
    }

    pub(super) fn reconcile(&mut self, snapshot: &HerdrSessionSnapshot) -> bool {
        if let Some(resume) = self.pending_resume.take() {
            self.restore_resume(resume, snapshot);
            return true;
        }
        let panes_by_terminal: HashMap<_, _> = snapshot
            .panes
            .iter()
            .map(|pane| (pane.terminal_id.as_str(), pane))
            .collect();
        let previous_active_index = self
            .terminals
            .iter()
            .position(|terminal| {
                Some(terminal.terminal_id.as_str()) == self.active_terminal_id.as_deref()
            })
            .unwrap_or_default();
        let mut changed = false;
        self.terminals.retain_mut(|terminal| {
            if terminal.kind == TerminalKind::Ssh {
                return true;
            }
            let Some(pane) = panes_by_terminal.get(terminal.terminal_id.as_str()) else {
                changed = true;
                return false;
            };
            let pane_id = pane.pane_id.clone();
            let title = title_for_pane(pane);
            if terminal.pane_id != pane_id || terminal.title != title {
                terminal.pane_id = pane_id;
                terminal.title = title;
                changed = true;
            }
            true
        });
        if !self.terminals.iter().any(|terminal| {
            Some(terminal.terminal_id.as_str()) == self.active_terminal_id.as_deref()
        }) {
            self.active_terminal_id = self
                .terminals
                .get(previous_active_index.min(self.terminals.len().saturating_sub(1)))
                .map(|terminal| terminal.terminal_id.clone());
            changed = true;
        }
        changed
    }

    pub(super) fn update_lifecycle(
        &mut self,
        terminal_id: &str,
        state: HostTerminalState,
        retrying: bool,
        error: Option<String>,
        reconnect_attempt: u32,
    ) -> bool {
        let Some(terminal) = self
            .terminals
            .iter_mut()
            .find(|terminal| terminal.terminal_id == terminal_id)
        else {
            return false;
        };
        let state = match state {
            HostTerminalState::Opening => TerminalUiState::Connecting,
            HostTerminalState::Attached => TerminalUiState::Connected,
            HostTerminalState::Failed if !retrying => TerminalUiState::Error,
            HostTerminalState::Restoring
            | HostTerminalState::Closed
            | HostTerminalState::Failed => TerminalUiState::Disconnected,
        };
        if terminal.state == state
            && terminal.error == error
            && terminal.reconnect_attempt == reconnect_attempt
        {
            return false;
        }
        terminal.state = state;
        terminal.error = error;
        terminal.reconnect_attempt = if state == TerminalUiState::Connected {
            0
        } else {
            reconnect_attempt
        };
        true
    }
}

fn entry_for_pane(pane: &HerdrPaneInfo) -> TerminalEntryView {
    TerminalEntryView {
        terminal_id: pane.terminal_id.clone(),
        pane_id: pane.pane_id.clone(),
        title: title_for_pane(pane),
        kind: TerminalKind::Herdr,
        chat_selected: false,
        state: TerminalUiState::Connecting,
        error: None,
        reconnect_attempt: 0,
    }
}

fn title_for_pane(pane: &HerdrPaneInfo) -> String {
    pane.label
        .as_deref()
        .filter(|label| !label.is_empty())
        .or_else(|| {
            pane.display_agent
                .as_deref()
                .filter(|agent| !agent.is_empty())
        })
        .or_else(|| pane.agent.as_deref().filter(|agent| !agent.is_empty()))
        .unwrap_or(&pane.pane_id)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::herdr_api::{HerdrAgentStatus, HerdrSessionSnapshot};

    fn pane(terminal_id: &str, pane_id: &str, label: &str) -> HerdrPaneInfo {
        HerdrPaneInfo {
            pane_id: pane_id.to_owned(),
            terminal_id: terminal_id.to_owned(),
            workspace_id: "workspace".to_owned(),
            tab_id: "tab".to_owned(),
            focused: false,
            cwd: None,
            foreground_cwd: None,
            label: Some(label.to_owned()),
            agent: None,
            title: None,
            terminal_title: None,
            terminal_title_stripped: None,
            display_agent: None,
            agent_status: HerdrAgentStatus::Idle,
            state_labels: None,
            tokens: None,
            agent_session: None,
            scroll: None,
            revision: 1.0,
        }
    }

    fn snapshot(panes: Vec<HerdrPaneInfo>) -> HerdrSessionSnapshot {
        HerdrSessionSnapshot {
            version: "1".to_owned(),
            protocol: 22,
            focused_workspace_id: None,
            focused_tab_id: None,
            focused_pane_id: None,
            agents: Vec::new(),
            workspaces: Vec::new(),
            tabs: Vec::new(),
            panes,
            layouts: Vec::new(),
        }
    }

    #[test]
    fn reopening_existing_terminal_updates_metadata_and_selects_it() {
        let mut rail = TerminalRail::default();
        rail.open_pane(&pane("one", "pane-one", "old"));
        rail.open_pane(&pane("two", "pane-two", "two"));

        rail.open_pane(&pane("one", "pane-one-new", "renamed"));

        assert_eq!(rail.terminals.len(), 2);
        assert_eq!(rail.terminals[0].pane_id, "pane-one-new");
        assert_eq!(rail.terminals[0].title, "renamed");
        assert_eq!(rail.active_terminal_id.as_deref(), Some("one"));
    }

    #[test]
    fn removing_active_middle_terminal_selects_nearest_survivor() {
        let mut rail = TerminalRail::default();
        rail.open_pane(&pane("one", "pane-one", "one"));
        rail.open_pane(&pane("two", "pane-two", "two"));
        rail.open_pane(&pane("three", "pane-three", "three"));
        rail.active_terminal_id = Some("two".to_owned());

        rail.close("two");

        assert_eq!(
            rail.terminals
                .iter()
                .map(|terminal| terminal.terminal_id.as_str())
                .collect::<Vec<_>>(),
            ["one", "three"]
        );
        assert_eq!(rail.active_terminal_id.as_deref(), Some("three"));
    }

    #[test]
    fn pane_reconciliation_removes_missing_terminal_and_keeps_ssh_shell() {
        let mut rail = TerminalRail::default();
        rail.open_pane(&pane("gone", "pane-gone", "gone"));
        rail.open_ssh_shell("SSH shell".to_owned());
        let shell_id = rail.active_terminal_id.clone();
        rail.active_terminal_id = Some("gone".to_owned());

        rail.reconcile(&snapshot(Vec::new()));

        assert_eq!(rail.terminals.len(), 1);
        assert_eq!(rail.terminals[0].kind, TerminalKind::Ssh);
        assert_eq!(rail.active_terminal_id, shell_id);
    }

    #[test]
    fn ssh_tabs_have_independent_identity_selection_titles_and_lifecycle() {
        let mut rail = TerminalRail::default();
        rail.open_ssh_shell("Build".to_owned());
        let first = rail.active_terminal_id.clone().unwrap();
        rail.open_ssh_shell("Logs".to_owned());
        let second = rail.active_terminal_id.clone().unwrap();
        assert_ne!(first, second);
        rail.update_lifecycle(&first, HostTerminalState::Attached, false, None, 0);
        assert!(rail.select_ssh_shell(&first));
        assert!(rail.rename_ssh_shell(&second, " Server logs ".to_owned()));
        assert_eq!(rail.terminals[0].state, TerminalUiState::Connected);
        assert_eq!(rail.terminals[1].state, TerminalUiState::Connecting);
        assert_eq!(rail.terminals[0].title, "Build");
        assert_eq!(rail.terminals[1].title, "Server logs");
        assert_eq!(rail.active_terminal_id.as_deref(), Some(first.as_str()));

        assert!(!rail.select_ssh_shell("missing"));
        assert!(!rail.rename_ssh_shell(&first, "  ".to_owned()));
        assert!(rail.close(&first));
        assert_eq!(rail.active_terminal_id.as_deref(), Some(second.as_str()));
        rail.open_ssh_shell("Replacement".to_owned());
        assert_ne!(rail.active_terminal_id.as_deref(), Some(first.as_str()));
        rail.close(&second);
        assert_eq!(rail.terminals.len(), 1);
        let remaining = rail.active_terminal_id.clone().unwrap();
        rail.close(&remaining);
        assert!(rail.terminals.is_empty());
        assert!(rail.active_terminal_id.is_none());
    }

    #[test]
    fn restoring_herdr_tabs_preserves_open_ssh_tabs_and_their_selection() {
        let mut rail = TerminalRail::default();
        rail.open_ssh_shell("Build".to_owned());
        rail.open_ssh_shell("Logs".to_owned());
        let active = rail.active_terminal_id.clone();
        let shells = rail.terminals.clone();
        let mut focused_pane = pane("herdr", "pane", "Agent");
        focused_pane.focused = true;
        let host = snapshot(vec![focused_pane]);
        rail.restore_blob(None, &host);
        assert_eq!(&rail.terminals[1..], &shells);
        assert_eq!(rail.active_terminal_id, active);
        rail.reconcile(&snapshot(Vec::new()));
        assert_eq!(rail.terminals, shells);
        assert_eq!(rail.active_terminal_id, active);
        assert!(
            TerminalResume::decode(Some(&rail.view().resume_blob))
                .terminal_ids
                .is_empty()
        );
    }

    #[test]
    fn lifecycle_projection_tracks_reconnect_and_clears_attempt_when_connected() {
        let mut rail = TerminalRail::default();
        rail.open_pane(&pane("one", "pane-one", "one"));

        rail.update_lifecycle(
            "one",
            HostTerminalState::Failed,
            true,
            Some("lost".to_owned()),
            2,
        );
        assert_eq!(rail.terminals[0].state, TerminalUiState::Disconnected);
        assert_eq!(rail.terminals[0].reconnect_attempt, 2);
        rail.update_lifecycle("one", HostTerminalState::Attached, false, None, 2);

        assert_eq!(rail.terminals[0].state, TerminalUiState::Connected);
        assert_eq!(rail.terminals[0].reconnect_attempt, 0);
        assert_eq!(rail.terminals[0].error, None);
    }

    #[test]
    fn resume_waits_for_an_authoritative_snapshot() {
        let mut rail = TerminalRail::default();
        rail.defer_restore(Some(
            r#"{"version":1,"terminalIds":["one","two"],"activeTerminalId":"two"}"#,
        ));
        let resume = TerminalResume::decode(Some(&rail.view().resume_blob));
        assert_eq!(resume.terminal_ids, ["one", "two"]);
        assert!(rail.terminals.is_empty());
        rail.reconcile(&snapshot(vec![pane(
            "two",
            "current-pane",
            "current-title",
        )]));
        assert_eq!(rail.terminals.len(), 1);
        assert_eq!(rail.terminals[0].pane_id, "current-pane");
        assert_eq!(rail.active_terminal_id.as_deref(), Some("two"));
    }

    #[test]
    fn deferred_resume_keeps_a_shell_opened_while_waiting() {
        let mut rail = TerminalRail::default();
        rail.defer_restore(Some(
            r#"{"version":1,"terminalIds":["one"],"activeTerminalId":"one"}"#,
        ));
        rail.open_ssh_shell("SSH shell".to_owned());
        let shell_id = rail.active_terminal_id.clone().unwrap();
        rail.update_lifecycle(&shell_id, HostTerminalState::Attached, false, None, 0);
        rail.reconcile(&snapshot(vec![pane("one", "pane-one", "one")]));
        assert_eq!(rail.terminals.len(), 2);
        assert_eq!(rail.terminals[1].state, TerminalUiState::Connected);
        assert_eq!(rail.active_terminal_id.as_deref(), Some(shell_id.as_str()));
    }

    #[test]
    fn resume_round_trip_rebuilds_metadata_and_excludes_ssh() {
        let mut rail = TerminalRail::default();
        rail.open_pane(&pane("one", "old-pane", "old-title"));
        rail.open_pane(&pane("two", "pane-two", "two"));
        rail.open_ssh_shell("SSH shell".to_owned());
        let blob = rail.view().resume_blob;
        let mut restored = TerminalRail::default();
        restored.restore_blob(
            Some(&blob),
            &snapshot(vec![
                pane("one", "new-pane", "new-title"),
                pane("two", "pane-two", "two"),
            ]),
        );
        assert_eq!(restored.terminals.len(), 2);
        assert_eq!(restored.terminals[0].pane_id, "new-pane");
        assert_eq!(restored.terminals[0].title, "new-title");
        assert_eq!(restored.active_terminal_id.as_deref(), Some("one"));
        assert_eq!(restored.view().resume_blob, blob);
        restored.update_lifecycle(
            "one",
            HostTerminalState::Failed,
            true,
            Some("lost".to_owned()),
            2,
        );
        assert_eq!(restored.view().resume_blob, blob);
    }

    #[test]
    fn chat_selection_is_independent_and_survives_immediate_and_deferred_resume() {
        let one = pane("one", "pane-one", "one");
        let two = pane("two", "pane-two", "two");
        let snapshot = snapshot(vec![one.clone(), two.clone()]);
        let mut rail = TerminalRail::default();
        rail.open_pane(&one);
        rail.open_pane(&two);
        assert!(rail.select_chat("one", true));
        assert!(!rail.select_chat("one", true));
        assert!(!rail.select_chat("missing", true));
        rail.open_pane(&one);
        rail.reconcile(&snapshot);
        assert!(rail.view().terminals[0].chat_selected);
        assert!(!rail.view().terminals[1].chat_selected);
        let blob = rail.view().resume_blob;

        for deferred in [false, true] {
            let mut restored = TerminalRail::default();
            if deferred {
                restored.defer_restore(Some(&blob));
                assert_eq!(restored.view().resume_blob, blob);
                restored.reconcile(&snapshot);
            } else {
                restored.restore_blob(Some(&blob), &snapshot);
            }
            assert!(restored.view().terminals[0].chat_selected);
            assert!(!restored.view().terminals[1].chat_selected);
            assert!(restored.select_chat("one", false));
            let mut terminal_mode = TerminalRail::default();
            terminal_mode.restore_blob(Some(&restored.view().resume_blob), &snapshot);
            assert!(
                terminal_mode
                    .view()
                    .terminals
                    .iter()
                    .all(|terminal| !terminal.chat_selected)
            );
        }
    }

    #[test]
    fn closing_or_removing_a_terminal_discards_its_chat_selection() {
        let one = pane("one", "pane-one", "one");
        for close in [false, true] {
            let mut rail = TerminalRail::default();
            rail.open_pane(&one);
            rail.select_chat("one", true);
            if close {
                rail.close("one");
            } else {
                rail.reconcile(&snapshot(Vec::new()));
            }
            rail.open_pane(&one);
            assert!(!rail.view().terminals[0].chat_selected);
            assert!(
                TerminalResume::decode(Some(&rail.view().resume_blob))
                    .chat_terminal_ids
                    .is_empty()
            );
        }
    }

    #[test]
    fn legacy_resume_migrates_identity_and_selection_only() {
        let mut rail = TerminalRail::default();
        rail.restore_blob(Some(r#"{"sessions":[null,{"terminalId":"one","paneId":"old","title":"old","fontSize":12},{"terminalId":"one"},{"terminalId":"missing"},{"terminalId":"two"}],"activeTerminalId":"two"}"#),
            &snapshot(vec![pane("one", "pane-one", "one"), pane("two", "pane-two", "two")]));
        assert_eq!(rail.terminals.len(), 2);
        assert_eq!(rail.active_terminal_id.as_deref(), Some("two"));
        let resume = TerminalResume::decode(Some(&rail.view().resume_blob));
        assert_eq!(resume.terminal_ids, ["one", "two"]);
        assert_eq!(rail.terminals[0].pane_id, "pane-one");
    }

    #[test]
    fn corrupt_or_unsupported_resume_cannot_restore_terminals() {
        for blob in [
            None,
            Some("not json"),
            Some(r#"{"version":2,"terminalIds":["one"],"activeTerminalId":"one"}"#),
        ] {
            let mut rail = TerminalRail::default();
            rail.restore_blob(blob, &snapshot(vec![pane("one", "pane-one", "one")]));
            assert!(rail.terminals.is_empty());
            assert_eq!(rail.active_terminal_id, None);
        }
    }

    #[test]
    fn restore_discards_invalid_and_duplicate_terminal_ids() {
        let mut rail = TerminalRail::default();
        let current = pane("valid", "pane-valid", "valid");

        rail.restore(
            vec!["missing".to_owned(), "valid".to_owned(), "valid".to_owned()],
            Some("missing".to_owned()),
            &snapshot(vec![current]),
        );

        assert_eq!(rail.terminals.len(), 1);
        assert_eq!(rail.terminals[0].terminal_id, "valid");
        assert_eq!(rail.active_terminal_id.as_deref(), Some("valid"));
    }
}
