//! Fake-platform tests hold acknowledgements at the real async boundaries.
#![allow(clippy::unwrap_used, reason = "Assertions stop immediately on failure")]

use super::*;
use std::collections::HashSet;

fn request(host: &str, pane: &str, tab: &str, speak: bool) -> LocalAlertRequest {
    LocalAlertRequest {
        host_id: host.into(),
        pane_id: pane.into(),
        tab_id: tab.into(),
        runtime: None,
        title: "Agent needs you".into(),
        body: "Blocked".into(),
        announcement: speak.then(|| "Task needs you".into()),
        language: "en-US".into(),
        delivery: LocalAlertDelivery::Persistent,
        persistent_timeout_ms: 45_000,
        android: true,
    }
}

fn one(mut effects: Vec<LocalAlertEffect>) -> LocalAlertEffect {
    assert_eq!(effects.len(), 1, "{effects:?}");
    effects.pop().unwrap()
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

fn scopes() -> Vec<LocalAlertScope> {
    vec![
        LocalAlertScope::All,
        LocalAlertScope::Host {
            host_id: "h".into(),
        },
        LocalAlertScope::Tab {
            host_id: "h".into(),
            tab_id: "t".into(),
        },
        LocalAlertScope::Pane {
            host_id: "h".into(),
            pane_id: "p".into(),
        },
    ]
}

#[derive(Default)]
struct Platform {
    notifications: HashSet<String>,
    persistent: Option<String>,
    speech: HashSet<String>,
}

impl Platform {
    fn drain(&mut self, owner: &LocalAlertCoordinator, effects: Vec<LocalAlertEffect>) {
        for effect in effects {
            let outcome = match owner.begin_effect(effect.id.clone()) {
                LocalAlertEffectAdmission::Skip => LocalAlertOutcome::Skipped,
                LocalAlertEffectAdmission::Duplicate => continue,
                LocalAlertEffectAdmission::Run => match &effect.action {
                    LocalAlertAction::Schedule { .. } => {
                        self.notifications.insert(effect.id.clone());
                        LocalAlertOutcome::Scheduled {
                            notification_id: effect.id.clone(),
                        }
                    }
                    LocalAlertAction::Speak { token, .. } => {
                        self.speech.insert(token.clone());
                        LocalAlertOutcome::SpeechEnded {
                            reason: LocalAlertSpeechEnd::Completed,
                        }
                    }
                    LocalAlertAction::StopSpeech { token } => {
                        self.speech.remove(token);
                        LocalAlertOutcome::Done
                    }
                    LocalAlertAction::DismissNotification { notification_id } => {
                        self.notifications.remove(notification_id);
                        LocalAlertOutcome::Done
                    }
                    LocalAlertAction::ArmPersistent {
                        notification_id, ..
                    } => {
                        assert!(self.notifications.contains(notification_id));
                        self.persistent = Some(notification_id.clone());
                        LocalAlertOutcome::Done
                    }
                    LocalAlertAction::DismissPersistent { notification_id } => {
                        if notification_id.is_none() || self.persistent == *notification_id {
                            self.persistent = None;
                        }
                        LocalAlertOutcome::Done
                    }
                },
            };
            self.drain(owner, complete(owner, &effect, outcome));
        }
    }
}

#[test]
fn every_dismissal_scope_fences_a_pending_schedule_and_cleans_up_its_late_id() {
    for scope in scopes() {
        let owner = LocalAlertCoordinator::new();
        let mut platform = Platform::default();
        let schedule = one(owner.alert(request("h", "p", "t", false)));
        begin(&owner, &schedule);
        platform.drain(&owner, owner.dismiss(scope));
        platform.notifications.insert("late".into());
        let cleanup = one(scheduled(&owner, &schedule, "late"));
        assert!(
            matches!(&cleanup.action, LocalAlertAction::DismissNotification { notification_id } if notification_id == "late")
        );
        platform.drain(&owner, vec![cleanup]);
        assert!(platform.notifications.is_empty());
        assert!(platform.persistent.is_none());
    }
}

#[test]
fn dismissal_before_effect_admission_never_calls_the_platform() {
    for speak in [false, true] {
        for scope in scopes() {
            let owner = LocalAlertCoordinator::new();
            let pending = one(owner.alert(request("h", "p", "t", speak)));
            Platform::default().drain(&owner, owner.dismiss(scope));
            assert_eq!(
                owner.begin_effect(pending.id.clone()),
                LocalAlertEffectAdmission::Skip
            );
            assert!(complete(&owner, &pending, LocalAlertOutcome::Skipped).is_empty());
        }
    }
}

#[test]
fn same_target_alerts_and_other_hosts_tabs_and_panes_have_independent_ownership() {
    for scope in [
        LocalAlertScope::Pane {
            host_id: "h".into(),
            pane_id: "p".into(),
        },
        LocalAlertScope::Tab {
            host_id: "h".into(),
            tab_id: "t".into(),
        },
    ] {
        let owner = LocalAlertCoordinator::new();
        let mut platform = Platform::default();
        for (host, pane, tab) in [
            ("h", "p", "t"),
            ("h", "p", "t"),
            ("other", "p", "t"),
            ("h", "q", "t"),
            ("h", "z", "u"),
        ] {
            platform.drain(&owner, owner.alert(request(host, pane, tab, false)));
        }
        assert_eq!(platform.notifications.len(), 5);
        let expected = if matches!(scope, LocalAlertScope::Pane { .. }) {
            3
        } else {
            2
        };
        platform.drain(&owner, owner.dismiss(scope));
        assert_eq!(platform.notifications.len(), expected);
        platform.drain(&owner, owner.dismiss(LocalAlertScope::All));
        assert!(platform.notifications.is_empty());
        assert!(platform.persistent.is_none());
    }
}

#[test]
fn every_dismissal_scope_stops_only_its_speech_and_rejects_the_late_completion() {
    for scope in scopes() {
        let owner = LocalAlertCoordinator::new();
        let speech = one(owner.alert(request("h", "p", "t", true)));
        begin(&owner, &speech);
        let token = match &speech.action {
            LocalAlertAction::Speak { token, .. } => token.clone(),
            _ => panic!(),
        };
        let effects = owner.dismiss(scope);
        assert!(effects.iter().any(|e| matches!(&e.action, LocalAlertAction::StopSpeech { token: stopped } if *stopped == token)));
        Platform::default().drain(&owner, effects);
        assert!(
            complete(
                &owner,
                &speech,
                LocalAlertOutcome::SpeechEnded {
                    reason: LocalAlertSpeechEnd::Completed
                }
            )
            .is_empty()
        );
    }
}

#[test]
fn replacing_speech_waits_for_stop_and_old_results_cannot_cancel_the_new_owner() {
    for reason in [LocalAlertSpeechEnd::Replaced, LocalAlertSpeechEnd::Shake] {
        let owner = LocalAlertCoordinator::new();
        let old = one(owner.alert(request("h", "p", "t", true)));
        begin(&owner, &old);
        let stop = one(owner.alert(request("other", "p", "t", true)));
        assert!(matches!(&stop.action, LocalAlertAction::StopSpeech { .. }));
        begin(&owner, &stop);
        let new = one(complete(&owner, &stop, LocalAlertOutcome::Done));
        begin(&owner, &new);
        let old_result = complete(&owner, &old, LocalAlertOutcome::SpeechEnded { reason });
        if reason == LocalAlertSpeechEnd::Shake {
            assert!(old_result.is_empty());
        } else {
            assert!(matches!(
                one(old_result).action,
                LocalAlertAction::Schedule { .. }
            ));
        }
        let dismiss = owner.dismiss(LocalAlertScope::Pane {
            host_id: "other".into(),
            pane_id: "p".into(),
        });
        let LocalAlertAction::Speak {
            token: new_token, ..
        } = new.action
        else {
            panic!()
        };
        assert!(dismiss.iter().any(
            |e| matches!(&e.action, LocalAlertAction::StopSpeech { token } if *token == new_token)
        ));
    }
}

#[test]
fn three_overlapping_announcements_do_not_orphan_a_waiting_alert() {
    let owner = LocalAlertCoordinator::new();
    let first = one(owner.alert(request("h", "p", "t", true)));
    begin(&owner, &first);
    let stop_first = one(owner.alert(request("h", "q", "t", true)));
    let stop_second = one(owner.alert(request("h", "r", "t", true)));
    begin(&owner, &stop_second);
    let third = one(complete(&owner, &stop_second, LocalAlertOutcome::Done));
    begin(&owner, &third);
    begin(&owner, &stop_first);
    assert!(
        matches!(one(complete(&owner, &stop_first, LocalAlertOutcome::Done)).action,
        LocalAlertAction::Schedule { request } if request.pane_id == "q")
    );
    assert!(
        matches!(one(complete(&owner, &first, LocalAlertOutcome::SpeechEnded { reason: LocalAlertSpeechEnd::Replaced })).action,
        LocalAlertAction::Schedule { request } if request.pane_id == "p")
    );
    assert!(
        matches!(one(complete(&owner, &third, LocalAlertOutcome::SpeechEnded { reason: LocalAlertSpeechEnd::Completed })).action,
        LocalAlertAction::Schedule { request } if request.pane_id == "r")
    );
}

#[test]
fn shake_cancels_active_alerts_and_all_pending_schedules() {
    let owner = LocalAlertCoordinator::new();
    let mut platform = Platform::default();
    platform.drain(&owner, owner.alert(request("other", "p", "t", false)));
    let schedule = one(owner.alert(request("h", "q", "t", false)));
    begin(&owner, &schedule);
    let speech = one(owner.alert(request("h", "p", "t", true)));
    begin(&owner, &speech);
    platform.drain(
        &owner,
        complete(
            &owner,
            &speech,
            LocalAlertOutcome::SpeechEnded {
                reason: LocalAlertSpeechEnd::Shake,
            },
        ),
    );
    assert!(platform.notifications.is_empty());
    assert!(platform.persistent.is_none());
    let cleanup = one(scheduled(&owner, &schedule, "late"));
    assert!(matches!(
        cleanup.action,
        LocalAlertAction::DismissNotification { .. }
    ));
}

#[test]
fn a_late_arm_is_cleaned_up_and_never_disarms_a_newer_alert() {
    let owner = LocalAlertCoordinator::new();
    let old = one(owner.alert(request("h", "p", "t", false)));
    begin(&owner, &old);
    let arm_old = one(scheduled(&owner, &old, "old"));
    begin(&owner, &arm_old);
    let dismiss = owner.dismiss(LocalAlertScope::Pane {
        host_id: "h".into(),
        pane_id: "p".into(),
    });
    assert!(
        dismiss
            .iter()
            .all(|e| !matches!(e.action, LocalAlertAction::DismissPersistent { .. }))
    );
    let new = one(owner.alert(request("other", "p", "t", false)));
    begin(&owner, &new);
    assert!(scheduled(&owner, &new, "new").is_empty());
    let arm_new = one(complete(&owner, &arm_old, LocalAlertOutcome::Done));
    assert!(
        matches!(&arm_new.action, LocalAlertAction::ArmPersistent { notification_id, timeout_ms: 45_000 } if notification_id == "new")
    );
    begin(&owner, &arm_new);
    assert!(complete(&owner, &arm_new, LocalAlertOutcome::Done).is_empty());
    assert!(complete(&owner, &arm_old, LocalAlertOutcome::Done).is_empty());
    assert!(
        owner
            .dismiss(LocalAlertScope::Pane {
                host_id: "h".into(),
                pane_id: "p".into()
            })
            .is_empty()
    );
}

#[test]
fn dismissal_during_an_arm_waits_for_its_ack_then_targets_that_notification() {
    let owner = LocalAlertCoordinator::new();
    let schedule = one(owner.alert(request("h", "p", "t", false)));
    begin(&owner, &schedule);
    let arm = one(scheduled(&owner, &schedule, "late-arm"));
    begin(&owner, &arm);
    owner.dismiss(LocalAlertScope::All);
    let cleanup = one(complete(&owner, &arm, LocalAlertOutcome::Done));
    assert!(
        matches!(cleanup.action, LocalAlertAction::DismissPersistent { notification_id: Some(id) } if id == "late-arm")
    );
}

#[test]
fn a_skipped_arm_preserves_a_newer_desired_owner() {
    let owner = LocalAlertCoordinator::new();
    let old = one(owner.alert(request("h", "p", "t", false)));
    begin(&owner, &old);
    let arm = one(scheduled(&owner, &old, "old"));
    let new = one(owner.alert(request("h", "q", "t", false)));
    begin(&owner, &new);
    assert!(scheduled(&owner, &new, "new").is_empty());
    assert_eq!(
        owner.begin_effect(arm.id.clone()),
        LocalAlertEffectAdmission::Skip
    );
    let replacement = one(complete(&owner, &arm, LocalAlertOutcome::Skipped));
    assert!(
        matches!(replacement.action, LocalAlertAction::ArmPersistent { notification_id, .. } if notification_id == "new")
    );
}

#[test]
fn failures_release_pending_state_and_speech_errors_still_deliver() {
    let owner = LocalAlertCoordinator::new();
    let failure = || LocalAlertOutcome::Failed {
        message: "backend unavailable".into(),
    };
    let speech = one(owner.alert(request("h", "p", "t", true)));
    begin(&owner, &speech);
    let schedule = one(complete(&owner, &speech, failure()));
    begin(&owner, &schedule);
    assert!(complete(&owner, &schedule, failure()).is_empty());
    assert!(
        owner
            .dismiss(LocalAlertScope::Pane {
                host_id: "h".into(),
                pane_id: "p".into()
            })
            .is_empty()
    );
    let schedule = one(owner.alert(request("h", "p", "t", false)));
    begin(&owner, &schedule);
    let arm = one(scheduled(&owner, &schedule, "failed-arm"));
    begin(&owner, &arm);
    assert!(complete(&owner, &arm, failure()).is_empty());
    let cleanup = one(owner
        .dismiss(LocalAlertScope::All)
        .into_iter()
        .filter(|e| matches!(e.action, LocalAlertAction::DismissPersistent { .. }))
        .collect());
    begin(&owner, &cleanup);
    assert!(complete(&owner, &cleanup, failure()).is_empty());
    // The backend can recover for the next alert; there is no retry spin.
    Platform::default().drain(&owner, owner.alert(request("h", "p", "t", false)));
}

#[test]
fn busy_interrupted_and_stopped_speech_preserve_notification_delivery() {
    for reason in [
        LocalAlertSpeechEnd::Busy,
        LocalAlertSpeechEnd::Interrupted,
        LocalAlertSpeechEnd::Stopped,
    ] {
        let owner = LocalAlertCoordinator::new();
        let speech = one(owner.alert(request("h", "p", "t", true)));
        begin(&owner, &speech);
        assert!(matches!(
            one(complete(
                &owner,
                &speech,
                LocalAlertOutcome::SpeechEnded { reason }
            ))
            .action,
            LocalAlertAction::Schedule { .. }
        ));
    }
}

#[test]
fn runtime_replacement_fences_old_callbacks_and_does_not_touch_other_hosts() {
    for speak in [false, true] {
        let owner = LocalAlertCoordinator::new();
        let old_runtime = LocalAlertRuntime {
            runtime_id: "runtime".into(),
            incarnation: 1,
        };
        let new_runtime = LocalAlertRuntime {
            runtime_id: "runtime".into(),
            incarnation: 2,
        };
        owner.set_runtime("h".into(), Some(old_runtime.clone()));
        let mut old_request = request("h", "p", "t", speak);
        old_request.runtime = Some(old_runtime);
        let pending = one(owner.alert(old_request.clone()));
        begin(&owner, &pending);
        let mut platform = Platform::default();
        platform.drain(&owner, owner.alert(request("other", "p", "t", false)));
        platform.drain(
            &owner,
            owner.set_runtime("h".into(), Some(new_runtime.clone())),
        );
        assert_eq!(platform.notifications.len(), 1);
        assert!(owner.alert(old_request.clone()).is_empty());
        let result = if speak {
            LocalAlertOutcome::SpeechEnded {
                reason: LocalAlertSpeechEnd::Completed,
            }
        } else {
            LocalAlertOutcome::Scheduled {
                notification_id: "late".into(),
            }
        };
        let late = complete(&owner, &pending, result);
        assert_eq!(late.len(), usize::from(!speak));
        let mut new_request = old_request;
        new_request.runtime = Some(new_runtime);
        platform.drain(&owner, owner.alert(new_request.clone()));
        assert_eq!(platform.notifications.len(), 2);
        platform.drain(&owner, owner.set_runtime("h".into(), None));
        assert_eq!(platform.notifications.len(), 1);
        assert!(owner.alert(new_request).is_empty());
    }
}

#[test]
fn transition_admission_preserves_foreground_background_modes_and_resolutions() {
    for foreground in [false, true] {
        for delivery in [LocalAlertDelivery::Persistent, LocalAlertDelivery::Regular] {
            let owner = LocalAlertCoordinator::new();
            let mut request = request("h", "p", "t", false);
            request.delivery = delivery;
            let transition = |status, enabled, request| LocalAlertTransition {
                host_id: "h".into(),
                pane_id: "p".into(),
                runtime: None,
                status,
                enabled,
                foreground,
                request,
            };
            assert!(
                owner
                    .transition(transition(
                        Some(HerdrAgentStatus::Blocked),
                        false,
                        Some(request.clone())
                    ))
                    .is_empty()
            );
            assert!(
                owner
                    .transition(transition(Some(HerdrAgentStatus::Done), true, None))
                    .is_empty()
            );
            let effect = one(owner.transition(transition(
                Some(HerdrAgentStatus::Blocked),
                true,
                Some(request.clone()),
            )));
            let expected = if foreground && delivery == LocalAlertDelivery::Persistent {
                LocalAlertDelivery::Brief
            } else {
                delivery
            };
            assert!(
                matches!(&effect.action, LocalAlertAction::Schedule { request } if request.delivery == expected)
            );
            begin(&owner, &effect);
            let mut platform = Platform::default();
            platform.notifications.insert("notification".into());
            platform.drain(&owner, scheduled(&owner, &effect, "notification"));
            assert_eq!(
                platform.persistent.is_some(),
                expected == LocalAlertDelivery::Persistent
            );
            platform.drain(
                &owner,
                owner.transition(transition(
                    Some(HerdrAgentStatus::Working),
                    false,
                    Some(request),
                )),
            );
            assert!(platform.notifications.is_empty());
            assert!(platform.persistent.is_none());
        }
    }
}

#[test]
fn ios_never_arms_android_persistent_feedback() {
    let owner = LocalAlertCoordinator::new();
    let mut request = request("h", "p", "t", false);
    request.android = false;
    let effect = one(owner.alert(request));
    begin(&owner, &effect);
    assert!(scheduled(&owner, &effect, "ios").is_empty());
}

#[test]
fn duplicate_or_mistyped_callbacks_cannot_steal_an_inflight_operation() {
    let owner = LocalAlertCoordinator::new();
    let effect = one(owner.alert(request("h", "p", "t", false)));
    begin(&owner, &effect);
    assert_eq!(
        owner.begin_effect(effect.id.clone()),
        LocalAlertEffectAdmission::Duplicate
    );
    assert!(matches!(
        owner.complete_effect(effect.id.clone(), LocalAlertOutcome::Done),
        Err(LocalAlertError::InvalidCompletion)
    ));
    let arm = one(scheduled(&owner, &effect, "notification"));
    assert!(scheduled(&owner, &effect, "duplicate").is_empty());
    begin(&owner, &arm);
}

#[test]
fn stale_runtime_transitions_cannot_dismiss_the_replacement_runtimes_alert() {
    let owner = LocalAlertCoordinator::new();
    let old = LocalAlertRuntime {
        runtime_id: "runtime".into(),
        incarnation: 1,
    };
    let current = LocalAlertRuntime {
        incarnation: 2,
        ..old.clone()
    };
    owner.set_runtime("h".into(), Some(current.clone()));
    let mut request = request("h", "p", "t", false);
    request.runtime = Some(current);
    let mut platform = Platform::default();
    platform.drain(&owner, owner.alert(request));
    let stale = LocalAlertTransition {
        host_id: "h".into(),
        pane_id: "p".into(),
        runtime: Some(old),
        status: Some(HerdrAgentStatus::Working),
        request: None,
        enabled: true,
        foreground: true,
    };
    assert!(owner.transition(stale).is_empty());
    assert_eq!(platform.notifications.len(), 1);
    assert!(platform.persistent.is_some());
}

#[test]
fn missing_idle_unknown_and_working_transitions_dismiss_even_when_alerts_are_disabled() {
    for status in [
        None,
        Some(HerdrAgentStatus::Idle),
        Some(HerdrAgentStatus::Working),
        Some(HerdrAgentStatus::Unknown),
    ] {
        let owner = LocalAlertCoordinator::new();
        let mut platform = Platform::default();
        platform.drain(&owner, owner.alert(request("h", "p", "t", false)));
        platform.drain(
            &owner,
            owner.transition(LocalAlertTransition {
                host_id: "h".into(),
                pane_id: "p".into(),
                runtime: None,
                status,
                request: None,
                enabled: false,
                foreground: false,
            }),
        );
        assert!(platform.notifications.is_empty());
        assert!(platform.persistent.is_none());
    }
}
