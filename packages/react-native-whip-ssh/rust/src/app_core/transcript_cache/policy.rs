//! Admission, generation validation and eviction over native session metadata.
use std::collections::HashSet;

use super::{
    Coordinator, DEFAULT_CAPACITY, Failure, Host, Identity, MIN_CAPACITY, Pin, State,
    TranscriptCacheBinding, TranscriptCacheSnapshot,
};
use crate::agent_sessions::{AgentBindingIdentity, AgentSessionManager};
use crate::host_runtime::authoritative_agent_chat_identity;
use crate::host_state::{HostFreshness, HostSyncStatus};

type Resident = (Host, AgentBindingIdentity, bool);
type Reconciliation = (TranscriptCacheSnapshot, Vec<(AgentSessionManager, String)>);

#[derive(Clone)]
struct Candidate {
    host: Host,
    terminal: String,
    identity: Identity,
    failure: Failure,
    preload: bool,
}

impl Coordinator {
    pub(super) fn reconcile_hosts(
        &self,
        hosts: Vec<Host>,
        order: Vec<(String, String)>,
        capacity: u32,
        owner: u64,
        bridge: u64,
    ) -> Option<Reconciliation> {
        let mut state = self.state.lock();
        if state.owners.last() != Some(&(owner, bridge)) {
            return None;
        }
        state.capacity = if capacity < MIN_CAPACITY {
            DEFAULT_CAPACITY
        } else {
            capacity
        };
        for old in &state.hosts {
            if hosts.iter().any(|host| {
                host.id == old.id
                    && host.runtime.runtime_incarnation() == old.runtime.runtime_incarnation()
            }) {
                continue;
            }
            for (binding, _) in old.runtime.transcript_manager().cache_bindings() {
                let _ = old
                    .runtime
                    .transcript_manager()
                    .detach_terminal(&binding.terminal_id);
            }
        }
        state.hosts.clone_from(&hosts);
        let (mut candidates, residents) = collect(&state, &hosts);
        let selected = state.select(&mut candidates, &residents, &order);
        let mut bindings = Vec::new();
        let mut starts = Vec::new();
        for host in &hosts {
            let manager = host.runtime.transcript_manager();
            let projection = host.runtime.host_state();
            let fresh = projection.sync_status == HostSyncStatus::Synced
                && projection.freshness == HostFreshness::Fresh;
            for (binding, _) in manager.cache_bindings() {
                if host.attached
                    && fresh
                    && !state.start_errors.contains(&binding.binding_token)
                    && manager.binding_needs_start(&binding.binding_token)
                    && state.starting.insert(binding.binding_token.clone())
                {
                    starts.push((manager.clone(), binding.binding_token.clone()));
                }
                bindings.push(TranscriptCacheBinding {
                    host_session_id: host.id.clone(),
                    terminal_id: binding.terminal_id.into(),
                    binding_token: binding.binding_token,
                    runtime_incarnation: binding.runtime_incarnation,
                });
            }
        }
        bindings.sort_by(|left, right| {
            (&left.host_session_id, &left.terminal_id)
                .cmp(&(&right.host_session_id, &right.terminal_id))
        });
        if state.bindings != bindings {
            state.bindings = bindings;
            state.revision += 1;
        }
        let tokens = state
            .bindings
            .iter()
            .map(|binding| binding.binding_token.clone())
            .collect::<HashSet<_>>();
        state.start_errors.retain(|token| tokens.contains(token));
        state.pins.retain(|_, (_, pin)| match pin {
            Pin::Subscription(token) => tokens.contains(token),
            Pin::Foreground(_, _) => true,
        });
        let live = selected;
        state.used.retain(|identity, _| live.contains(identity));
        let snapshot = state.snapshot();
        drop(state);
        Some((snapshot, starts))
    }
}

fn collect(state: &State, hosts: &[Host]) -> (Vec<Candidate>, Vec<Resident>) {
    let mut candidates = Vec::new();
    let mut residents = Vec::new();
    for host in hosts {
        let manager = host.runtime.transcript_manager();
        let projection = host.runtime.host_state();
        let fresh = projection.sync_status == HostSyncStatus::Synced
            && projection.freshness == HostFreshness::Fresh;
        let bindings = manager.cache_bindings();
        if let Some(snapshot) = &projection.snapshot {
            for pane in &snapshot.panes {
                let Some(identity) = authoritative_agent_chat_identity(pane) else {
                    continue;
                };
                if identity.session_id.as_str().is_empty() {
                    continue;
                }
                let key = manager.cache_identity(&identity);
                candidates.push(Candidate {
                    host: host.clone(),
                    terminal: pane.terminal_id.clone(),
                    identity: (host.runtime.runtime_incarnation(), key.to_string()),
                    failure: Failure {
                        incarnation: host.runtime.runtime_incarnation(),
                        generation: projection.connection_generation,
                        terminal: pane.terminal_id.clone(),
                        pane: pane.pane_id.clone(),
                        transcript_key: key.to_string(),
                    },
                    preload: host.attached
                        && fresh
                        && matches!(
                            pane.agent_status,
                            crate::HerdrAgentStatus::Working
                                | crate::HerdrAgentStatus::Blocked
                                | crate::HerdrAgentStatus::Done
                        ),
                });
            }
        }
        for (binding, failed) in bindings {
            if let Some(snapshot) = &projection.snapshot {
                let valid = snapshot
                    .panes
                    .iter()
                    .find(|pane| pane.terminal_id == binding.terminal_id.as_str())
                    .and_then(authoritative_agent_chat_identity)
                    .is_some_and(|identity| {
                        identity.pane_id == binding.pane_id
                            && identity.agent == binding.agent
                            && identity.session_id == binding.session_id
                    });
                if !valid {
                    let _ = manager.detach_terminal(&binding.terminal_id);
                    continue;
                }
            }
            let failed = failed || state.start_errors.contains(&binding.binding_token);
            residents.push((host.clone(), binding, failed));
        }
    }
    (candidates, residents)
}

impl State {
    fn select(
        &mut self,
        candidates: &mut [Candidate],
        residents: &[Resident],
        order: &[(String, String)],
    ) -> HashSet<Identity> {
        // Failure eligibility depends on session identity and connection generation,
        // never arbitrary host revisions such as focus or status events.
        self.failures.retain(|failure| {
            candidates
                .iter()
                .any(|candidate| &candidate.failure == failure)
        });
        candidates.sort_by_key(|candidate| {
            (
                order
                    .iter()
                    .position(|(host, terminal)| {
                        *host == candidate.host.id && *terminal == candidate.terminal
                    })
                    .unwrap_or(usize::MAX),
                std::cmp::Reverse(self.used.get(&candidate.identity).copied().unwrap_or(0)),
            )
        });
        for (host, binding, failed) in residents {
            if *failed
                && !self.pinned(&host.id, binding)
                && let Some(candidate) = candidates.iter().find(|candidate| {
                    candidate.host.id == host.id
                        && candidate.terminal == binding.terminal_id.as_str()
                })
            {
                self.failures.insert(candidate.failure.clone());
            }
        }
        let mut selected = residents
            .iter()
            .filter(|(host, binding, _)| self.pinned(&host.id, binding))
            .map(|(_, binding, _)| {
                (
                    binding.runtime_incarnation,
                    binding.transcript_key.to_string(),
                )
            })
            .collect::<HashSet<_>>();
        let limit = (self.capacity as usize).max(selected.len());
        for candidate in candidates {
            if selected.len() >= limit && !selected.contains(&candidate.identity) {
                continue;
            }
            if self.failures.contains(&candidate.failure) {
                continue;
            }
            let resident = residents.iter().any(|(_, binding, _)| {
                binding.runtime_incarnation == candidate.identity.0
                    && binding.transcript_key.as_str() == candidate.identity.1
            });
            if !resident && !candidate.preload {
                continue;
            }
            let manager = candidate.host.runtime.transcript_manager();
            if !manager.has_terminal_binding(&candidate.terminal) {
                // Native identity validation is the final admission gate. A failed
                // open never reserves a slot or evicts useful cached history.
                match candidate
                    .host
                    .runtime
                    .bind_transcript_candidate(candidate.terminal.clone())
                {
                    Ok(crate::AgentChatOpenResult::Bound { .. }) => {}
                    _ => {
                        self.failures.insert(candidate.failure.clone());
                        continue;
                    }
                }
            }
            selected.insert(candidate.identity.clone());
        }
        // Spare slots retain valid inactive history, most recently used first.
        let mut inactive = residents
            .iter()
            .filter(|(_, binding, _)| {
                !selected.contains(&(
                    binding.runtime_incarnation,
                    binding.transcript_key.to_string(),
                ))
            })
            .collect::<Vec<_>>();
        inactive.sort_by_key(|(_, binding, _)| {
            std::cmp::Reverse((
                self.used
                    .get(&(
                        binding.runtime_incarnation,
                        binding.transcript_key.to_string(),
                    ))
                    .copied()
                    .unwrap_or(0),
                binding.binding_generation,
            ))
        });
        for (host, binding, failed) in inactive {
            if selected.contains(&(
                binding.runtime_incarnation,
                binding.transcript_key.to_string(),
            )) {
                continue;
            }
            if selected.len() < limit && !*failed {
                selected.insert((
                    binding.runtime_incarnation,
                    binding.transcript_key.to_string(),
                ));
            } else if !self.pinned(&host.id, binding) {
                let _ = host
                    .runtime
                    .transcript_manager()
                    .detach_terminal(&binding.terminal_id);
            }
        }
        selected
    }
}
