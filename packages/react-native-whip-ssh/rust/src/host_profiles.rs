//! Canonical, secret-free host profile metadata and jump-host graph.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

const DEFAULT_SSH_PORT: &str = "22";
const DEFAULT_HERDR_COMMAND: &str = "herdr";
pub(crate) const MAX_AGENT_INSTRUCTIONS: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
#[serde(rename_all = "lowercase")]
pub enum HostAuthMode {
    Password,
    Key,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct HostProfileRecord {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: String,
    pub username: String,
    pub jump_host_id: Option<String>,
    #[serde(default)]
    pub forward_agent: bool,
    pub auth_mode: HostAuthMode,
    pub herdr_command: String,
    #[serde(default)]
    pub herdr_socket_path: String,
    #[serde(default)]
    pub session_name: String,
    #[serde(default)]
    pub agent_instructions: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_connected_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct HostProfileStoreView {
    pub revision: u64,
    pub hosts: Vec<HostProfileRecord>,
    pub persisted_value: String,
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error, uniffi::Error)]
pub enum HostProfileStoreError {
    #[error("host profile data is malformed: {0}")]
    MalformedPersistedData(String),
    #[error("host profile id is empty")]
    EmptyId,
    #[error("host name is empty")]
    EmptyHost,
    #[error("host username is empty")]
    EmptyUsername,
    #[error("SSH port is invalid: {0}")]
    InvalidPort(String),
    #[error("Host AGENTS.md exceeds 32768 UTF-8 bytes")]
    InstructionsTooLarge,
    #[error("host profile {0} does not exist")]
    MissingHost(String),
    #[error("jump host {0} no longer exists")]
    MissingJumpHost(String),
    #[error("jump host configuration contains a cycle")]
    JumpHostCycle,
}

#[derive(Debug, Default)]
struct HostProfileState {
    revision: u64,
    hosts: Vec<HostProfileRecord>,
}

#[derive(uniffi::Object)]
pub struct HostProfileStore {
    state: Mutex<HostProfileState>,
}

#[uniffi::export]
impl HostProfileStore {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(HostProfileState::default()),
        })
    }

    pub fn hydrate(
        &self,
        persisted: Option<String>,
    ) -> Result<HostProfileStoreView, HostProfileStoreError> {
        let hosts = persisted.map_or_else(
            || Ok(Vec::new()),
            |value| {
                serde_json::from_str::<Vec<HostProfileRecord>>(&value).map_err(|error| {
                    HostProfileStoreError::MalformedPersistedData(error.to_string())
                })
            },
        )?;
        let hosts = normalize_hosts(hosts)?;
        validate_graph(&hosts)?;
        let mut state = self.state.lock();
        state.hosts = hosts;
        state.revision = state.revision.saturating_add(1);
        let result = view(&state);
        drop(state);
        result
    }

    pub fn view(&self) -> Result<HostProfileStoreView, HostProfileStoreError> {
        view(&self.state.lock())
    }

    pub fn normalize_profile(
        &self,
        profile: HostProfileRecord,
        previous_created_at: Option<String>,
        now: String,
    ) -> Result<HostProfileRecord, HostProfileStoreError> {
        normalize_profile(profile, previous_created_at.as_deref(), &now)
    }

    pub fn upsert(
        &self,
        profile: HostProfileRecord,
        now: String,
    ) -> Result<HostProfileStoreView, HostProfileStoreError> {
        let mut state = self.state.lock();
        let previous = state.hosts.iter().find(|host| host.id == profile.id);
        let profile =
            normalize_profile(profile, previous.map(|host| host.created_at.as_str()), &now)?;
        let mut hosts = state
            .hosts
            .iter()
            .filter(|host| host.id != profile.id)
            .cloned()
            .collect::<Vec<_>>();
        hosts.push(profile);
        sort_hosts(&mut hosts);
        validate_graph(&hosts)?;
        state.hosts = hosts;
        state.revision = state.revision.saturating_add(1);
        let result = view(&state);
        drop(state);
        result
    }

    pub fn mark_disconnected(
        &self,
        id: String,
        now: String,
    ) -> Result<HostProfileStoreView, HostProfileStoreError> {
        let mut state = self.state.lock();
        let mut found = false;
        for host in &mut state.hosts {
            if host.id == id {
                host.last_connected_at = Some(now.clone());
                host.updated_at.clone_from(&now);
                found = true;
            }
        }
        if !found {
            return Err(HostProfileStoreError::MissingHost(id));
        }
        sort_hosts(&mut state.hosts);
        state.revision = state.revision.saturating_add(1);
        let result = view(&state);
        drop(state);
        result
    }

    pub fn remove(
        &self,
        id: String,
        now: String,
    ) -> Result<HostProfileStoreView, HostProfileStoreError> {
        let mut state = self.state.lock();
        state.hosts.retain(|host| host.id != id);
        for host in &mut state.hosts {
            if host.jump_host_id.as_deref() == Some(&id) {
                host.jump_host_id = None;
                host.updated_at.clone_from(&now);
            }
        }
        sort_hosts(&mut state.hosts);
        state.revision = state.revision.saturating_add(1);
        let result = view(&state);
        drop(state);
        result
    }

    pub fn resolve_jump_chain(
        &self,
        profile_id: String,
        jump_host_id: Option<String>,
    ) -> Result<Vec<HostProfileRecord>, HostProfileStoreError> {
        resolve_chain(
            &self.state.lock().hosts,
            &profile_id,
            jump_host_id.as_deref(),
        )
    }

    pub fn jump_candidates(
        &self,
        profile_id: String,
    ) -> Result<Vec<HostProfileRecord>, HostProfileStoreError> {
        let state = self.state.lock();
        Ok(state
            .hosts
            .iter()
            .filter(|candidate| {
                candidate.id != profile_id
                    && resolve_chain(&state.hosts, &profile_id, Some(&candidate.id)).is_ok()
            })
            .cloned()
            .collect())
    }

    pub fn migrate_legacy(
        &self,
        persisted: String,
        now: String,
    ) -> Result<Option<HostProfileRecord>, HostProfileStoreError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyProfile {
            name: Option<String>,
            host: Option<String>,
            port: Option<String>,
            username: Option<String>,
            auth_mode: Option<HostAuthMode>,
            herdr_command: Option<String>,
            herdr_socket_path: Option<String>,
            session_name: Option<String>,
        }
        let legacy = serde_json::from_str::<LegacyProfile>(&persisted)
            .map_err(|error| HostProfileStoreError::MalformedPersistedData(error.to_string()))?;
        let (Some(host), Some(username)) = (legacy.host, legacy.username) else {
            return Ok(None);
        };
        let name = legacy.name.unwrap_or_default();
        let name = if name.trim().is_empty() {
            legacy_host_name(&host)
        } else {
            name
        };
        normalize_profile(
            HostProfileRecord {
                id: "host-legacy-default".to_owned(),
                name,
                host,
                port: legacy.port.unwrap_or_else(|| DEFAULT_SSH_PORT.to_owned()),
                username,
                jump_host_id: None,
                forward_agent: false,
                auth_mode: legacy.auth_mode.unwrap_or(HostAuthMode::Password),
                herdr_command: legacy
                    .herdr_command
                    .unwrap_or_else(|| DEFAULT_HERDR_COMMAND.to_owned()),
                herdr_socket_path: legacy.herdr_socket_path.unwrap_or_default(),
                session_name: legacy.session_name.unwrap_or_default(),
                agent_instructions: String::new(),
                created_at: now.clone(),
                updated_at: now.clone(),
                last_connected_at: None,
            },
            None,
            &now,
        )
        .map(Some)
    }
}

fn normalize_hosts(
    hosts: Vec<HostProfileRecord>,
) -> Result<Vec<HostProfileRecord>, HostProfileStoreError> {
    let mut hosts = hosts
        .into_iter()
        .map(|host| {
            let now = host.updated_at.clone();
            normalize_profile(host, None, &now)
        })
        .collect::<Result<Vec<_>, _>>()?;
    sort_hosts(&mut hosts);
    Ok(hosts)
}

fn normalize_profile(
    mut profile: HostProfileRecord,
    previous_created_at: Option<&str>,
    now: &str,
) -> Result<HostProfileRecord, HostProfileStoreError> {
    trim_in_place(&mut profile.id);
    if profile.id.is_empty() {
        return Err(HostProfileStoreError::EmptyId);
    }
    trim_in_place(&mut profile.name);
    trim_in_place(&mut profile.host);
    if profile.host.is_empty() {
        return Err(HostProfileStoreError::EmptyHost);
    }
    trim_in_place(&mut profile.port);
    if profile.port.is_empty() {
        profile.port.push_str(DEFAULT_SSH_PORT);
    }
    if profile
        .port
        .parse::<u16>()
        .ok()
        .is_none_or(|port| port == 0)
    {
        return Err(HostProfileStoreError::InvalidPort(profile.port));
    }
    trim_in_place(&mut profile.username);
    if profile.username.is_empty() {
        return Err(HostProfileStoreError::EmptyUsername);
    }
    profile.jump_host_id = profile
        .jump_host_id
        .take()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty());
    profile.forward_agent = profile.auth_mode == HostAuthMode::Key && profile.forward_agent;
    trim_in_place(&mut profile.herdr_command);
    if profile.herdr_command.is_empty() {
        profile.herdr_command.push_str(DEFAULT_HERDR_COMMAND);
    }
    trim_in_place(&mut profile.herdr_socket_path);
    trim_in_place(&mut profile.session_name);
    if profile.agent_instructions.len() > MAX_AGENT_INSTRUCTIONS {
        return Err(HostProfileStoreError::InstructionsTooLarge);
    }
    profile.created_at = previous_created_at
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if profile.created_at.is_empty() {
                now
            } else {
                &profile.created_at
            }
        })
        .to_owned();
    now.clone_into(&mut profile.updated_at);
    Ok(profile)
}

fn trim_in_place(value: &mut String) {
    let leading = value.len().saturating_sub(value.trim_start().len());
    if leading > 0 {
        value.drain(..leading);
    }
    value.truncate(value.trim_end().len());
}

fn display_name(host: &HostProfileRecord) -> &str {
    if host.name.is_empty() {
        &host.host
    } else {
        &host.name
    }
}

fn sort_hosts(hosts: &mut [HostProfileRecord]) {
    hosts.sort_by(|left, right| {
        right
            .last_connected_at
            .as_deref()
            .unwrap_or_default()
            .cmp(left.last_connected_at.as_deref().unwrap_or_default())
            .then_with(|| {
                display_name(left)
                    .to_lowercase()
                    .cmp(&display_name(right).to_lowercase())
            })
            .then(left.id.cmp(&right.id))
    });
}

fn resolve_chain(
    hosts: &[HostProfileRecord],
    profile_id: &str,
    jump_host_id: Option<&str>,
) -> Result<Vec<HostProfileRecord>, HostProfileStoreError> {
    let by_id = hosts
        .iter()
        .map(|host| (host.id.as_str(), host))
        .collect::<HashMap<_, _>>();
    let mut seen = HashSet::from([profile_id]);
    let mut chain = Vec::new();
    let mut current = jump_host_id;
    while let Some(id) = current {
        if !seen.insert(id) {
            return Err(HostProfileStoreError::JumpHostCycle);
        }
        let host = by_id
            .get(id)
            .ok_or_else(|| HostProfileStoreError::MissingJumpHost(id.to_owned()))?;
        chain.insert(0, (*host).clone());
        current = host.jump_host_id.as_deref();
    }
    Ok(chain)
}

fn validate_graph(hosts: &[HostProfileRecord]) -> Result<(), HostProfileStoreError> {
    for host in hosts {
        resolve_chain(hosts, &host.id, host.jump_host_id.as_deref())?;
    }
    Ok(())
}

fn legacy_host_name(host: &str) -> String {
    let trimmed = host.trim();
    if trimmed.split('.').count() == 4
        && trimmed
            .split('.')
            .all(|part| !part.is_empty() && part.len() <= 3 && part.parse::<u8>().is_ok())
    {
        trimmed.to_owned()
    } else {
        trimmed.split('.').next().unwrap_or_default().to_owned()
    }
}

fn view(state: &HostProfileState) -> Result<HostProfileStoreView, HostProfileStoreError> {
    Ok(HostProfileStoreView {
        revision: state.revision,
        hosts: state.hosts.clone(),
        persisted_value: serde_json::to_string(&state.hosts)
            .map_err(|error| HostProfileStoreError::MalformedPersistedData(error.to_string()))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_instructions_round_trip_and_old_profiles_default_to_empty()
    -> Result<(), Box<dyn std::error::Error>> {
        let store = HostProfileStore::new();
        let mut profile = host("mini", None);
        profile.agent_instructions = "# Mini\n\nUse system Xcode.\n".into();
        let saved = store.upsert(profile.clone(), "today".into())?;
        let restored = HostProfileStore::new().hydrate(Some(saved.persisted_value))?;
        assert_eq!(
            restored.hosts[0].agent_instructions,
            profile.agent_instructions
        );
        let mut legacy = serde_json::to_value(profile)?;
        legacy
            .as_object_mut()
            .ok_or("missing profile")?
            .remove("agentInstructions");
        let restored = store.hydrate(Some(serde_json::to_string(&vec![legacy])?))?;
        assert!(restored.hosts[0].agent_instructions.is_empty());
        let mut oversized = host("large", None);
        oversized.agent_instructions = "a".repeat(MAX_AGENT_INSTRUCTIONS + 1);
        assert!(matches!(
            store.upsert(oversized, "today".into()),
            Err(HostProfileStoreError::InstructionsTooLarge)
        ));
        Ok(())
    }

    fn host(id: &str, jump_host_id: Option<&str>) -> HostProfileRecord {
        HostProfileRecord {
            id: id.to_owned(),
            name: id.to_owned(),
            host: format!("{id}.example"),
            port: "22".to_owned(),
            username: "user".to_owned(),
            jump_host_id: jump_host_id.map(str::to_owned),
            forward_agent: false,
            auth_mode: HostAuthMode::Key,
            herdr_command: "herdr".to_owned(),
            herdr_socket_path: String::new(),
            session_name: String::new(),
            agent_instructions: String::new(),
            created_at: "2026-01-01".to_owned(),
            updated_at: "2026-01-01".to_owned(),
            last_connected_at: None,
        }
    }

    #[test]
    fn resolves_normal_and_multi_hop_chains_outermost_first() {
        let store = HostProfileStore::new();
        store
            .hydrate(Some(
                serde_json::to_string(&vec![
                    host("outer", None),
                    host("inner", Some("outer")),
                    host("target", Some("inner")),
                ])
                .unwrap(),
            ))
            .unwrap();
        let chain = store
            .resolve_jump_chain("target".to_owned(), Some("inner".to_owned()))
            .unwrap();
        assert_eq!(
            chain
                .iter()
                .map(|host| host.id.as_str())
                .collect::<Vec<_>>(),
            ["outer", "inner"]
        );
    }

    #[test]
    fn rejects_missing_direct_and_indirect_cycles() {
        let store = HostProfileStore::new();
        store
            .hydrate(Some(serde_json::to_string(&vec![host("a", None)]).unwrap()))
            .unwrap();
        assert!(matches!(
            store.resolve_jump_chain("a".to_owned(), Some("missing".to_owned())),
            Err(HostProfileStoreError::MissingJumpHost(_))
        ));
        assert!(matches!(
            store.resolve_jump_chain("a".to_owned(), Some("a".to_owned())),
            Err(HostProfileStoreError::JumpHostCycle)
        ));

        let profiles = vec![host("a", Some("b")), host("b", Some("a"))];
        assert!(matches!(
            normalize_hosts(profiles).and_then(|hosts| validate_graph(&hosts)),
            Err(HostProfileStoreError::JumpHostCycle)
        ));
    }

    #[test]
    fn candidates_exclude_self_and_descendants() {
        let store = HostProfileStore::new();
        store
            .hydrate(Some(
                serde_json::to_string(&vec![
                    host("target", None),
                    host("safe", None),
                    host("dependent", Some("target")),
                ])
                .unwrap(),
            ))
            .unwrap();
        assert_eq!(
            store
                .jump_candidates("target".to_owned())
                .unwrap()
                .iter()
                .map(|host| host.id.as_str())
                .collect::<Vec<_>>(),
            ["safe"]
        );
    }

    #[test]
    fn deleting_jump_host_clears_dangling_reference() {
        let store = HostProfileStore::new();
        store
            .hydrate(Some(
                serde_json::to_string(&vec![host("jump", None), host("target", Some("jump"))])
                    .unwrap(),
            ))
            .unwrap();
        let view = store
            .remove("jump".to_owned(), "2026-02-01".to_owned())
            .unwrap();
        assert_eq!(view.hosts.len(), 1);
        assert_eq!(view.hosts[0].jump_host_id, None);
        assert_eq!(view.hosts[0].updated_at, "2026-02-01");
    }
}
