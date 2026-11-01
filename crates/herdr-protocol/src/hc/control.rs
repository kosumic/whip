//! Backend-neutral control operations implemented once for all core consumers.
use super::{
    Error, GENERATION,
    client::{CallError, Client, Transport},
    documents::APP_DOCUMENT,
    edits::{self, Change, Edit},
    events::DocumentKey,
    generated::{self as api, Request, Response},
    projection::{self, PaneLocation, Projection, SpaceLocation, TabLocation, View},
    wire::Kind,
};
use crate::control::{
    HerdrAgentKind, HerdrControlRequest as Command, HerdrControlResult as ResultValue,
    HerdrPaneInfo, HerdrPaneReadFormat, HerdrPaneReadResult, HerdrPaneReadSource,
    HerdrPaneZoomResult, HerdrSplitDirection,
};
use std::collections::BTreeSet;

impl Client {
    /// `operation_id` must be fresh for each user operation. Retrying a lost
    /// transport acknowledgement is deliberately the caller's explicit choice.
    #[allow(
        clippy::too_many_lines,
        reason = "one exhaustive adapter covers the existing typed control API without a second operation discriminator"
    )]
    pub async fn control<T: Transport>(
        &self,
        io: &T,
        command: Command,
        view: &mut View,
        operation_id: &str,
    ) -> Result<ResultValue, CallError<T::Failure>> {
        if matches!(command, Command::Ping) {
            return Ok(ResultValue::Pong {
                version: self.state().hello.version.clone(),
                protocol: GENERATION,
            });
        }
        if self.needs_refresh() {
            self.refresh(io).await?;
        }
        let p = self.projection(view)?;
        match command {
            Command::Ping => unreachable!(),
            Command::SessionSnapshot => Ok(ResultValue::SessionSnapshot {
                snapshot: p.snapshot,
            }),
            Command::IntegrationInstall { .. } | Command::IntegrationList => {
                Err(Error::Unsupported("legacy agent integration installation").into())
            }
            Command::WorkspaceCreate { label, cwd } => {
                let space = SpaceLocation {
                    key: DocumentKey {
                        machine: None,
                        name: APP_DOCUMENT.into(),
                    },
                    space: format!("whip-space-{operation_id}"),
                    virtual_space: false,
                };
                self.create(io, view, space, label, cwd, None, operation_id)
                    .await
            }
            Command::TabCreate {
                workspace_id,
                label,
            } => {
                let space = p
                    .spaces
                    .get(&workspace_id)
                    .cloned()
                    .ok_or(Error::NotFound("workspace"))?;
                self.create(
                    io,
                    view,
                    space,
                    label,
                    None,
                    Some(workspace_id),
                    operation_id,
                )
                .await
            }
            Command::WorkspaceFocus { workspace_id } => {
                let tab = p
                    .snapshot
                    .tabs
                    .iter()
                    .find(|t| t.workspace_id == workspace_id)
                    .ok_or(Error::NotFound("workspace tab"))?;
                focus_tab(view, &p, &tab.tab_id)?;
                Ok(ResultValue::WorkspaceInfo {
                    workspace: self
                        .projection(view)?
                        .snapshot
                        .workspaces
                        .into_iter()
                        .find(|w| w.workspace_id == workspace_id)
                        .ok_or(Error::NotFound("workspace"))?,
                })
            }
            Command::TabFocus { tab_id } => {
                focus_tab(view, &p, &tab_id)?;
                Ok(ResultValue::TabInfo {
                    tab: self
                        .projection(view)?
                        .snapshot
                        .tabs
                        .into_iter()
                        .find(|t| t.tab_id == tab_id)
                        .ok_or(Error::NotFound("tab"))?,
                })
            }
            Command::PaneFocus { pane_id } => {
                focus_pane(view, &p, &pane_id)?;
                Ok(ResultValue::PaneInfo {
                    pane: pane(&self.projection(view)?, &pane_id)?.clone(),
                })
            }
            Command::PaneGet { pane_id } => Ok(ResultValue::PaneInfo {
                pane: pane(&p, &pane_id)?.clone(),
            }),
            Command::WorkspaceRename {
                workspace_id,
                label,
            } => {
                let space = p
                    .spaces
                    .get(&workspace_id)
                    .cloned()
                    .ok_or(Error::NotFound("workspace"))?;
                self.write_document(
                    io,
                    &Edit {
                        key: space.key.clone(),
                        change: Change::RenameSpace { space, name: label },
                    },
                )
                .await?;
                Ok(ResultValue::WorkspaceInfo {
                    workspace: self
                        .projection(view)?
                        .snapshot
                        .workspaces
                        .into_iter()
                        .find(|w| w.workspace_id == workspace_id)
                        .ok_or(Error::NotFound("workspace"))?,
                })
            }
            Command::TabRename { tab_id, label } => {
                let tab = p.tabs.get(&tab_id).cloned().ok_or(Error::NotFound("tab"))?;
                self.write_document(
                    io,
                    &Edit {
                        key: tab.space.key.clone(),
                        change: Change::RenameTab { tab, name: label },
                    },
                )
                .await?;
                Ok(ResultValue::TabInfo {
                    tab: self
                        .projection(view)?
                        .snapshot
                        .tabs
                        .into_iter()
                        .find(|t| t.tab_id == tab_id)
                        .ok_or(Error::NotFound("tab"))?,
                })
            }
            Command::PaneRename { pane_id, label } => {
                let location = location(&p, &pane_id)?.clone();
                self.write_document(
                    io,
                    &Edit {
                        key: location.tab.space.key.clone(),
                        change: Change::RenamePane {
                            pane: location,
                            name: label,
                        },
                    },
                )
                .await?;
                Ok(ResultValue::PaneInfo {
                    pane: pane(&self.projection(view)?, &pane_id)?.clone(),
                })
            }
            Command::PaneRead { pane_id, lines } => {
                self.read(io, &p, &pane_id, Some(u64::from(lines))).await
            }
            Command::PaneReadVisible { pane_id } => self.read(io, &p, &pane_id, None).await,
            Command::PaneZoom { pane_id } => {
                let target = pane(&p, &pane_id)?;
                let old_focus = view.pane.clone();
                focus_pane(view, &p, &pane_id)?;
                let zoomed = if view.zoomed.remove(&pane_id) {
                    false
                } else {
                    view.zoomed.insert(pane_id.clone());
                    true
                };
                let layout = self
                    .projection(view)?
                    .snapshot
                    .layouts
                    .into_iter()
                    .find(|l| l.tab_id == target.tab_id)
                    .ok_or(Error::NotFound("pane layout"))?;
                Ok(ResultValue::PaneZoom {
                    zoom: HerdrPaneZoomResult {
                        changed: true,
                        zoom_changed: true,
                        focus_changed: old_focus.as_deref() != Some(&pane_id),
                        reason: None,
                        pane_id: pane_id.clone(),
                        focused_pane_id: pane_id,
                        zoomed,
                        layout,
                    },
                })
            }
            Command::PaneSendText { pane_id, text } => {
                self.raw_input(io, location(&p, &pane_id)?, text.into_bytes())
                    .await?;
                Ok(ResultValue::Ok)
            }
            Command::PaneSendKeys { pane_id, keys } => {
                self.keys(io, &location(&p, &pane_id)?.terminal, keys)
                    .await?;
                Ok(ResultValue::Ok)
            }
            Command::PaneSendInput {
                pane_id,
                text,
                keys,
            } => {
                let terminal = &location(&p, &pane_id)?.terminal;
                self.raw_input(io, location(&p, &pane_id)?, text.into_bytes())
                    .await?;
                if !keys.is_empty() {
                    self.keys(io, terminal, keys)
                        .await
                        .map_err(|e| e.after("send input", vec![terminal.clone()]))?;
                }
                Ok(ResultValue::Ok)
            }
            Command::PaneSplit { pane_id, direction } => {
                let old = location(&p, &pane_id)?.clone();
                let terminal = self
                    .run(
                        io,
                        old.tab.space.key.machine.clone(),
                        self.terminal(&old.terminal)?.cwd.into(),
                    )
                    .await?;
                let node = format!("whip-pane-{operation_id}");
                let edit = Edit {
                    key: old.tab.space.key.clone(),
                    change: Change::Split {
                        pane: old.clone(),
                        container: format!("whip-split-{operation_id}"),
                        new_node: edits::terminal_node(
                            &node,
                            edits::relative_address(&terminal, &old.tab.space.key)?,
                        ),
                        row: direction == HerdrSplitDirection::Right,
                    },
                };
                self.write_document(io, &edit)
                    .await
                    .map_err(|e| e.after("split pane", vec![terminal.clone()]))?;
                let new = projection::pane_id(&PaneLocation {
                    tab: old.tab,
                    node,
                    terminal,
                });
                let p = self.projection(view)?;
                focus_pane(view, &p, &new)?;
                Ok(ResultValue::PaneInfo {
                    pane: pane(&self.projection(view)?, &new)?.clone(),
                })
            }
            Command::WorkspaceClose { workspace_id } => {
                let space = p
                    .spaces
                    .get(&workspace_id)
                    .cloned()
                    .ok_or(Error::NotFound("workspace"))?;
                let targets = p
                    .snapshot
                    .panes
                    .iter()
                    .filter(|p| p.workspace_id == workspace_id)
                    .map(|p| p.terminal_id.clone())
                    .collect();
                self.close(
                    io,
                    targets,
                    Edit {
                        key: space.key.clone(),
                        change: Change::RemoveSpace { space },
                    },
                )
                .await?;
                Ok(ResultValue::Ok)
            }
            Command::TabClose { tab_id } => {
                let tab = p.tabs.get(&tab_id).cloned().ok_or(Error::NotFound("tab"))?;
                let targets = p
                    .snapshot
                    .panes
                    .iter()
                    .filter(|p| p.tab_id == tab_id)
                    .map(|p| p.terminal_id.clone())
                    .collect();
                self.close(
                    io,
                    targets,
                    Edit {
                        key: tab.space.key.clone(),
                        change: Change::RemoveTab { tab },
                    },
                )
                .await?;
                Ok(ResultValue::Ok)
            }
            Command::PaneClose { pane_id } => {
                let pane = location(&p, &pane_id)?.clone();
                self.close(
                    io,
                    BTreeSet::from([pane.terminal.clone()]),
                    Edit {
                        key: pane.tab.space.key.clone(),
                        change: Change::RemovePane { pane },
                    },
                )
                .await?;
                Ok(ResultValue::Ok)
            }
            Command::AgentFocus { target } => {
                let target_agent = agent(&p, &target)?;
                focus_pane(view, &p, &target_agent.pane_id)?;
                Ok(ResultValue::AgentInfo {
                    agent: agent(&self.projection(view)?, &target)?.clone(),
                })
            }
            Command::AgentPrompt { target, text } => {
                let target_agent = agent(&p, &target)?.clone();
                io.rpc(Request::terminal_send(api::TerminalSendParams {
                    terminal: target_agent.terminal_id.clone(),
                    text,
                    wait: Some(false),
                    ..Default::default()
                }))
                .await?;
                Ok(ResultValue::AgentPrompted {
                    agent: target_agent,
                })
            }
            Command::AgentStart {
                name,
                kind,
                pane_id,
                args,
            } => {
                let command = match kind {
                    HerdrAgentKind::Claude => "claude",
                    HerdrAgentKind::Codex => "codex",
                    HerdrAgentKind::OpenCode => "opencode",
                    HerdrAgentKind::Pi => "pi",
                };
                let argv: Vec<_> = std::iter::once(command.into()).chain(args).collect();
                let old = location(&p, &pane_id)?.clone();
                let terminal = self
                    .spawn(
                        io,
                        api::TerminalRunParams {
                            argv: Some(argv.clone()),
                            name: Some(name),
                            cwd: Some(self.terminal(&old.terminal)?.cwd),
                            on: old.tab.space.key.machine.clone(),
                            no_parent: Some(true),
                            keep: Some(true),
                            wait: Some(false),
                            env: Some(terminal_environment()),
                            ..Default::default()
                        },
                    )
                    .await?;
                self.write_document(
                    io,
                    &Edit {
                        key: old.tab.space.key.clone(),
                        change: Change::ReplaceTerminal {
                            pane: old.clone(),
                            address: terminal.clone(),
                        },
                    },
                )
                .await
                .map_err(|e| e.after("start agent", vec![terminal.clone()]))?;
                io.rpc(Request::terminal_kill(api::TerminalKillParams {
                    terminal: old.terminal,
                    ..Default::default()
                }))
                .await
                .map_err(|e| e.after("start agent", vec![terminal]))?;
                // The launch acknowledgement is not an OSC status report.
                Ok(ResultValue::AgentStarted {
                    agent: agent(&self.projection(view)?, &pane_id)?.clone(),
                    argv,
                })
            }
        }
    }

    async fn run<T: Transport>(
        &self,
        io: &T,
        on: Option<String>,
        cwd: Option<String>,
    ) -> Result<String, CallError<T::Failure>> {
        self.spawn(
            io,
            api::TerminalRunParams {
                on,
                cwd,
                keep: Some(true),
                wait: Some(false),
                env: Some(terminal_environment()),
                ..Default::default()
            },
        )
        .await
    }
    async fn spawn<T: Transport>(
        &self,
        io: &T,
        params: api::TerminalRunParams,
    ) -> Result<String, CallError<T::Failure>> {
        let Response::TerminalRun(result) = io.rpc(Request::terminal_run(params)).await? else {
            return Err(Error::InvalidMessage("expected terminal.run result".into()).into());
        };
        let address = result.address.clone();
        self.inserted(serde_json::to_value(result).map_err(Error::from)?)?;
        Ok(address)
    }
    #[allow(
        clippy::too_many_arguments,
        reason = "creation keeps its target, optional label/directory, and caller-owned operation identity explicit"
    )]
    async fn create<T: Transport>(
        &self,
        io: &T,
        view: &mut View,
        space: SpaceLocation,
        label: Option<String>,
        cwd: Option<String>,
        existing: Option<String>,
        nonce: &str,
    ) -> Result<ResultValue, CallError<T::Failure>> {
        let terminal = self.run(io, space.key.machine.clone(), cwd).await?;
        let tab = TabLocation {
            space: space.clone(),
            tab: format!("whip-tab-{nonce}"),
            virtual_tab: false,
        };
        let node = format!("whip-pane-{nonce}");
        let title = label.unwrap_or_else(|| {
            if existing.is_some() {
                "Terminal".into()
            } else {
                "Workspace".into()
            }
        });
        let value = edits::terminal_tab(
            &tab.tab,
            &title,
            &node,
            edits::relative_address(&terminal, &space.key)?,
        );
        let change = if existing.is_some() {
            Change::AddTab {
                space: space.clone(),
                tab: value,
            }
        } else {
            Change::AddSpace {
                id: space.space.clone(),
                name: title,
                tab: value,
            }
        };
        self.write_document(
            io,
            &Edit {
                key: space.key.clone(),
                change,
            },
        )
        .await
        .map_err(|e| e.after("create terminal", vec![terminal.clone()]))?;
        let pane_id = projection::pane_id(&PaneLocation {
            tab: tab.clone(),
            node,
            terminal,
        });
        let p = self.projection(view)?;
        focus_pane(view, &p, &pane_id)?;
        let p = self.projection(view)?;
        let root_pane = pane(&p, &pane_id)?.clone();
        let tab = p
            .snapshot
            .tabs
            .iter()
            .find(|t| t.tab_id == projection::tab_id(&tab))
            .cloned()
            .ok_or(Error::NotFound("created tab"))?;
        if existing.is_some() {
            Ok(ResultValue::TabCreated { tab, root_pane })
        } else {
            Ok(ResultValue::WorkspaceCreated {
                workspace: p
                    .snapshot
                    .workspaces
                    .into_iter()
                    .find(|w| w.workspace_id == root_pane.workspace_id)
                    .ok_or(Error::NotFound("created workspace"))?,
                tab,
                root_pane,
            })
        }
    }
    async fn close<T: Transport>(
        &self,
        io: &T,
        targets: BTreeSet<String>,
        edit: Edit,
    ) -> Result<(), CallError<T::Failure>> {
        let mut completed = Vec::new();
        for terminal in targets {
            io.rpc(Request::terminal_kill(api::TerminalKillParams {
                terminal: terminal.clone(),
                ..Default::default()
            }))
            .await
            .map_err(|e| e.after("close terminals", completed.clone()))?;
            completed.push(terminal);
        }
        self.write_document(io, &edit)
            .await
            .map_err(|e| e.after("close terminals", completed))
    }
    async fn read<T: Transport>(
        &self,
        io: &T,
        p: &Projection,
        id: &str,
        lines: Option<u64>,
    ) -> Result<ResultValue, CallError<T::Failure>> {
        let pane = pane(p, id)?;
        let Response::TerminalRead(result) = io
            .rpc(Request::terminal_read(api::TerminalReadParams {
                terminal: pane.terminal_id.clone(),
                lines,
                ..Default::default()
            }))
            .await?
        else {
            return Err(Error::InvalidMessage("expected terminal.read result".into()).into());
        };
        Ok(ResultValue::PaneRead {
            read: HerdrPaneReadResult {
                pane_id: id.into(),
                workspace_id: pane.workspace_id.clone(),
                tab_id: pane.tab_id.clone(),
                source: if lines.is_some() {
                    HerdrPaneReadSource::Recent
                } else {
                    HerdrPaneReadSource::Visible
                },
                format: HerdrPaneReadFormat::Text,
                text: result.text,
                revision: pane.revision,
                truncated: !result.complete,
            },
        })
    }
    async fn keys<T: Transport>(
        &self,
        io: &T,
        terminal: &str,
        keys: Vec<String>,
    ) -> Result<(), CallError<T::Failure>> {
        io.rpc(Request::terminal_keys(api::TerminalKeysParams {
            terminal: terminal.into(),
            keys: keys.into_iter().map(|key| normalize_key(&key)).collect(),
            ..Default::default()
        }))
        .await?;
        Ok(())
    }
    async fn raw_input<T: Transport>(
        &self,
        io: &T,
        pane: &PaneLocation,
        bytes: Vec<u8>,
    ) -> Result<(), CallError<T::Failure>> {
        if bytes.is_empty() {
            return Ok(());
        }
        let terminal = self.terminal(&pane.terminal)?;
        let Response::TerminalAttach(result) = io
            .rpc(Request::terminal_attach(api::TerminalAttachParams {
                terminal: pane.terminal.clone(),
                cols: terminal.cols,
                rows: terminal.rows,
                resumed: Some(true),
                ..Default::default()
            }))
            .await?
        else {
            return Err(Error::InvalidMessage("expected terminal.attach result".into()).into());
        };
        let sent = io.stream_send(result.channel, Kind::Data, bytes);
        let closed = io.stream_close(result.channel);
        sent?;
        closed
    }
}
fn terminal_environment() -> std::collections::BTreeMap<String, String> {
    [
        ("TERM".into(), "xterm-256color".into()),
        ("COLORTERM".into(), "truecolor".into()),
        ("TERM_PROGRAM".into(), "whip".into()),
    ]
    .into()
}
fn pane<'a>(p: &'a Projection, id: &str) -> Result<&'a HerdrPaneInfo, Error> {
    p.snapshot
        .panes
        .iter()
        .find(|pane| pane.pane_id == id)
        .ok_or(Error::NotFound("pane"))
}
fn location<'a>(p: &'a Projection, id: &str) -> Result<&'a PaneLocation, Error> {
    p.panes.get(id).ok_or(Error::NotFound("pane"))
}
fn agent<'a>(p: &'a Projection, target: &str) -> Result<&'a crate::control::HerdrAgentInfo, Error> {
    let mut matches = p.snapshot.agents.iter().filter(|a| {
        a.pane_id == target || a.terminal_id == target || a.name.as_deref() == Some(target)
    });
    let agent = matches.next().ok_or(Error::NotFound("agent"))?;
    if matches.next().is_some() {
        return Err(Error::InvalidMessage("agent target is ambiguous".into()));
    }
    Ok(agent)
}
fn focus_pane(view: &mut View, p: &Projection, id: &str) -> Result<(), Error> {
    let pane = pane(p, id)?;
    view.workspace = Some(pane.workspace_id.clone());
    view.tab = Some(pane.tab_id.clone());
    view.pane = Some(id.into());
    Ok(())
}
fn focus_tab(view: &mut View, p: &Projection, id: &str) -> Result<(), Error> {
    let tab = p
        .snapshot
        .tabs
        .iter()
        .find(|t| t.tab_id == id)
        .ok_or(Error::NotFound("tab"))?;
    view.workspace = Some(tab.workspace_id.clone());
    view.tab = Some(id.into());
    view.pane = p
        .snapshot
        .panes
        .iter()
        .find(|p| p.tab_id == id)
        .map(|p| p.pane_id.clone());
    Ok(())
}
pub fn normalize_key(key: &str) -> String {
    let lower = key.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("c-") {
        format!("ctrl+{rest}")
    } else if let Some(rest) = lower.strip_prefix("m-") {
        format!("alt+{rest}")
    } else {
        match lower.as_str() {
            "return" => "enter".into(),
            "escape" => "esc".into(),
            _ => lower,
        }
    }
}
