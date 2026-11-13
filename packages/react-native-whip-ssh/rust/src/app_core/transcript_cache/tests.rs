use super::*;
use crate::{HerdrAgentSessionInfo, HerdrAgentSessionKind, HerdrAgentStatus, HerdrSessionSnapshot};

fn cache() -> TranscriptCache {
    TranscriptCache {
        coordinator: Arc::new(Coordinator::default()),
        bridge: 0,
    }
}

fn refresh_agents(snapshot: &mut HerdrSessionSnapshot) {
    let mut value = serde_json::to_value(&*snapshot).unwrap();
    value["agents"] = value["panes"].clone();
    *snapshot = crate::herdr_api::session_snapshot(&value).unwrap();
}

fn host(id: &str, count: usize) -> (Host, HerdrSessionSnapshot) {
    let runtime = crate::host_runtime::register_transcript_test_runtime(id);
    let mut snapshot = super::super::offline::decode(&super::super::offline::fixture().to_string())
        .unwrap()
        .snapshot
        .unwrap();
    let template = snapshot.panes[0].clone();
    snapshot.panes = (0..count)
        .map(|index| {
            let mut pane = template.clone();
            pane.pane_id = format!("pane-{index}");
            pane.terminal_id = format!("terminal-{index}");
            pane.agent_status = HerdrAgentStatus::Working;
            pane.agent_session = Some(HerdrAgentSessionInfo {
                source: "herdr:opencode".into(),
                agent: "opencode".into(),
                kind: HerdrAgentSessionKind::Id,
                value: format!("ses_{index}"),
            });
            pane
        })
        .collect();
    refresh_agents(&mut snapshot);
    snapshot.focused_pane_id = Some("pane-0".into());
    snapshot.tabs[0].pane_count = f64::from(u32::try_from(count).unwrap());
    snapshot.workspaces[0].pane_count = f64::from(u32::try_from(count).unwrap());
    runtime.install_transcript_test_snapshot(snapshot.clone());
    (
        Host {
            id: id.into(),
            runtime,
            attached: true,
        },
        snapshot,
    )
}

fn reconcile(
    cache: &TranscriptCache,
    owner: u64,
    hosts: &[Host],
    order: &[(&str, usize)],
    capacity: u32,
) -> TranscriptCacheSnapshot {
    cache
        .coordinator
        .reconcile_hosts(
            hosts.to_vec(),
            order
                .iter()
                .map(|(host, index)| ((*host).into(), format!("terminal-{index}")))
                .collect(),
            capacity,
            owner,
            cache.bridge,
        )
        .unwrap()
        .0
}

fn terminals(snapshot: &TranscriptCacheSnapshot) -> Vec<(&str, &str)> {
    snapshot
        .bindings
        .iter()
        .map(|binding| {
            (
                binding.host_session_id.as_str(),
                binding.terminal_id.as_str(),
            )
        })
        .collect()
}

fn ready(host: &Host, terminal: usize, text: Option<&str>, failed: bool) {
    host.runtime
        .transcript_manager()
        .set_cached_test_transcript(&format!("terminal-{terminal}"), text, failed);
}

#[test]
fn admission_uses_shared_priority_and_one_slot_per_conversation() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let (one, mut snapshot) = host("cache-priority-one", 4);
    let (two, _) = host("cache-priority-two", 2);
    snapshot.panes[1].agent_session = snapshot.panes[0].agent_session.clone();
    one.runtime.install_transcript_test_snapshot(snapshot);
    let result = reconcile(
        &cache,
        owner,
        &[one.clone(), two.clone()],
        &[
            (&two.id, 0),
            (&one.id, 0),
            (&one.id, 1),
            (&one.id, 2),
            (&one.id, 3),
        ],
        3,
    );
    assert_eq!(
        terminals(&result),
        vec![
            (one.id.as_str(), "terminal-0"),
            (one.id.as_str(), "terminal-1"),
            (one.id.as_str(), "terminal-2"),
            (two.id.as_str(), "terminal-0")
        ]
    );
    let next = reconcile(
        &cache,
        owner,
        &[one.clone(), two.clone()],
        &[(&one.id, 3), (&two.id, 1), (&one.id, 2)],
        3,
    );
    assert_eq!(
        terminals(&next),
        vec![
            (one.id.as_str(), "terminal-2"),
            (one.id.as_str(), "terminal-3"),
            (two.id.as_str(), "terminal-1")
        ]
    );
    assert!(
        one.runtime
            .current_agent_chat("terminal-0".into())
            .is_none()
    );
    assert!(
        one.runtime
            .current_agent_chat("terminal-1".into())
            .is_none()
    );
}

#[test]
fn foreground_and_independent_subscribers_survive_pressure_beyond_capacity() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let (host, _) = host("cache-protected", 6);
    let initial = reconcile(&cache, owner, std::slice::from_ref(&host), &[], 5);
    let foreground = cache.retain_foreground_terminal(host.id.clone(), "terminal-4".into());
    let pins = initial.bindings[..4]
        .iter()
        .map(|binding| cache.retain_subscription(binding.binding_token.clone()))
        .collect::<Vec<_>>();
    let second = cache.retain_subscription(initial.bindings[0].binding_token.clone());
    let pressure = [(&*host.id, 5), (&*host.id, 4)];
    assert_eq!(
        reconcile(&cache, owner, std::slice::from_ref(&host), &pressure, 3)
            .bindings
            .len(),
        5
    );
    cache.release(pins[0]);
    cache.release(pins[0]);
    assert_eq!(
        reconcile(&cache, owner, std::slice::from_ref(&host), &pressure, 3)
            .bindings
            .len(),
        5
    );
    cache.release(second);
    cache.release(foreground);
    for token in pins.into_iter().skip(1) {
        cache.release(token);
    }
    let trimmed = reconcile(&cache, owner, std::slice::from_ref(&host), &pressure, 3);
    assert_eq!(trimmed.bindings.len(), 3);
    assert!(
        trimmed
            .bindings
            .iter()
            .any(|binding| binding.terminal_id == "terminal-5")
    );
}

#[test]
fn identity_changes_invalidate_only_the_affected_binding_even_when_pinned() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let (host, mut snapshot) = host("cache-identity", 3);
    let initial = reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
    cache.retain_foreground_terminal(host.id.clone(), "terminal-0".into());
    snapshot.panes[0].pane_id = "replacement-pane".into();
    snapshot.panes[0].agent_session.as_mut().unwrap().value = "ses_replacement".into();
    refresh_agents(&mut snapshot);
    snapshot.focused_pane_id = Some("replacement-pane".into());
    host.runtime.install_transcript_test_snapshot(snapshot);
    let next = reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
    assert_ne!(
        next.bindings[0].binding_token,
        initial.bindings[0].binding_token
    );
    assert_eq!(next.bindings[1..], initial.bindings[1..]);
    let old = &initial.bindings[0];
    assert!(!host.runtime.agent_chat_binding_is_current(
        old.terminal_id.clone(),
        old.binding_token.clone(),
        0
    ));
    let removed = reconcile(&cache, owner, &[], &[], 3);
    assert!(removed.bindings.is_empty());
    assert!(
        host.runtime
            .current_agent_chat("terminal-1".into())
            .is_none()
    );
}

#[test]
fn recovery_retains_cached_content_and_cannot_speculatively_open_new_sessions() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let (host, _) = host("cache-recovery", 4);
    let initial = reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
    ready(&host, 0, Some("Keep committed history"), true);
    cache.retain_foreground_terminal(host.id.clone(), "terminal-0".into());
    host.runtime.begin_transcript_test_sync(2);
    let next = reconcile(
        &cache,
        owner,
        std::slice::from_ref(&host),
        &[(&host.id, 3)],
        4,
    );
    assert_eq!(next.bindings, initial.bindings);
    let state = host
        .runtime
        .current_agent_chat("terminal-0".into())
        .unwrap()
        .state;
    assert!(!state.messages.is_empty());
    assert!(
        host.runtime
            .current_agent_chat("terminal-3".into())
            .is_none()
    );
}

#[test]
fn failed_preloads_wait_for_generation_or_identity_changes_not_status_revisions() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let (host, mut snapshot) = host("cache-backoff", 4);
    reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
    ready(&host, 0, None, true);
    let failed = reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
    assert!(
        failed
            .bindings
            .iter()
            .all(|binding| binding.terminal_id != "terminal-0")
    );
    snapshot.panes[0].agent_status = HerdrAgentStatus::Blocked;
    host.runtime
        .install_transcript_test_snapshot(snapshot.clone());
    for _ in 0..4 {
        let unchanged = reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
        assert_eq!(unchanged.bindings, failed.bindings);
    }
    host.runtime.begin_transcript_test_sync(2);
    host.runtime.install_transcript_test_snapshot(snapshot);
    let retried = reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
    assert!(
        retried
            .bindings
            .iter()
            .any(|binding| binding.terminal_id == "terminal-0")
    );
}

#[test]
fn superseded_owners_cannot_evict_current_hosts_and_bridge_adoption_keeps_native_bindings() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let first = cache.claim_owner();
    let (host, _) = host("cache-owners", 3);
    let initial = reconcile(&cache, first, std::slice::from_ref(&host), &[], 3);
    let second = cache.claim_owner();
    assert!(
        cache
            .coordinator
            .reconcile_hosts(vec![], vec![], 3, first, cache.bridge)
            .is_none()
    );
    assert_eq!(
        reconcile(&cache, second, std::slice::from_ref(&host), &[], 3),
        initial
    );
    cache.release(second);
    assert!(cache.owner_is_current(first));
    assert_eq!(
        reconcile(&cache, first, std::slice::from_ref(&host), &[], 3),
        initial
    );
    let adopted = TranscriptCache {
        coordinator: cache.coordinator.clone(),
        bridge: 999,
    };
    let newest = adopted.claim_owner();
    drop(cache);
    assert_eq!(reconcile(&adopted, newest, &[host], &[], 3), initial);
}

#[test]
fn shrinking_a_shared_session_evicts_all_unprotected_bindings_together() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let (host, mut snapshot) = host("cache-shared-eviction", 5);
    snapshot.panes[1].agent_session = snapshot.panes[0].agent_session.clone();
    host.runtime.install_transcript_test_snapshot(snapshot);
    reconcile(&cache, owner, std::slice::from_ref(&host), &[], 5);
    for terminal in 0..5 {
        ready(&host, terminal, None, false);
    }
    let next = reconcile(
        &cache,
        owner,
        std::slice::from_ref(&host),
        &[(&host.id, 4), (&host.id, 3), (&host.id, 2)],
        3,
    );
    assert_eq!(
        terminals(&next),
        vec![
            (host.id.as_str(), "terminal-2"),
            (host.id.as_str(), "terminal-3"),
            (host.id.as_str(), "terminal-4")
        ]
    );
}

#[test]
fn runtime_replacement_releases_the_old_incarnation_without_touching_other_hosts() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let (old, _) = host("cache-runtime-replacement", 1);
    let (other, _) = host("cache-runtime-survivor", 1);
    let first = reconcile(&cache, owner, &[old.clone(), other.clone()], &[], 3);
    let (replacement, _) = host(&old.id, 1);
    let next = reconcile(&cache, owner, &[replacement, other.clone()], &[], 3);
    assert_ne!(
        next.bindings[0].binding_token,
        first.bindings[0].binding_token
    );
    assert_eq!(next.bindings[1], first.bindings[1]);
    assert!(
        old.runtime
            .current_agent_chat("terminal-0".into())
            .is_none()
    );
    assert!(
        other
            .runtime
            .current_agent_chat("terminal-0".into())
            .is_some()
    );
}

#[test]
fn native_app_core_ranking_is_unfiltered_and_shared_by_all_hosts() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let core = AppCore::new();
    let (one, mut first) = host("cache-herd-one", 2);
    let (two, mut second) = host("cache-herd-two", 2);
    first.panes[0].agent_status = HerdrAgentStatus::Done;
    first.panes[1].agent_status = HerdrAgentStatus::Done;
    second.panes[0].agent_status = HerdrAgentStatus::Blocked;
    second.panes[1].agent_status = HerdrAgentStatus::Working;
    refresh_agents(&mut first);
    refresh_agents(&mut second);
    one.runtime.install_transcript_test_snapshot(first);
    two.runtime.install_transcript_test_snapshot(second);
    for host in [&one, &two] {
        core.open_session(host.id.clone(), host.id.clone(), true);
        core.attach_runtime(host.id.clone(), host.runtime.clone());
        for terminal in 0..2 {
            host.runtime
                .bind_transcript_candidate(format!("terminal-{terminal}"))
                .unwrap();
            ready(host, terminal, None, false);
        }
    }
    core.select_host(one.id.clone());
    let expected = core
        .herd_view(vec![], None, None)
        .agents
        .into_iter()
        .take(3)
        .map(|agent| (agent.host_id, agent.agent.terminal_id))
        .collect::<HashSet<_>>();
    let result = cache.reconcile(core, owner, 3).unwrap();
    let actual = result
        .bindings
        .into_iter()
        .map(|binding| (binding.host_session_id, binding.terminal_id))
        .collect::<HashSet<_>>();
    assert_eq!(actual, expected);
    assert!(actual.iter().any(|(host, _)| host == &one.id));
    assert!(actual.iter().any(|(host, _)| host == &two.id));
}

#[test]
fn residency_inspection_and_bridge_payload_do_not_grow_with_transcript_bodies() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let (host, _) = host("cache-large-history", 3);
    reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
    let mut measurements = Vec::new();
    for size in [32, 4 * 1024 * 1024] {
        let text = "x".repeat(size);
        for terminal in 0..3 {
            ready(&host, terminal, Some(&text), false);
        }
        let snapshot = reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
        let mut wire = Vec::new();
        <TranscriptCacheSnapshot as uniffi::FfiConverter<crate::UniFfiTag>>::write(
            snapshot.clone(),
            &mut wire,
        );
        let (_, elapsed, count, bytes) = crate::test_allocations::measured(|| {
            for _ in 0..100 {
                assert_eq!(
                    reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3),
                    snapshot
                );
            }
        });
        measurements.push((count, bytes, wire.len()));
        eprintln!(
            "TRANSCRIPT_RESIDENCY_BENCH body_bytes={} reconcile_ns={} allocations={} allocated_bytes={} bridge_bytes={}",
            size * 3,
            elapsed / 100,
            count / 100,
            bytes / 100,
            wire.len()
        );
    }
    assert_eq!(measurements[0], measurements[1]);
}

#[test]
fn rejected_candidates_do_not_evict_valid_cached_history() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let (host, mut snapshot) = host("cache-invalid-candidate", 4);
    let initial = reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
    for terminal in 0..3 {
        ready(&host, terminal, Some("Committed history"), false);
    }
    snapshot.panes[3].agent_session.as_mut().unwrap().value = "invalid/session/path".into();
    host.runtime.install_transcript_test_snapshot(snapshot);
    for _ in 0..3 {
        let result = reconcile(
            &cache,
            owner,
            std::slice::from_ref(&host),
            &[(&host.id, 3)],
            3,
        );
        assert_eq!(result.bindings, initial.bindings);
    }
    assert!(
        !host
            .runtime
            .current_agent_chat("terminal-0".into())
            .unwrap()
            .state
            .messages
            .is_empty()
    );
}

#[test]
fn fallback_priority_retains_the_last_explicitly_opened_conversation() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let (host, _) = host("cache-lru", 4);
    reconcile(&cache, owner, std::slice::from_ref(&host), &[], 4);
    for terminal in 0..4 {
        ready(&host, terminal, None, false);
    }
    cache.coordinator.requested(&host.runtime, "terminal-3");
    let result = reconcile(&cache, owner, std::slice::from_ref(&host), &[], 3);
    assert!(
        result
            .bindings
            .iter()
            .any(|binding| binding.terminal_id == "terminal-3")
    );
    assert!(
        result
            .bindings
            .iter()
            .all(|binding| binding.terminal_id != "terminal-2")
    );
}

#[test]
fn ui_runtime_detachment_keeps_residents_until_the_host_session_is_removed() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let core = AppCore::new();
    let (host, _) = host("cache-ui-detachment", 3);
    core.open_session(host.id.clone(), host.id.clone(), true);
    core.attach_runtime(host.id.clone(), host.runtime.clone());
    for terminal in 0..3 {
        host.runtime
            .bind_transcript_candidate(format!("terminal-{terminal}"))
            .unwrap();
        ready(
            &host,
            terminal,
            Some("Survives bridge reinitialization"),
            false,
        );
    }
    let initial = cache.reconcile(core.clone(), owner, 3).unwrap();
    core.detach_runtime(host.id.clone());
    assert_eq!(cache.reconcile(core.clone(), owner, 3).unwrap(), initial);
    core.attach_runtime(host.id.clone(), host.runtime.clone());
    assert_eq!(cache.reconcile(core.clone(), owner, 3).unwrap(), initial);
    core.close_session(host.id.clone());
    assert!(cache.reconcile(core, owner, 3).unwrap().bindings.is_empty());
    assert!(
        host.runtime
            .current_agent_chat("terminal-0".into())
            .is_none()
    );
}

#[test]
fn a_new_bridge_adopts_residents_before_its_app_core_finishes_restoring() {
    let _guard = crate::host_runtime::terminal_delivery_test_guard();
    let cache = cache();
    let owner = cache.claim_owner();
    let core = AppCore::new();
    let (host, _) = host("cache-bridge-restore", 3);
    core.open_session(host.id.clone(), host.id.clone(), true);
    core.attach_runtime(host.id.clone(), host.runtime.clone());
    for terminal in 0..3 {
        host.runtime
            .bind_transcript_candidate(format!("terminal-{terminal}"))
            .unwrap();
        ready(&host, terminal, Some("Committed conversation"), false);
    }
    let initial = cache.reconcile(core, owner, 3).unwrap();
    let replacement = AppCore::new();
    let new_owner = cache.claim_owner();
    for _ in 0..3 {
        assert_eq!(
            cache.reconcile(replacement.clone(), new_owner, 3).unwrap(),
            initial
        );
    }
    replacement.open_session(host.id.clone(), host.id.clone(), true);
    replacement.attach_runtime(host.id.clone(), host.runtime.clone());
    assert_eq!(
        cache.reconcile(replacement.clone(), new_owner, 3).unwrap(),
        initial
    );
    replacement.close_session(host.id);
    assert!(
        cache
            .reconcile(replacement, new_owner, 3)
            .unwrap()
            .bindings
            .is_empty()
    );
}
