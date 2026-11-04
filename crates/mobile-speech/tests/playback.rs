use mobile_speech::{
    Admission, Arbiter, PlaybackQueue, Preemption, QueueConfig, QueueItem, WaitingLimits,
};

fn queue(limits: WaitingLimits) -> PlaybackQueue {
    PlaybackQueue::new(QueueConfig {
        max_waiting_chunks: 2,
        max_waiting_utf16_units: 40,
        max_wait_ms: 100,
        limits,
    })
}

fn item(source: &str, group: &str, text: &str) -> QueueItem {
    QueueItem {
        source: source.into(),
        group: group.into(),
        text: text.into(),
        prefix: format!("{source}: "),
        context: String::new(),
    }
}

#[test]
fn application_context_survives_prefixing_and_playback() {
    let mut queue = queue(WaitingLimits::Always);
    let mut first = item("chat", "reply", "First.");
    first.context = "original-part:0".into();
    queue.enqueue(first, 0);
    let Some(playback) = queue.take(0) else {
        panic!("playback request missing")
    };
    assert_eq!(playback.item.text, "chat: First.");
    assert_eq!(playback.item.context, "original-part:0");
    assert!(queue.complete(playback.id));
}

#[test]
fn a_plain_text_consumer_finishes_audio_before_advancing() {
    let mut queue = queue(WaitingLimits::Always);
    queue.enqueue(item("navigation", "route", "Turn left."), 0);
    queue.enqueue(item("messages", "message", "Hello."), 1);
    let Some(first) = queue.take(2) else {
        panic!("first request missing")
    };
    assert_eq!(first.item.text, "navigation: Turn left.");
    assert!(queue.take(3).is_none());
    assert!(!queue.complete(first.id + 1));
    assert!(queue.complete(first.id));
    let Some(second) = queue.take(4) else {
        panic!("second request missing")
    };
    assert_eq!(second.item.text, "messages: Hello.");
    assert!(!queue.complete(first.id));
    assert!(queue.complete(second.id));
}

#[test]
fn cancelling_and_restarting_never_reuses_a_native_callback_identity() {
    let mut queue = queue(WaitingLimits::Always);
    queue.enqueue(item("reader", "first", "One."), 0);
    let Some(first) = queue.take(0) else {
        panic!("first request missing")
    };
    assert_eq!(queue.clear(), Some(first.clone()));
    queue.enqueue(item("reader", "second", "Two."), 1);
    let Some(second) = queue.take(1) else {
        panic!("replacement missing")
    };
    assert_ne!(first.id, second.id);
    assert!(!queue.complete(first.id));
    assert!(queue.take(2).is_none());
    assert!(queue.complete(second.id));
}

#[test]
fn an_active_group_finishes_including_late_continuations_before_competitors() {
    let mut queue = queue(WaitingLimits::WhenCompeting);
    queue.enqueue(item("reader", "paragraph", "Beginning."), 0);
    let Some(first) = queue.take(0) else {
        panic!("first request missing")
    };
    queue.enqueue(item("alerts", "one", "Expired."), 1);
    queue.enqueue(item("reader", "paragraph", "Ending."), 2);
    assert!(queue.complete(first.id));
    let Some(tail) = queue.take(200) else {
        panic!("continuation expired")
    };
    assert_eq!(tail.item.text, "Ending.");
    assert!(queue.complete(tail.id));
    assert!(queue.take(201).is_none());
}

#[test]
fn skip_suppresses_future_continuations_but_preserves_other_sources() {
    let mut queue = queue(WaitingLimits::WhenCompeting);
    queue.enqueue(item("reader", "paragraph", "Beginning."), 0);
    let Some(first) = queue.take(0) else {
        panic!("first request missing")
    };
    queue.enqueue(item("alerts", "one", "Waiting."), 1);
    queue.dismiss_current();
    assert!(!queue.enqueue(item("reader", "paragraph", "Skipped ending."), 2));
    assert!(!queue.complete(first.id));
    let Some(next) = queue.take(3) else {
        panic!("other source lost")
    };
    assert_eq!(next.item.source, "alerts");
}

#[test]
fn waiting_limits_drop_oldest_and_count_utf16_including_prefix() {
    let mut queue = queue(WaitingLimits::Always);
    for index in 0..4 {
        queue.enqueue(item("a", &index.to_string(), "😀😀😀😀😀😀😀😀"), index);
    }
    // Each request is 16 UTF-16 content units plus a three-unit prefix.
    let Some(first) = queue.take(4) else {
        panic!("waiting request missing")
    };
    assert_eq!(first.item.group, "2");
    assert!(queue.complete(first.id));
    let Some(second) = queue.take(4) else {
        panic!("waiting request missing")
    };
    assert_eq!(second.item.group, "3");
    assert!(queue.complete(second.id));
    assert!(queue.take(4).is_none());
}

#[test]
fn single_source_expiry_is_an_application_choice() {
    for (limits, expires) in [
        (WaitingLimits::Always, true),
        (WaitingLimits::WhenCompeting, false),
    ] {
        let mut queue = queue(limits);
        queue.enqueue(item("reader", "paragraph", "Hello."), 0);
        assert_eq!(queue.take(200).is_none(), expires);
    }
}

#[test]
fn leases_fence_preemption_owner_teardown_and_boundary_handoff() {
    let mut arbiter = Arbiter::default();
    let reader = Admission {
        preemption: Preemption::Any,
        retain_on_complete: true,
    };
    let alert = Admission {
        preemption: Preemption::Never,
        retain_on_complete: false,
    };
    let Some(first) = arbiter.claim(10, "reader", "request", reader) else {
        panic!("reader denied")
    };
    assert!(arbiter.claim(20, "alert", "", alert).is_none());
    assert!(arbiter.complete(first));
    assert!(arbiter.is_current(first));
    let Some(second) = arbiter.handoff(Some(first), 10, 20, "alert", alert) else {
        panic!("handoff denied")
    };
    assert!(!arbiter.stop(first));
    assert!(!arbiter.complete(first));
    assert!(arbiter.stop_matching(10, Some("reader"), None).is_none());
    assert!(
        arbiter
            .handoff(Some(first), 10, 20, "another", alert)
            .is_none()
    );
    assert!(arbiter.complete(second));
    assert!(!arbiter.is_current(second));
    let Some(third) = arbiter.claim(10, "reader", "new", reader) else {
        panic!("reader denied")
    };
    assert_ne!(first, third);
    assert!(arbiter.stop_matching(10, None, Some("request")).is_none());
    assert_eq!(
        arbiter.stop_matching(10, Some("reader"), Some("new")),
        Some(third)
    );
}

#[test]
fn owner_scoped_and_class_scoped_preemption_are_configurable() {
    for preemption in [Preemption::SameClass, Preemption::SameOwner] {
        let policy = Admission {
            preemption,
            retain_on_complete: false,
        };
        let mut arbiter = Arbiter::default();
        assert!(arbiter.claim(1, "a", "first", policy).is_some());
        assert!(arbiter.claim(2, "a", "second", policy).is_none());
        assert_eq!(
            arbiter.claim(1, "b", "third", policy).is_some(),
            preemption == Preemption::SameClass
        );
    }
}
