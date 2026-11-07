//! Fake platform acknowledgements are deliberately held at async boundaries.
#![allow(clippy::unwrap_used, reason = "Assertions stop immediately on failure")]
use super::*;

fn request(host: &str, pane: &str, status: HerdrAgentStatus, speak: bool) -> LocalAlertRequest {
    LocalAlertRequest {
        host_id: host.into(),
        pane_id: pane.into(),
        tab_id: "tab".into(),
        runtime: None,
        status,
        session_identity: "terminal/session".into(),
        title: "Agent".into(),
        body: "Status".into(),
        announcement: speak.then(|| format!("{pane} {status:?}")),
        language: "en-US".into(),
        delivery: LocalAlertDelivery::Persistent,
        persistent_timeout_ms: 45_000,
        android: true,
    }
}
fn done(pane: &str) -> LocalAlertRequest {
    request("host", pane, HerdrAgentStatus::Done, true)
}
fn one(mut effects: Vec<LocalAlertEffect>) -> LocalAlertEffect {
    assert_eq!(effects.len(), 1, "{effects:?}");
    effects.pop().unwrap()
}
fn schedule(effects: &[LocalAlertEffect]) -> LocalAlertEffect {
    effects
        .iter()
        .find(|e| matches!(e.action, LocalAlertAction::Schedule { .. }))
        .unwrap()
        .clone()
}
fn speech(effects: &[LocalAlertEffect]) -> LocalAlertEffect {
    effects
        .iter()
        .find(|e| matches!(e.action, LocalAlertAction::Speak { .. }))
        .unwrap()
        .clone()
}
fn token(effect: &LocalAlertEffect) -> String {
    let LocalAlertAction::Speak { token, .. } = &effect.action else {
        panic!()
    };
    token.clone()
}
fn begin(owner: &LocalAlertCoordinator, effect: &LocalAlertEffect) {
    assert_eq!(
        owner.begin_effect(effect.id.clone()),
        LocalAlertEffectAdmission::Run
    );
}
fn complete(
    owner: &LocalAlertCoordinator,
    effect: &LocalAlertEffect,
    outcome: LocalAlertOutcome,
) -> Vec<LocalAlertEffect> {
    owner.complete_effect(effect.id.clone(), outcome).unwrap()
}
fn scheduled(
    owner: &LocalAlertCoordinator,
    effect: &LocalAlertEffect,
    id: &str,
) -> Vec<LocalAlertEffect> {
    complete(
        owner,
        effect,
        LocalAlertOutcome::Scheduled {
            notification_id: id.into(),
        },
    )
}
fn register(owner: &LocalAlertCoordinator, effect: &LocalAlertEffect) {
    begin(owner, effect);
    owner
        .state
        .lock()
        .alerts
        .get_mut(&token(effect))
        .unwrap()
        .speech_ready = true;
}
fn take(owner: &LocalAlertCoordinator) -> Option<NativeAnnouncement> {
    owner.state.lock().take_speech(0, Instant::now(), |_, _| 1)
}
fn ended(
    owner: &LocalAlertCoordinator,
    effect: &LocalAlertEffect,
    reason: LocalAlertSpeechEnd,
) -> Vec<LocalAlertEffect> {
    complete(owner, effect, LocalAlertOutcome::SpeechEnded { reason })
}
fn scopes() -> Vec<LocalAlertScope> {
    vec![
        LocalAlertScope::All,
        LocalAlertScope::Host {
            host_id: "host".into(),
        },
        LocalAlertScope::Tab {
            host_id: "host".into(),
            tab_id: "tab".into(),
        },
        LocalAlertScope::Pane {
            host_id: "host".into(),
            pane_id: "a".into(),
        },
    ]
}

#[test]
fn notification_and_persistent_feedback_do_not_wait_for_speech() {
    for status in [HerdrAgentStatus::Done, HerdrAgentStatus::Blocked] {
        for android in [false, true] {
            let owner = LocalAlertCoordinator::new();
            let mut request = request("host", "a", status, true);
            request.android = android;
            let effects = owner.alert(request);
            let notification = schedule(&effects);
            let voice = speech(&effects);
            register(&owner, &voice);
            // A busy native owner denies admission without affecting delivery.
            assert!(
                owner
                    .state
                    .lock()
                    .take_speech(42, Instant::now(), |_, _| 0)
                    .is_none()
            );
            begin(&owner, &notification);
            let feedback = scheduled(&owner, &notification, "notification");
            assert_eq!(feedback.len(), usize::from(android));
            if android {
                let arm = one(feedback);
                assert!(matches!(
                    arm.action,
                    LocalAlertAction::ArmPersistent {
                        timeout_ms: 45_000,
                        ..
                    }
                ));
                begin(&owner, &arm);
                complete(&owner, &arm, LocalAlertOutcome::Done);
            }
            assert_eq!(take(&owner).unwrap().token, token(&voice));
            assert!(ended(&owner, &voice, LocalAlertSpeechEnd::Completed).is_empty());
        }
    }
}

#[test]
fn unrelated_admissions_do_not_preempt_and_waiting_blocked_outranks_done_fifo() {
    let owner = LocalAlertCoordinator::new();
    let a = speech(&owner.alert(done("a")));
    register(&owner, &a);
    assert_eq!(take(&owner).unwrap().token, token(&a));
    let b_effects = owner.alert(done("b"));
    let b = speech(&b_effects);
    register(&owner, &b);
    assert!(
        !b_effects
            .iter()
            .any(|e| matches!(e.action, LocalAlertAction::StopSpeech { .. }))
    );
    let c = speech(&owner.alert(request("other-host", "c", HerdrAgentStatus::Blocked, true)));
    register(&owner, &c);
    let d = speech(&owner.alert(request("host", "d", HerdrAgentStatus::Blocked, true)));
    register(&owner, &d);
    assert!(take(&owner).is_none());
    ended(&owner, &a, LocalAlertSpeechEnd::Completed);
    for expected in [&c, &d, &b] {
        assert_eq!(take(&owner).unwrap().token, token(expected));
        ended(&owner, expected, LocalAlertSpeechEnd::Completed);
    }
    assert!(take(&owner).is_none());
}

#[test]
fn same_pane_coalesces_to_latest_status_session_and_tab_without_stopping_other_panes() {
    let owner = LocalAlertCoordinator::new();
    let a = speech(&owner.alert(done("a")));
    register(&owner, &a);
    take(&owner).unwrap();
    let old = speech(&owner.alert(done("b")));
    register(&owner, &old);
    let mut latest = request("host", "b", HerdrAgentStatus::Blocked, true);
    latest.session_identity = "new-session".into();
    latest.tab_id = "new-tab".into();
    let replacement = owner.alert(latest);
    assert!(
        !replacement
            .iter()
            .any(|e| matches!(e.action, LocalAlertAction::StopSpeech { .. }))
    );
    let new = speech(&replacement);
    register(&owner, &new);
    ended(&owner, &old, LocalAlertSpeechEnd::Busy);
    ended(&owner, &a, LocalAlertSpeechEnd::Completed);
    assert_eq!(take(&owner).unwrap().token, token(&new));
    // A delayed old shake cannot dismiss the replacement or its notification.
    assert!(ended(&owner, &old, LocalAlertSpeechEnd::Shake).is_empty());
    assert!(
        owner
            .state
            .lock()
            .speech_valid(&token(&new), Instant::now())
    );
}

#[test]
fn currently_obsolete_status_is_stopped_by_token_and_late_results_do_not_stop_next_speaker() {
    let owner = LocalAlertCoordinator::new();
    let a = speech(&owner.alert(done("a")));
    register(&owner, &a);
    take(&owner).unwrap();
    let b = speech(&owner.alert(done("b")));
    register(&owner, &b);
    let effects = owner.transition(LocalAlertTransition {
        host_id: "host".into(),
        pane_id: "a".into(),
        runtime: None,
        status: Some(HerdrAgentStatus::Working),
        request: None,
        enabled: false,
        afk_mode: false,
        previous_status: None,
        foreground: false,
    });
    assert!(effects.iter().any(|e| matches!(&e.action, LocalAlertAction::StopSpeech { token: stopped } if stopped == &token(&a))));
    assert_eq!(take(&owner).unwrap().token, token(&b));
    assert!(ended(&owner, &a, LocalAlertSpeechEnd::Shake).is_empty());
    assert!(owner.state.lock().speech_valid(&token(&b), Instant::now()));
}

#[test]
fn queue_is_bounded_preserves_priority_and_expires_without_a_new_status_edge() {
    let owner = LocalAlertCoordinator::new();
    let mut voices = Vec::new();
    for pane in ["a", "b", "c", "d", "e", "f"] {
        let status = if pane == "a" {
            HerdrAgentStatus::Blocked
        } else {
            HerdrAgentStatus::Done
        };
        let voice = speech(&owner.alert(request("host", pane, status, true)));
        register(&owner, &voice);
        voices.push(voice);
    }
    assert_eq!(owner.state.lock().waiting.len(), MAX_WAITING);
    for voice in &voices[1..3] {
        assert!(
            !owner
                .state
                .lock()
                .speech_valid(&token(voice), Instant::now())
        );
    }
    assert_eq!(take(&owner).unwrap().token, token(&voices[0]));
    ended(&owner, &voices[0], LocalAlertSpeechEnd::Completed);
    let expired = Instant::now() + MAX_WAIT;
    assert!(
        owner
            .state
            .lock()
            .take_speech(0, expired, |_, _| panic!(
                "expired speech must not claim playback"
            ))
            .is_none()
    );
}

#[test]
fn delayed_registration_and_denied_lease_claim_do_not_lose_waiting_speech() {
    let owner = LocalAlertCoordinator::new();
    let a = speech(&owner.alert(done("a")));
    assert!(take(&owner).is_none());
    register(&owner, &a);
    assert!(
        owner
            .state
            .lock()
            .take_speech(99, Instant::now(), |_, lease| {
                assert_eq!(lease, 99);
                0
            })
            .is_none()
    );
    assert_eq!(take(&owner).unwrap().token, token(&a));
    // Native completion releases the next item even if JS completion is delayed.
    owner.state.lock().finish_speech(&token(&a));
    let b = speech(&owner.alert(done("b")));
    register(&owner, &b);
    assert_eq!(take(&owner).unwrap().token, token(&b));
    ended(&owner, &a, LocalAlertSpeechEnd::Completed);
    assert!(owner.state.lock().speech_valid(&token(&b), Instant::now()));
}

#[test]
fn every_dismissal_scope_fences_pending_admission_and_cleans_up_late_notifications() {
    for scope in scopes() {
        let owner = LocalAlertCoordinator::new();
        let effects = owner.alert(done("a"));
        let notification = schedule(&effects);
        let voice = speech(&effects);
        begin(&owner, &notification);
        owner.dismiss(scope);
        assert_eq!(
            owner.begin_effect(voice.id.clone()),
            LocalAlertEffectAdmission::Skip
        );
        complete(&owner, &voice, LocalAlertOutcome::Skipped);
        let cleanup = one(scheduled(&owner, &notification, "late"));
        assert!(
            matches!(cleanup.action, LocalAlertAction::DismissNotification { notification_id } if notification_id == "late")
        );
        assert!(take(&owner).is_none());
    }
}

#[test]
fn every_scope_stops_its_current_speech_and_preserves_unrelated_waiting_speech() {
    for scope in scopes().into_iter().skip(1) {
        let owner = LocalAlertCoordinator::new();
        let a = speech(&owner.alert(done("a")));
        register(&owner, &a);
        take(&owner).unwrap();
        let b = speech(&owner.alert(request("other", "b", HerdrAgentStatus::Done, true)));
        register(&owner, &b);
        let cleanup = owner.dismiss(scope);
        assert!(cleanup.iter().any(|e| matches!(&e.action, LocalAlertAction::StopSpeech { token: stopped } if stopped == &token(&a))));
        assert_eq!(take(&owner).unwrap().token, token(&b));
        assert!(ended(&owner, &a, LocalAlertSpeechEnd::Completed).is_empty());
    }
}

#[test]
fn current_shake_dismisses_all_notifications_and_fences_pending_schedules() {
    let owner = LocalAlertCoordinator::new();
    let effects = owner.alert(done("a"));
    let notification = schedule(&effects);
    let voice = speech(&effects);
    begin(&owner, &notification);
    register(&owner, &voice);
    take(&owner).unwrap();
    let b = speech(&owner.alert(done("b")));
    register(&owner, &b);
    ended(&owner, &voice, LocalAlertSpeechEnd::Shake);
    assert!(take(&owner).is_none());
    assert!(matches!(
        one(scheduled(&owner, &notification, "late")).action,
        LocalAlertAction::DismissNotification { .. }
    ));
}

#[test]
fn runtime_incarnation_and_disconnect_invalidate_queue_but_old_events_cannot_dismiss_new_owner() {
    let owner = LocalAlertCoordinator::new();
    let old = LocalAlertRuntime {
        runtime_id: "runtime".into(),
        incarnation: 1,
    };
    let new = LocalAlertRuntime {
        incarnation: 2,
        ..old.clone()
    };
    owner.set_runtime("host".into(), Some(old.clone()));
    let mut first = done("a");
    first.runtime = Some(old.clone());
    let a = speech(&owner.alert(first));
    register(&owner, &a);
    owner.set_runtime("host".into(), Some(new.clone()));
    let mut next = done("a");
    next.runtime = Some(new);
    let b = speech(&owner.alert(next.clone()));
    register(&owner, &b);
    assert!(
        owner
            .transition(LocalAlertTransition {
                host_id: "host".into(),
                pane_id: "a".into(),
                runtime: Some(old),
                status: None,
                request: None,
                enabled: false,
                afk_mode: false,
                previous_status: None,
                foreground: false
            })
            .is_empty()
    );
    assert_eq!(take(&owner).unwrap().token, token(&b));
    owner.set_runtime("host".into(), None);
    assert!(take(&owner).is_none());
    assert!(owner.alert(next).is_empty());
}

#[test]
fn snapshot_identity_status_tab_and_preferences_revalidate_even_without_transition() {
    for change in 0..5 {
        let owner = LocalAlertCoordinator::new();
        let original = done("a");
        let a = speech(&owner.alert(original.clone()));
        register(&owner, &a);
        let mut current = original;
        match change {
            0 => current.session_identity = "different-session".into(),
            1 => current.tab_id = "different-tab".into(),
            2 => current.status = HerdrAgentStatus::Working,
            3 => current.announcement = None,
            _ => {}
        }
        owner.retain_speech(
            "host".into(),
            None,
            if change == 4 { vec![] } else { vec![current] },
        );
        assert!(take(&owner).is_none());
    }
    let owner = LocalAlertCoordinator::new();
    let a = speech(&owner.alert(done("a")));
    register(&owner, &a);
    take(&owner).unwrap();
    assert!(matches!(
        one(owner.set_speech_enabled(false)).action,
        LocalAlertAction::StopSpeech { .. }
    ));
    assert!(take(&owner).is_none());
}

#[test]
fn independent_suppression_tokens_cancel_matching_speech_and_do_not_replay_on_release() {
    let owner = LocalAlertCoordinator::new();
    let a = speech(&owner.alert(done("a")));
    register(&owner, &a);
    take(&owner).unwrap();
    for token in ["old-call", "new-call"] {
        owner.set_suppression(
            token.into(),
            Some(LocalAlertScope::Tab {
                host_id: "host".into(),
                tab_id: "tab".into(),
            }),
        );
    }
    owner.set_suppression("old-call".into(), None);
    assert!(owner.alert(done("b")).is_empty());
    owner.set_suppression("new-call".into(), None);
    assert!(take(&owner).is_none());
    let b = speech(&owner.alert(done("b")));
    register(&owner, &b);
    assert_eq!(take(&owner).unwrap().token, token(&b));
}

#[test]
fn pending_arm_is_serialized_and_late_completion_cannot_disarm_a_newer_notification() {
    let owner = LocalAlertCoordinator::new();
    let first = schedule(&owner.alert(done("a")));
    begin(&owner, &first);
    let arm_old = one(scheduled(&owner, &first, "old"));
    begin(&owner, &arm_old);
    owner.dismiss(LocalAlertScope::Pane {
        host_id: "host".into(),
        pane_id: "a".into(),
    });
    let second = schedule(&owner.alert(done("b")));
    begin(&owner, &second);
    assert!(scheduled(&owner, &second, "new").is_empty());
    let arm_new = one(complete(&owner, &arm_old, LocalAlertOutcome::Done));
    assert!(
        matches!(&arm_new.action, LocalAlertAction::ArmPersistent { notification_id, .. } if notification_id == "new")
    );
    begin(&owner, &arm_new);
    assert!(complete(&owner, &arm_new, LocalAlertOutcome::Done).is_empty());
    assert!(complete(&owner, &arm_old, LocalAlertOutcome::Done).is_empty());
}

#[test]
fn notification_failure_and_speech_failure_have_independent_lifetimes() {
    let owner = LocalAlertCoordinator::new();
    let effects = owner.alert(done("a"));
    let a = speech(&effects);
    let notification = schedule(&effects);
    register(&owner, &a);
    begin(&owner, &notification);
    complete(
        &owner,
        &notification,
        LocalAlertOutcome::Failed {
            message: "notification backend failed".into(),
        },
    );
    assert_eq!(take(&owner).unwrap().token, token(&a));
    assert!(
        complete(
            &owner,
            &a,
            LocalAlertOutcome::Failed {
                message: "engine failed".into()
            }
        )
        .is_empty()
    );
    let effects = owner.alert(done("b"));
    let a = speech(&effects);
    let notification = schedule(&effects);
    register(&owner, &a);
    take(&owner).unwrap();
    complete(
        &owner,
        &a,
        LocalAlertOutcome::Failed {
            message: "engine failed".into(),
        },
    );
    begin(&owner, &notification);
    assert!(matches!(
        one(scheduled(&owner, &notification, "notification")).action,
        LocalAlertAction::ArmPersistent { .. }
    ));
}

#[test]
fn duplicate_and_invalid_completions_do_not_steal_inflight_operations() {
    let owner = LocalAlertCoordinator::new();
    let effects = owner.alert(done("a"));
    let notification = schedule(&effects);
    begin(&owner, &notification);
    assert_eq!(
        owner.begin_effect(notification.id.clone()),
        LocalAlertEffectAdmission::Duplicate
    );
    assert!(matches!(
        owner.complete_effect(notification.id.clone(), LocalAlertOutcome::Done),
        Err(LocalAlertError::InvalidCompletion)
    ));
    scheduled(&owner, &notification, "notification");
    assert!(scheduled(&owner, &notification, "duplicate").is_empty());
}

#[test]
fn foreground_and_disabled_voice_preserve_notification_delivery_modes() {
    for foreground in [false, true] {
        let owner = LocalAlertCoordinator::new();
        let mut request = done("a");
        request.announcement = None;
        let effect = one(owner.transition(LocalAlertTransition {
            host_id: "host".into(),
            pane_id: "a".into(),
            runtime: None,
            status: Some(HerdrAgentStatus::Done),
            request: Some(request),
            enabled: true,
            afk_mode: false,
            previous_status: None,
            foreground,
        }));
        assert!(
            matches!(effect.action, LocalAlertAction::Schedule { request } if request.delivery == if foreground { LocalAlertDelivery::Brief } else { LocalAlertDelivery::Persistent })
        );
    }
}

#[test]
fn working_to_idle_alerts_follow_afk_mode_regardless_of_foreground_state() {
    for afk_mode in [false, true] {
        for foreground in [false, true] {
            for delivery in [LocalAlertDelivery::Regular, LocalAlertDelivery::Persistent] {
                let owner = LocalAlertCoordinator::new();
                let mut request = request("host", "focused-pane", HerdrAgentStatus::Idle, true);
                request.delivery = delivery;
                let effects = owner.transition(LocalAlertTransition {
                    host_id: "host".into(),
                    pane_id: "focused-pane".into(),
                    runtime: None,
                    status: Some(HerdrAgentStatus::Idle),
                    previous_status: Some(HerdrAgentStatus::Working),
                    request: Some(request.clone()),
                    enabled: true,
                    afk_mode,
                    foreground,
                });
                let notification = schedule(&effects);
                assert!(
                    matches!(&notification.action, LocalAlertAction::Schedule { request } if request.delivery == if afk_mode { delivery } else { LocalAlertDelivery::Silent })
                );
                let voice = speech(&effects);
                register(&owner, &voice);
                // Subsequent idle snapshots keep the completion announcement valid.
                assert!(
                    owner
                        .retain_speech("host".into(), None, vec![request])
                        .is_empty()
                );
                assert_eq!(take(&owner).unwrap().token, token(&voice));
                let follow_up = scheduled(&owner, &notification, "idle-notification");
                assert_eq!(
                    follow_up.iter().any(|effect| matches!(
                        effect.action,
                        LocalAlertAction::ArmPersistent { .. }
                    )),
                    afk_mode && delivery == LocalAlertDelivery::Persistent
                );
            }
        }
    }
}

#[test]
fn unrelated_idle_transitions_and_disabled_alerts_do_not_notify() {
    for afk_mode in [false, true] {
        for previous_status in [
            None,
            Some(HerdrAgentStatus::Idle),
            Some(HerdrAgentStatus::Done),
            Some(HerdrAgentStatus::Unknown),
            Some(HerdrAgentStatus::Blocked),
            Some(HerdrAgentStatus::Working),
        ] {
            for enabled in [false, true] {
                if enabled && previous_status == Some(HerdrAgentStatus::Working) {
                    continue;
                }
                let owner = LocalAlertCoordinator::new();
                let effects = owner.transition(LocalAlertTransition {
                    host_id: "host".into(),
                    pane_id: "a".into(),
                    runtime: None,
                    status: Some(HerdrAgentStatus::Idle),
                    previous_status,
                    request: Some(request("host", "a", HerdrAgentStatus::Idle, true)),
                    enabled,
                    afk_mode,
                    foreground: false,
                });
                assert!(effects.is_empty());
            }
        }
    }
}

#[test]
fn concurrent_admissions_remain_bounded_and_each_notification_can_start() {
    let owner = Arc::new(LocalAlertCoordinator::new());
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let mut handles = Vec::new();
    // Spawn every barrier participant before joining any of them.
    for index in 0..8 {
        let owner = owner.clone();
        let barrier = barrier.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            let effects = owner.alert(done(&format!("pane-{index}")));
            let notification = schedule(&effects);
            begin(&owner, &notification);
            notification.id
        }));
    }
    let notifications: std::collections::HashSet<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(notifications.len(), 8);
    assert_eq!(owner.state.lock().waiting.len(), MAX_WAITING);
}
