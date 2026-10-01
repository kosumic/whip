//! Rust-owned offline metadata encoding, validation, and legacy cache migration.

use serde::{Deserialize, Serialize};

use crate::herdr_api::{HerdrSessionSnapshot, session_snapshot};
use crate::host_state::{
    HostFreshness, HostServerFocus, HostStateSnapshot, HostSyncStatus, normalize_snapshot,
    validate_snapshot,
};

const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfflineCache<T> {
    schema_version: u32,
    updated_at_ms: u64,
    snapshot: T,
}

pub(crate) fn encode(snapshot: &HerdrSessionSnapshot, updated_at_ms: u64) -> Option<String> {
    serde_json::to_string(&OfflineCache {
        schema_version: SCHEMA_VERSION,
        updated_at_ms,
        snapshot,
    })
    .ok()
}

pub(crate) fn decode(blob: &str) -> Option<HostStateSnapshot> {
    let cached: serde_json::Value = serde_json::from_str(blob).ok()?;
    let (mut snapshot, updated_at) = if cached.get("schemaVersion").is_some() {
        let cache: OfflineCache<serde_json::Value> = serde_json::from_value(cached).ok()?;
        if cache.schema_version != SCHEMA_VERSION {
            return None;
        }
        (
            session_snapshot(&cache.snapshot).ok()?,
            Some(cache.updated_at_ms),
        )
    } else {
        decode_legacy(cached)?
    };
    validate_snapshot(&snapshot).ok()?;
    normalize_snapshot(&mut snapshot);
    Some(HostStateSnapshot {
        revision: 0,
        connection_generation: 0,
        sync_generation: 0,
        sync_status: HostSyncStatus::Idle,
        freshness: HostFreshness::Stale,
        error: None,
        last_synced_at_ms: updated_at,
        last_event_at_ms: None,
        needs_resync: true,
        offline_cache_blob: None,
        focus: HostServerFocus {
            workspace_id: snapshot.focused_workspace_id.clone(),
            tab_id: snapshot.focused_tab_id.clone(),
            pane_id: snapshot.focused_pane_id.clone(),
        },
        snapshot: Some(snapshot),
    })
}

fn decode_legacy(mut cached: serde_json::Value) -> Option<(HerdrSessionSnapshot, Option<u64>)> {
    let updated_at = cached.get("updatedAt").and_then(serde_json::Value::as_u64);
    let snapshot = cached.get_mut("snapshot")?.as_object_mut()?;
    let server = snapshot.remove("server")?;
    if !server.get("running")?.as_bool()? {
        return None;
    }
    // Older cache records nest protocol metadata under `server`.
    snapshot.insert(
        "version".to_owned(),
        server.get("version").cloned().unwrap_or_else(|| "".into()),
    );
    snapshot.insert(
        "protocol".to_owned(),
        server.get("protocol").cloned().unwrap_or_else(|| 0.into()),
    );
    Some((session_snapshot(cached.get("snapshot")?).ok()?, updated_at))
}

#[cfg(test)]
pub(super) fn fixture() -> serde_json::Value {
    let panes = ["one", "two"].map(|id| {
        serde_json::json!({
            "pane_id": id, "terminal_id": format!("terminal-{id}"),
            "workspace_id": "workspace", "tab_id": "tab", "label": id,
            "focused": id == "one", "agent_status": "idle", "revision": 1
        })
    });
    serde_json::json!({
        "updatedAt": 1234,
        "snapshot": {
            "server": { "running": true, "version": "1", "protocol": 22 },
            "focused_workspace_id": "workspace", "focused_tab_id": "tab",
            "focused_pane_id": "one", "agents": [], "layouts": [],
            "workspaces": [{
                "workspace_id": "workspace", "number": 1, "label": "Workspace",
                "focused": true, "pane_count": 2, "tab_count": 1,
                "active_tab_id": "tab", "agent_status": "idle"
            }],
            "tabs": [{
                "tab_id": "tab", "workspace_id": "workspace", "number": 1,
                "label": "Tab", "focused": true, "pane_count": 2, "agent_status": "idle"
            }],
            "panes": panes
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_snapshot_decodes_as_stale_metadata_with_its_original_timestamp() {
        let state = decode(&fixture().to_string()).unwrap();
        assert_eq!(state.freshness, HostFreshness::Stale);
        assert_eq!(state.sync_status, HostSyncStatus::Idle);
        assert_eq!(state.last_synced_at_ms, Some(1234));
        assert!(state.needs_resync);
        assert!(state.offline_cache_blob.is_none());
        assert_eq!(state.snapshot.unwrap().panes.len(), 2);
    }

    #[test]
    fn rust_cache_round_trips_metadata_and_timestamp_as_a_stale_fallback() {
        let snapshot = decode(&fixture().to_string()).unwrap().snapshot.unwrap();
        let blob = encode(&snapshot, 5678).unwrap();
        let state = decode(&blob).unwrap();
        assert_eq!(state.snapshot.as_ref(), Some(&snapshot));
        assert_eq!(state.last_synced_at_ms, Some(5678));
        assert_eq!(state.freshness, HostFreshness::Stale);
        assert_eq!(state.sync_status, HostSyncStatus::Idle);
        assert!(state.needs_resync);
        assert!(state.offline_cache_blob.is_none());
        assert_eq!(state.focus.pane_id.as_deref(), Some("one"));
    }

    #[test]
    fn rust_cache_rejects_unknown_versions_missing_fields_and_invalid_relationships() {
        let snapshot = decode(&fixture().to_string()).unwrap().snapshot.unwrap();
        let blob = encode(&snapshot, 5678).unwrap();
        let cache: serde_json::Value = serde_json::from_str(&blob).unwrap();
        let mut unsupported = cache.clone();
        unsupported["schemaVersion"] = (SCHEMA_VERSION + 1).into();
        assert!(decode(&unsupported.to_string()).is_none());
        let mut incomplete = cache.clone();
        incomplete.as_object_mut().unwrap().remove("updatedAtMs");
        assert!(decode(&incomplete.to_string()).is_none());
        let mut empty_id = cache.clone();
        empty_id["snapshot"]["panes"][0]["terminal_id"] = "".into();
        assert!(decode(&empty_id.to_string()).is_none());
        let mut invalid_number = cache.clone();
        invalid_number["snapshot"]["workspaces"][0]["number"] = (-1).into();
        assert!(decode(&invalid_number.to_string()).is_none());
        let mut inconsistent = cache;
        inconsistent["snapshot"]["panes"][0]["tab_id"] = "missing".into();
        assert!(decode(&inconsistent.to_string()).is_none());
    }

    #[test]
    fn incomplete_or_inconsistent_caches_are_rejected() {
        assert!(decode("{invalid").is_none());
        assert!(decode("{}").is_none());
        let mut cache = fixture();
        cache["snapshot"]["panes"][0]["tab_id"] = "missing".into();
        assert!(decode(&cache.to_string()).is_none());
        let mut cache = fixture();
        cache["snapshot"]["server"]["running"] = false.into();
        assert!(decode(&cache.to_string()).is_none());
    }
}
