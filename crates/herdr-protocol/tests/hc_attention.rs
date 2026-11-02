#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "behavioral protocol fixtures fail immediately on unexpected replies"
)]
use herdr_protocol::{
    control::HerdrAgentStatus as Status,
    hc::{
        self,
        attention::{self, Attention, Change, Viewing},
        client::{CallError, Client, Transport},
        events::{Event, Notification},
        generated::{Request, Response, Terminal},
        projection::View,
        wire::Kind,
    },
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};

fn terminal(turn: u64, seen: Option<&str>, status: &str) -> Terminal {
    let mut value = json!({"address":"mac/t7","labels":{},"argv":["codex"],"cwd":"/tmp","state":"live","created_ms":1,"screen":"exact","cols":80,"rows":24,"reported":true,"status":{"state":status,"app":"codex"},"turn":turn});
    if let Some(seen) = seen {
        value["labels"][attention::SEEN_LABEL] = json!(seen);
    }
    serde_json::from_value(value).unwrap()
}
fn client(record: &Terminal) -> Client {
    Client::new(serde_json::from_value(json!({"generation":1,"version":"0.1.17","framed":true,"core":{"id":"a","name":"test"},"methods":hc::generated::METHODS,"features":[]})).unwrap(), serde_json::from_value(json!({"seq":1,"terminals":[record],"channel":7})).unwrap()).unwrap()
}
fn complete<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("unexpected pending fixture"),
    }
}
struct Io {
    replies: Mutex<VecDeque<Value>>,
    calls: Mutex<Vec<Request>>,
}
impl Io {
    fn new(replies: impl IntoIterator<Item = Value>) -> Self {
        Self {
            replies: Mutex::new(replies.into_iter().collect()),
            calls: Mutex::new(Vec::new()),
        }
    }
    fn writes(&self) -> Vec<Request> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method() == "terminal.label")
            .cloned()
            .collect()
    }
}
impl Transport for Io {
    type Failure = String;
    fn rpc(
        &self,
        request: Request,
    ) -> impl Future<Output = Result<Response, CallError<String>>> + Send {
        self.calls.lock().unwrap().push(request.clone());
        std::future::ready(
            request
                .decode(
                    self.replies
                        .lock()
                        .unwrap()
                        .pop_front()
                        .expect("unexpected request"),
                )
                .map_err(Into::into),
        )
    }
    fn stream_send(&self, _: u32, _: Kind, _: Vec<u8>) -> Result<(), CallError<String>> {
        panic!("unexpected stream")
    }
    fn stream_close(&self, _: u32) -> Result<(), CallError<String>> {
        panic!("unexpected stream")
    }
}

#[test]
fn shared_seen_preserves_status_priority_unknowns_and_missing_label_fallback() {
    for (turn, seen, reported, expected) in [
        (4, Some("3"), "idle", Status::Done),
        (4, Some("4"), "done", Status::Idle),
        (0, Some("0"), "idle", Status::Idle),
        (4, Some("5"), "done", Status::Idle),
        (4, None, "done", Status::Done),
        (4, None, "idle", Status::Idle),
        (4, Some("invalid"), "done", Status::Done),
        (4, Some("-1"), "idle", Status::Idle),
        (4, Some("4"), "blocked", Status::Blocked),
        (4, Some("4"), "error", Status::Blocked),
        (4, Some("4"), "working", Status::Working),
    ] {
        assert_eq!(attention::status(&terminal(turn, seen, reported)), expected);
    }
    let mut unknown = terminal(4, Some("0"), "idle");
    unknown.reported = Some(false);
    unknown.status = None;
    assert_eq!(attention::status(&unknown), Status::Unknown);
}

#[test]
fn completed_turn_event_and_missed_snapshot_reconcile_cross_client_labels() {
    let client = client(&terminal(1, Some("1"), "working"));
    client
        .apply_notifications(vec![Notification::Event(Event {
            seq: 2,
            kind: "status".into(),
            terminal: Some("mac/t7".into()),
            machine: None,
            data: json!({"status":{"state":"idle","app":"codex"},"records":{},"reported":true}),
        })])
        .unwrap();
    assert_eq!(
        client.projection(&View::default()).unwrap().snapshot.agents[0].agent_status,
        Status::Idle
    );
    client
        .apply_notifications(vec![Notification::Event(Event {
            seq: 3,
            kind: "turn".into(),
            terminal: Some("mac/t7".into()),
            machine: None,
            data: json!({"turn":2}),
        })])
        .unwrap();
    assert_eq!(
        client.projection(&View::default()).unwrap().snapshot.agents[0].agent_status,
        Status::Done
    );
    let mut seen = terminal(2, Some("2"), "idle");
    seen.labels
        .insert(attention::PINNED_LABEL.into(), "1".into());
    client
        .apply_notifications(vec![Notification::Missed {
            seq: 5,
            terminals: vec![seen],
        }])
        .unwrap();
    assert_eq!(
        client.projection(&View::default()).unwrap().snapshot.agents[0].agent_status,
        Status::Idle
    );
    assert!(client.attention("mac/t7").unwrap().pinned);
}

#[test]
fn foreground_views_write_once_per_turn_and_respect_mark_unread_until_reentry() {
    let attention = Attention {
        turn: 2,
        seen: Some(1),
        pinned: false,
    };
    let mut viewing = Viewing::default();
    assert_eq!(viewing.observe(attention), None);
    viewing.set_terminal(Some("mac/t7".into()));
    assert_eq!(viewing.observe(attention), Some(2));
    assert_eq!(viewing.observe(attention), None);
    assert_eq!(
        viewing.observe(Attention {
            seen: Some(0),
            ..attention
        }),
        None
    );
    viewing.set_terminal(None);
    viewing.set_terminal(Some("mac/t7".into()));
    assert_eq!(viewing.observe(attention), Some(2));
    assert_eq!(
        viewing.observe(Attention {
            turn: 3,
            ..attention
        }),
        Some(3)
    );
}

#[test]
fn writes_use_fresh_remote_turns_and_seen_values_and_stop_when_covered() {
    let initial = terminal(2, Some("1"), "idle");
    let client = client(&initial);
    for remote in [
        terminal(3, Some("1"), "idle"),
        terminal(2, Some("3"), "idle"),
    ] {
        let io = Io::new([serde_json::to_value(remote).unwrap()]);
        complete(client.update_attention(&io, "mac/t7", Change::Seen(2), || true)).unwrap();
        assert!(io.writes().is_empty());
    }
    let io = Io::new([]);
    complete(client.update_attention(&io, "mac/t7", Change::Seen(2), || false)).unwrap();
    assert!(io.calls.lock().unwrap().is_empty());
    let io = Io::new([serde_json::to_value(&initial).unwrap()]);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    complete(client.update_attention(&io, "mac/t7", Change::Seen(2), || {
        calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0
    }))
    .unwrap();
    assert!(io.writes().is_empty());
}

#[test]
fn pin_unpin_and_unread_target_only_the_requested_remote_terminal() {
    for pinned in [true, false] {
        let mut record = terminal(2, Some("2"), "idle");
        if !pinned {
            record
                .labels
                .insert(attention::PINNED_LABEL.into(), "1".into());
        }
        let io = Io::new([
            serde_json::to_value(&record).unwrap(),
            serde_json::to_value(&record).unwrap(),
        ]);
        complete(client(&record).update_attention(&io, "mac/t7", Change::Pinned(pinned), || true))
            .unwrap();
        let Request::TerminalLabel(params) = &io.writes()[0] else {
            panic!("wrong write")
        };
        assert_eq!(params.terminal, "mac/t7");
        assert_eq!(
            params.labels.get(attention::PINNED_LABEL).unwrap(),
            if pinned { "1" } else { "" }
        );
        assert_eq!(params.labels.len(), 1);
    }
    let record = terminal(2, Some("2"), "idle");
    let expected = Attention::from_terminal(&record);
    let io = Io::new([
        serde_json::to_value(&record).unwrap(),
        serde_json::to_value(&record).unwrap(),
    ]);
    complete(client(&record).update_attention(&io, "mac/t7", Change::Unread(expected), || true))
        .unwrap();
    let Request::TerminalLabel(params) = &io.writes()[0] else {
        panic!("wrong write")
    };
    assert_eq!(params.labels.get(attention::SEEN_LABEL).unwrap(), "1");
    for remote in [
        terminal(3, Some("3"), "idle"),
        terminal(2, Some("1"), "idle"),
        terminal(0, Some("0"), "idle"),
    ] {
        let io = Io::new([serde_json::to_value(&remote).unwrap()]);
        complete(
            client(&remote).update_attention(&io, "mac/t7", Change::Unread(expected), || true),
        )
        .unwrap();
        assert!(io.writes().is_empty());
    }
}
