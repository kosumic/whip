//! Reclaim the retired global search index without deleting its enormous
//! B-trees in place (which would retain rollback pages in memory).

use super::{Path, StorageError, Store, database_sidecar, remove_database};

pub(super) const REPLACEMENT_SUFFIX: &str = ".without-search";

impl Store {
    pub(super) fn remove_search_index(mut self, path: &Path) -> Result<Self, StorageError> {
        let replacement_path = database_sidecar(path, REPLACEMENT_SUFFIX);
        // An interrupted copy never replaces the authoritative source. Retry
        // from that source, rather than trusting a partial replacement.
        remove_database(&replacement_path)?;
        let runtime = self.runtime;
        let mut replacement = Self::open(&replacement_path, runtime)?;
        runtime.block_on(async {
            replacement
                .connection
                .execute("ATTACH DATABASE ?1 AS previous_cache", [path.to_string_lossy().as_ref()])
                .await?;
            let tx = replacement.connection.transaction().await?;
            // These scans stream opaque checkpoints directly through the engine.
            // No transcript decoding or search-table reads are involved, and
            // timestamps and identities are preserved exactly.
            tx.execute("INSERT INTO conversations (id, namespace, agent, session_id, created_at, updated_at, cache_bytes)
                SELECT id, namespace, agent, session_id, created_at, updated_at, cache_bytes FROM previous_cache.conversations", ()).await?;
            tx.execute("INSERT INTO transcript_checkpoints (conversation_id, checkpoint)
                SELECT conversation_id, checkpoint FROM previous_cache.transcript_checkpoints", ()).await?;
            tx.commit().await?;
            replacement.connection.execute("DETACH DATABASE previous_cache", ()).await?;
            Ok::<_, StorageError>(())
        })?;
        // Both WALs must be empty before replacing the main file: an old WAL
        // beside the new database could otherwise replay unrelated pages.
        if !replacement.checkpoint()? || !self.checkpoint()? {
            return Err(StorageError::Migration("checkpoint is busy".into()));
        }
        drop(replacement);
        drop(self);
        std::fs::rename(&replacement_path, path)?;
        if let Some(parent) = path.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
        remove_database(&replacement_path)?;
        Self::open(path, runtime)
    }
}
