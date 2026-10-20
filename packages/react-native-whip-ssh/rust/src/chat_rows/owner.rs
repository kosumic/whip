use std::sync::Arc;

use parking_lot::Mutex;

use super::{AgentChatRowUpdate, RowProjection};
use crate::agent_sessions::{AgentSessionError, AgentSessionManager};
use crate::agent_transcript::AgentTranscriptKind;
use crate::transcript_database::{TranscriptDatabase, TranscriptIdentity};

enum Source {
    Live {
        manager: AgentSessionManager,
        key: String,
    },
    Saved {
        database: TranscriptDatabase,
        identity: TranscriptIdentity,
        conversation: bool,
        version: Mutex<Option<String>>,
    },
}

#[derive(uniffi::Object)]
pub struct AgentChatRows {
    source: Source,
    pub(crate) projection: Mutex<RowProjection>,
    // Serializes recovery and polling without holding the projection lock while
    // reading a manager/database. Emissions only acquire the projection lock.
    polling: tokio::sync::Mutex<()>,
}

impl AgentChatRows {
    pub(crate) fn for_checkpoint(
        database: TranscriptDatabase,
        identity: TranscriptIdentity,
        conversation: bool,
    ) -> Arc<Self> {
        Arc::new(Self {
            source: Source::Saved {
                database,
                identity,
                conversation,
                version: Mutex::default(),
            },
            projection: Mutex::default(),
            polling: tokio::sync::Mutex::default(),
        })
    }
    pub(crate) fn for_live(manager: AgentSessionManager, key: String) -> Arc<Self> {
        let owner = Arc::new(Self {
            source: Source::Live {
                manager: manager.clone(),
                key: key.clone(),
            },
            projection: Mutex::default(),
            polling: tokio::sync::Mutex::default(),
        });
        manager.register_rows(&key, &owner);
        owner
    }

    fn poll_blocking(
        &self,
        after: u64,
        transcript_revision: u64,
        working: bool,
        expanded: Vec<String>,
    ) -> Result<AgentChatRowUpdate, AgentSessionError> {
        let recover = {
            let projection = self.projection.lock();
            if projection.disposed {
                return Err(AgentSessionError::SessionClosed(
                    "chat viewport is disposed".into(),
                ));
            }
            !projection.initialized
                || projection.needs_reset
                || projection.transcript_revision < transcript_revision
                || (after == 0 && projection.revision > 0)
        };
        if recover && let Source::Live { manager, key } = &self.source {
            // Manager holds its lifecycle lock through restoration. An emission
            // cannot be lost between reading the snapshot and installing it.
            manager.restore_rows(key, self)?;
        }
        let mut projection = self.projection.lock();
        if projection.disposed {
            return Err(AgentSessionError::SessionClosed(
                "chat viewport is disposed".into(),
            ));
        }
        let update = projection.poll(after, working, expanded);
        drop(projection);
        Ok(update)
    }
}

#[uniffi::export]
impl AgentChatRows {
    #[uniffi::constructor]
    pub fn for_saved(
        namespace: String,
        agent: AgentTranscriptKind,
        session_id: String,
        conversation: bool,
    ) -> Result<Arc<Self>, AgentSessionError> {
        let identity = TranscriptIdentity {
            namespace,
            agent,
            session_id,
        };
        Ok(Self::for_checkpoint(
            crate::transcript_database::database()?,
            identity,
            conversation,
        ))
    }

    /// Only descriptors/patches cross FFI. Polling and authoritative recovery
    /// run on the blocking pool; dirty segment updates precede event delivery.
    pub async fn poll(
        self: Arc<Self>,
        after: u64,
        transcript_revision: u64,
        working: bool,
        expanded: Vec<String>,
    ) -> Result<AgentChatRowUpdate, AgentSessionError> {
        let polling = self.polling.lock().await;
        let uninitialized = {
            let projection = self.projection.lock();
            if projection.disposed {
                return Err(AgentSessionError::SessionClosed(
                    "chat viewport is disposed".into(),
                ));
            }
            !projection.initialized
        };
        let snapshot = if let Source::Saved {
            database,
            identity,
            conversation,
            version,
        } = &self.source
        {
            let snapshot = if *conversation {
                // Use the reader's existing versioned source rather than pinning
                // a particular host incarnation for an addressable conversation.
                let known = version.lock().clone();
                let snapshot = database
                    .read_search_conversation(identity.clone(), known)
                    .await?;
                snapshot.map(|snapshot| {
                    *version.lock() = Some(snapshot.version);
                    snapshot.state
                })
            } else if uninitialized {
                database.read_transcript(identity.clone()).await?
            } else {
                None
            };
            if uninitialized && snapshot.is_none() {
                return Err(AgentSessionError::SessionClosed(
                    "saved chat is unavailable".into(),
                ));
            }
            snapshot
        } else {
            None
        };
        let owner = Arc::clone(&self);
        let result = crate::runtime()
            .map_err(AgentSessionError::ReadFailed)?
            .spawn_blocking(move || {
                if let Some(snapshot) = snapshot {
                    let mut projection = owner.projection.lock();
                    if !projection.disposed {
                        if projection.initialized {
                            projection.reconcile_reset(&snapshot, snapshot.revision);
                        } else {
                            projection.restore(&snapshot);
                        }
                    }
                }
                owner.poll_blocking(after, transcript_revision, working, expanded)
            })
            .await
            .map_err(|error| {
                AgentSessionError::ReadFailed(format!("chat row projection failed: {error}"))
            })?;
        drop(polling);
        result
    }

    pub fn dispose(&self) {
        let mut projection = self.projection.lock();
        *projection = RowProjection {
            disposed: true,
            ..RowProjection::default()
        };
        drop(projection);
        if let Source::Live { manager, key } = &self.source {
            manager.unregister_rows(key, self);
        }
    }
}
