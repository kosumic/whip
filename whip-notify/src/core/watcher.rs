//! Core OSC transitions projected through the same layout model as Whip.
use super::{Core, line, request, response};
use crate::{
    NotificationEvent, Result,
    host::{NotificationPreview, agent_preview, hostname, push},
};
use herdr_protocol::hc::{
    documents::{APP_DOCUMENT, Document, Documents},
    events::{Decoder, DocumentKey, Notification, Snapshot, reported_status},
    generated::SubscribeResult,
    projection::{View, project},
};
use serde_json::json;
use std::{collections::BTreeSet, io::BufReader, time::Duration};

pub struct Update {
    pub event: NotificationEvent,
    pub preview: NotificationPreview,
}
pub struct Watcher {
    pub snapshot: Snapshot,
    pub documents: Documents,
}

fn word(snapshot: &Snapshot, address: &str) -> Option<String> {
    snapshot
        .terminal(address)
        .filter(|t| t.state == "live")
        .and_then(reported_status)
        .map(|s| s.state.clone())
}
fn transition(previous: Option<&str>, current: Option<&str>) -> Option<&'static str> {
    let blocked = |word| matches!(word, Some("blocked" | "error"));
    if blocked(current) && !blocked(previous) {
        Some("blocked")
    } else if matches!(current, Some("idle" | "done"))
        && (matches!(previous, Some("working" | "blocked" | "error"))
            || current == Some("done") && previous != Some("done"))
    {
        Some("done")
    } else {
        None
    }
}
impl Watcher {
    pub fn new(reply: SubscribeResult) -> Result<Self> {
        Ok(Self {
            snapshot: Snapshot::new(reply)?,
            documents: Documents::default(),
        })
    }
    pub fn refresh_document(&mut self, core: &Core, key: DocumentKey) -> Result<()> {
        let reply = core.rpc("doc.get", json!({"name":key.name,"on":key.machine}))?;
        let document = Document::from_reply(serde_json::from_value(reply)?)?;
        self.documents.apply(key, document)?;
        Ok(())
    }
    fn refresh_all(&mut self, core: &Core) -> Result<()> {
        let mut machines = BTreeSet::from([None]);
        for terminal in self.snapshot.terminals() {
            if let Some((machine, _)) = terminal.address.rsplit_once('/') {
                machines.insert(Some(machine.to_owned()));
            }
        }
        // Rebuild after reconnect/missed snapshots, including forgotten machines.
        self.documents = Documents::default();
        for machine in machines {
            self.refresh_document(
                core,
                DocumentKey {
                    machine,
                    name: APP_DOCUMENT.into(),
                },
            )?;
        }
        Ok(())
    }
    /// Only fresh status events can alert. Snapshots, label edits and focus cannot.
    pub fn apply(
        &mut self,
        notification: Notification,
        session: &str,
        hostname: &str,
    ) -> Result<Option<Update>> {
        let target = match &notification {
            Notification::Event(event)
                if event.seq > self.snapshot.seq() && event.kind == "status" =>
            {
                event.terminal.clone()
            }
            _ => None,
        };
        let previous = target
            .as_deref()
            .and_then(|address| word(&self.snapshot, address));
        self.snapshot.apply(notification)?;
        let Some(address) = target else {
            return Ok(None);
        };
        let current = word(&self.snapshot, &address);
        let Some(status) = transition(previous.as_deref(), current.as_deref()) else {
            return Ok(None);
        };
        let projection = project(
            "core-push",
            &self.snapshot,
            &self.documents,
            &View::default(),
        )?;
        let Some(agent) = projection
            .snapshot
            .agents
            .iter()
            .find(|agent| agent.terminal_id == address)
        else {
            return Ok(None);
        };
        let event = NotificationEvent {
            pane_id: agent.pane_id.clone(),
            workspace_id: agent.workspace_id.clone(),
            session: session.into(),
            status: status.into(),
            title: agent
                .title
                .as_deref()
                .map(|title| title.chars().take(80).collect()),
        };
        let tab = projection
            .snapshot
            .tabs
            .iter()
            .find(|tab| tab.tab_id == agent.tab_id);
        let tab_label = if projection
            .tabs
            .get(&agent.tab_id)
            .is_some_and(|tab| tab.virtual_tab)
        {
            // Fallback tabs use the terminal address when unnamed. Keep that
            // routing ID out of readable previews, while retaining user names.
            self.snapshot
                .terminal(&address)
                .and_then(|terminal| terminal.name.as_deref())
        } else {
            tab.map(|tab| tab.label.as_str())
        };
        let preview = agent_preview(
            &event,
            agent.display_agent.as_deref().or(agent.agent.as_deref()),
            tab_label,
            hostname,
        );
        Ok(Some(Update { event, preview }))
    }
}

/// One subscription, exposed for isolated protocol tests with a delivery sink.
pub fn follow(core: &Core, send: &mut impl FnMut(Update) -> Result<()>) -> Result<()> {
    let mut stream = BufReader::new(core.connect()?);
    request(stream.get_mut(), "events.subscribe", json!({}))?;
    let mut watcher = Watcher::new(serde_json::from_value(response(&mut stream)?)?)?;
    watcher.refresh_all(core)?;
    let mut decoder = Decoder::default();
    let hostname = hostname();
    loop {
        for notification in decoder.push(&line(&mut stream)?)? {
            let mut refresh = Vec::new();
            let mut refresh_all = matches!(notification, Notification::Missed { .. });
            if let Notification::Event(event) = &notification
                && event.seq > watcher.snapshot.seq()
            {
                refresh_all |= event.kind.starts_with("machine") || event.kind == "created";
                if event.kind == "doc" && event.data["name"] == APP_DOCUMENT {
                    refresh.push(DocumentKey {
                        machine: event.machine.clone(),
                        name: APP_DOCUMENT.into(),
                    });
                }
            }
            let update = watcher.apply(notification, &core.socket, &hostname)?;
            if refresh_all {
                watcher.refresh_all(core)?;
            }
            for key in refresh {
                watcher.refresh_document(core, key)?;
            }
            if let Some(update) = update {
                send(update)?;
            }
        }
    }
}

pub fn watch(core: &Core) -> Result<()> {
    // A lock scoped to this endpoint prevents accidental duplicate watchers.
    crate::host::private_dir(&core.store.state)?;
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .mode(0o600)
        .open(core.store.state.join("watch.lock"))?;
    if !lock.metadata()?.is_file() {
        return Err("unsafe Core watcher lock".into());
    }
    fs2::FileExt::try_lock_exclusive(&lock)?;
    loop {
        let _ = follow(core, &mut |update| {
            if push(&core.store, &update.event, &update.preview).is_err() {
                eprintln!("whip-notify: Core push delivery failed");
            }
            Ok(())
        });
        eprintln!("whip-notify: Core subscription unavailable; reconnecting");
        std::thread::sleep(Duration::from_secs(3));
    }
}
use std::os::unix::fs::OpenOptionsExt;
