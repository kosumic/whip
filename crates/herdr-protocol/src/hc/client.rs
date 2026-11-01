//! Core protocol/domain semantics over caller-owned request and stream effects.
//! No executor, sockets, process spawning, clock, or application lifecycle.
use super::{
    Error,
    documents::{APP_DOCUMENT, Document, Documents},
    events::{Changes, DocumentKey, Notification, Snapshot},
    generated::{HelloResult, Request, Response, SubscribeResult},
    projection::{self, Projection, View},
    wire::Kind,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fmt,
    future::Future,
    sync::{Mutex, MutexGuard},
};

#[derive(Clone, Debug, PartialEq)]
pub enum CallError<E> {
    Protocol(Error),
    Transport(E),
    Partial {
        operation: &'static str,
        completed: Vec<String>,
        cause: Box<Self>,
    },
}
impl<E> From<Error> for CallError<E> {
    fn from(error: Error) -> Self {
        Self::Protocol(error)
    }
}
impl<E: fmt::Display> fmt::Display for CallError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(e) => e.fmt(f),
            Self::Transport(e) => e.fmt(f),
            Self::Partial {
                operation,
                completed,
                cause,
            } => write!(
                f,
                "{operation} partially completed for terminals [{}]: {cause}",
                completed.join(", ")
            ),
        }
    }
}
impl<E> CallError<E> {
    pub fn is_rpc_kind(&self, kind: &str) -> bool {
        matches!(self,Self::Protocol(Error::Rpc(error)) if error.data.as_ref().is_some_and(|data|data.kind==kind))
    }
    pub(crate) fn after(self, operation: &'static str, completed: Vec<String>) -> Self {
        if completed.is_empty() {
            self
        } else {
            Self::Partial {
                operation,
                completed,
                cause: Box::new(self),
            }
        }
    }
}

/// Implemented by the host's generation-fenced transport. A stream-producing
/// request returns an already claimed channel, whose owner must close it.
pub trait Transport: Sync {
    type Failure: fmt::Display + Send + Sync;
    fn rpc(
        &self,
        request: Request,
    ) -> impl Future<Output = Result<Response, CallError<Self::Failure>>> + Send;
    fn stream_send(
        &self,
        channel: u32,
        kind: Kind,
        payload: Vec<u8>,
    ) -> Result<(), CallError<Self::Failure>>;
    fn stream_close(&self, channel: u32) -> Result<(), CallError<Self::Failure>>;
}

pub struct Client {
    pub(crate) state: Mutex<State>,
}
pub(crate) struct State {
    pub hello: HelloResult,
    pub snapshot: Snapshot,
    pub documents: Documents,
    pub machines: BTreeMap<String, String>,
    pub machine_epoch: u64,
    pub machine_refreshed: u64,
}

impl Client {
    pub fn new(hello: HelloResult, subscription: SubscribeResult) -> Result<Self, Error> {
        super::validate_hello(&hello)?;
        let mut documents = Documents::default();
        documents.invalidate(
            DocumentKey {
                machine: None,
                name: APP_DOCUMENT.into(),
            },
            0,
        )?;
        Ok(Self {
            state: Mutex::new(State {
                hello,
                snapshot: Snapshot::new(subscription)?,
                documents,
                machines: BTreeMap::new(),
                machine_epoch: 1,
                machine_refreshed: 0,
            }),
        })
    }
    pub(crate) fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    pub fn projection(&self, view: &View) -> Result<Projection, Error> {
        let state = self.state();
        projection::project(
            &state.hello.version,
            &state.snapshot,
            &state.documents,
            view,
        )
    }
    pub fn needs_refresh(&self) -> bool {
        let state = self.state();
        state.machine_epoch != state.machine_refreshed || state.documents.dirty().next().is_some()
    }

    pub fn apply_notifications(&self, notifications: Vec<Notification>) -> Result<Changes, Error> {
        let mut state = self.state();
        let mut all = Changes::default();
        for notification in notifications {
            let changes = state.snapshot.apply(notification)?;
            for (key, version) in &changes.documents {
                if key.name == APP_DOCUMENT {
                    state.documents.invalidate(key.clone(), *version)?;
                }
            }
            if changes.refetch_documents {
                state.documents.invalidate_all();
            }
            if changes.machines {
                state.machine_epoch = state
                    .machine_epoch
                    .checked_add(1)
                    .ok_or(Error::Limit("machine revisions"))?;
            }
            all.terminals |= changes.terminals;
            all.refetch_documents |= changes.refetch_documents;
            all.machines |= changes.machines;
            all.documents.extend(
                changes
                    .documents
                    .into_iter()
                    .filter(|(key, _)| key.name == APP_DOCUMENT),
            );
            all.restarted.extend(changes.restarted);
        }
        drop(state);
        Ok(all)
    }

    pub async fn refresh<T: Transport>(&self, io: &T) -> Result<(), CallError<T::Failure>> {
        let epoch = {
            let state = self.state();
            (state.machine_epoch != state.machine_refreshed).then_some(state.machine_epoch)
        };
        if let Some(epoch) = epoch {
            let response = io
                .rpc(Request::terminal_list(
                    super::generated::TerminalListParams::default(),
                ))
                .await?;
            let Response::TerminalList(list) = response else {
                return Err(Error::InvalidMessage("expected terminal.list result".into()).into());
            };
            let mut state = self.state();
            let mut machines = BTreeMap::new();
            for machine in list.machines {
                if machine.state != "connected" {
                    continue;
                }
                if state
                    .machines
                    .get(&machine.name)
                    .is_some_and(|id| id != &machine.id)
                {
                    state.documents.forget_machine(&machine.name);
                }
                let key = DocumentKey {
                    machine: Some(machine.name.clone()),
                    name: APP_DOCUMENT.into(),
                };
                state.documents.invalidate(key, 0)?;
                machines.insert(machine.name, machine.id);
            }
            let removed: Vec<_> = state
                .machines
                .keys()
                .filter(|key| !machines.contains_key(*key))
                .cloned()
                .collect();
            for machine in removed {
                state.documents.forget_machine(&machine);
            }
            state.machines = machines;
            state.machine_refreshed = epoch;
        }
        for _ in 0..4 {
            let keys: Vec<_> = { self.state().documents.dirty().cloned().collect() };
            if keys.is_empty() {
                return Ok(());
            }
            for key in keys {
                self.read_document(io, key).await?;
            }
        }
        if self.state().documents.dirty().next().is_some() {
            return Err(Error::DocumentConflict.into());
        }
        Ok(())
    }

    pub(crate) async fn read_document<T: Transport>(
        &self,
        io: &T,
        key: DocumentKey,
    ) -> Result<Document, CallError<T::Failure>> {
        let response = io
            .rpc(Request::doc_get(super::generated::DocGetParams {
                name: key.name.clone(),
                on: key.machine.clone(),
            }))
            .await?;
        let Response::DocGet(reply) = response else {
            return Err(Error::InvalidMessage("expected doc.get result".into()).into());
        };
        let document = Document::from_reply(*reply)?;
        self.state().documents.apply(key, document.clone())?;
        Ok(document)
    }

    pub(crate) async fn write_document<T: Transport>(
        &self,
        io: &T,
        edit: &super::edits::Edit,
    ) -> Result<(), CallError<T::Failure>> {
        let key = edit.key().clone();
        let mut base = { self.state().documents.get(&key).cloned() };
        for _ in 0..3 {
            let document = match base.take() {
                Some(document) => document,
                None => self.read_document(io, key.clone()).await?,
            };
            let value = edit.apply(&document.value)?;
            let params = document.write(&key, value.clone())?;
            match io.rpc(Request::doc_set(params)).await {
                Ok(Response::DocSet(result)) => {
                    self.state()
                        .documents
                        .acknowledge(key, &document, value, result.version)?;
                    return Ok(());
                }
                Ok(_) => return Err(Error::InvalidMessage("expected doc.set result".into()).into()),
                Err(error) if error.is_rpc_kind("conflict") => {
                    base = Some(self.read_document(io, key.clone()).await?);
                }
                Err(error) => return Err(error), // A lost acknowledgement is never replayed.
            }
        }
        Err(Error::DocumentConflict.into())
    }

    pub(crate) fn terminal(&self, address: &str) -> Result<super::generated::Terminal, Error> {
        self.state()
            .snapshot
            .terminal(address)
            .cloned()
            .ok_or(Error::NotFound("terminal"))
    }
    pub(crate) fn inserted(&self, value: Value) -> Result<(), Error> {
        self.state()
            .snapshot
            .insert_created(serde_json::from_value(value)?)
    }

    pub async fn request_json<T: Transport>(
        &self,
        io: &T,
        method: &str,
        params: Value,
        view: &mut View,
        nonce: &str,
    ) -> Result<Value, CallError<T::Failure>> {
        if method == "pane.report_agent_session" {
            #[derive(serde::Deserialize)]
            struct Identity {
                pane_id: String,
                agent: String,
                agent_session_id: String,
            }
            let identity: Identity = serde_json::from_value(params).map_err(Error::from)?;
            if identity.agent_session_id.is_empty()
                || super::projection::agent_kind(&identity.agent).is_none()
            {
                return Err(
                    Error::InvalidMessage("invalid provider conversation identity".into()).into(),
                );
            }
            let projection = self.projection(view)?;
            let pane = projection
                .panes
                .get(&identity.pane_id)
                .ok_or(Error::NotFound("pane"))?;
            let labels = [
                ("whip.transcript.agent".into(), identity.agent),
                ("whip.transcript.kind".into(), "id".into()),
                ("whip.transcript.value".into(), identity.agent_session_id),
            ]
            .into();
            io.rpc(Request::terminal_label(
                super::generated::TerminalLabelParams {
                    terminal: pane.terminal.clone(),
                    labels,
                },
            ))
            .await?;
            return Ok(serde_json::json!({"type":"ok"}));
        }
        if super::generated::METHODS.contains(&method) {
            let request = Request::from_method_params(method, params)?;
            if request.opens_channel() {
                return Err(Error::Unsupported("stream RPCs on a request-only interface").into());
            }
            return io.rpc(request).await?.as_value().map_err(Into::into);
        }
        // Request-only callers may use the canonical legacy-named operations.
        let mut action = params
            .as_object()
            .cloned()
            .ok_or_else(|| Error::InvalidMessage("control params must be an object".into()))?;
        action.insert("action".into(), Value::String(method.replace('.', "_")));
        let command = serde_json::from_value(Value::Object(action))
            .map_err(|_| Error::MissingMethod(method.into()))?;
        let mut result = serde_json::to_value(self.control(io, command, view, nonce).await?)
            .map_err(Error::from)?;
        if let Some(object) = result.as_object_mut()
            && let Some(kind) = object.remove("kind")
        {
            object.insert("type".into(), kind);
        }
        Ok(result)
    }
}
