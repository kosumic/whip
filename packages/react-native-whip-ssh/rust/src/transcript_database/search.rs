//! Durable substring candidates and native live projections. Queries never decode
//! saved checkpoints; backfill and checkpoint commits maintain the derived rows.

use super::*;
use crate::agent_sessions::AgentSessionManager;
use crate::agent_transcript::{AgentMessageRole, AgentTranscriptPart, AgentTranscriptStatus};
use crate::chat_search::{
    ChatSearchContentKind, ChatSearchDocument, ChatSearchMatch, Document, transcript,
};
use sha2::{Digest, Sha256};

const PAGE_SIZE: usize = 20;
const MAX_CONVERSATIONS: usize = 500;
const EXCERPTS_PER_CONVERSATION: usize = 3;
const MAX_QUERY_CHARS: usize = 256;

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS conversation_search (
 conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 title TEXT, directory TEXT, workspace_id TEXT, version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_search_documents (
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 document_id TEXT NOT NULL, ordinal INTEGER NOT NULL, priority INTEGER NOT NULL,
 text TEXT NOT NULL, folded TEXT NOT NULL, reveal TEXT NOT NULL,
 PRIMARY KEY(conversation_id, document_id)
);
CREATE TABLE IF NOT EXISTS conversation_search_grams (
 gram TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 document_id TEXT NOT NULL,
 PRIMARY KEY(gram, conversation_id, document_id)
);
CREATE INDEX IF NOT EXISTS conversation_search_grams_document ON conversation_search_grams(conversation_id, document_id);
CREATE INDEX IF NOT EXISTS conversation_search_workspace ON conversation_search(workspace_id, conversation_id);";

#[derive(Clone, uniffi::Record)]
pub struct GlobalConversationMatch {
    pub kind: ChatSearchContentKind,
    pub excerpt: ChatSearchMatch,
}

#[derive(Clone, uniffi::Record)]
pub struct GlobalConversationSearchHit {
    pub key: String,
    pub namespace: String,
    pub agent: AgentTranscriptKind,
    pub session_id: String,
    pub title: Option<String>,
    pub directory: Option<String>,
    pub workspace_id: Option<String>,
    pub updated_at: i64,
    pub live: bool,
    pub matches: Vec<GlobalConversationMatch>,
}

#[derive(uniffi::Record)]
pub struct GlobalConversationSearchResults {
    pub query: String,
    pub conversations: Vec<GlobalConversationSearchHit>,
    pub next_offset: Option<u32>,
    pub indexing: bool,
    pub truncated: bool,
}

#[derive(uniffi::Record)]
pub struct SearchConversationSnapshot {
    pub version: String,
    pub live: bool,
    pub state: AgentTranscriptState,
}

pub(super) struct Projection {
    version: String,
    title: Option<String>,
    directory: Option<String>,
    workspace_id: Option<String>,
    documents: Vec<ChatSearchDocument>,
}

pub(super) fn projection(
    identity: &TranscriptIdentity,
    state: &AgentTranscriptState,
) -> Projection {
    let title = state
        .info
        .as_ref()
        .and_then(|info| info.title.clone())
        .filter(|title| !title.trim().is_empty())
        .or_else(|| {
            state
                .messages
                .iter()
                .filter(|message| message.role == AgentMessageRole::User)
                .flat_map(|message| &message.parts)
                .find_map(|part| {
                    if let AgentTranscriptPart::Text { text, .. } = part {
                        text.lines()
                            .find(|line| !line.trim().is_empty())
                            .map(|line| line.chars().take(120).collect())
                    } else {
                        None
                    }
                })
        });
    let directory = state.info.as_ref().and_then(|info| info.directory.clone());
    let mut documents = transcript::documents(state);
    let metadata = [title.as_deref(), directory.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n");
    if !metadata.is_empty() && !documents.iter().any(|doc| doc.text == metadata) {
        documents.push(ChatSearchDocument {
            id: String::new(),
            text: metadata,
            reveal: Vec::new(),
            kind: ChatSearchContentKind::Metadata,
        });
    }
    Projection {
        version: String::new(),
        title,
        directory,
        workspace_id: crate::host_runtime::conversation_workspace(
            &identity.namespace,
            identity.agent,
            &identity.session_id,
        ),
        documents,
    }
}

pub(super) fn checkpoint_projection(identity: &TranscriptIdentity, blob: &[u8]) -> Projection {
    let mut projection = crate::agent_sessions::decode_cached_agent_transcript(
        identity.agent,
        identity.session_id.clone(),
        blob.to_vec(),
    )
    .map(|state| projection(identity, &state))
    // Preserve opaque/corrupt checkpoints for the normal decoder to report.
    // A failed derived projection must not delete the original conversation.
    .unwrap_or(Projection {
        version: String::new(),
        title: None,
        directory: None,
        workspace_id: None,
        documents: Vec::new(),
    });
    projection.version = format!("{:x}", Sha256::digest(blob));
    projection
}

fn folded(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).collect()
}

fn grams(text: &str) -> HashSet<String> {
    text.chars()
        .collect::<Vec<_>>()
        .windows(3)
        .map(|gram| gram.iter().collect())
        .collect()
}

pub(super) async fn write_projection(
    tx: &turso::transaction::Transaction<'_>,
    identity: &TranscriptIdentity,
    projection: &Projection,
) -> Result<(), StorageError> {
    let key = identity.key();
    tx.execute("INSERT INTO conversation_search (conversation_id, title, directory, workspace_id, version) VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(conversation_id) DO UPDATE SET title=excluded.title, directory=excluded.directory,
        workspace_id=COALESCE(excluded.workspace_id, conversation_search.workspace_id), version=excluded.version",
        (key.as_str(), projection.title.as_deref(), projection.directory.as_deref(), projection.workspace_id.as_deref(), projection.version.as_str())).await?;
    let mut rows = tx.query("SELECT document_id, text, priority, ordinal FROM conversation_search_documents WHERE conversation_id=?1", [key.as_str()]).await?;
    let mut previous = HashMap::new();
    while let Some(row) = rows.next().await? {
        previous.insert(
            row.get::<String>(0)?,
            (
                row.get::<String>(1)?,
                row.get::<i64>(2)?,
                row.get::<i64>(3)?,
            ),
        );
    }
    drop(rows);
    for (ordinal, document) in projection.documents.iter().enumerate() {
        let ordinal = i64::try_from(ordinal).unwrap_or(i64::MAX);
        let priority = document.kind.priority();
        if let Some((text, old_priority, old_ordinal)) = previous.remove(&document.id)
            && text == document.text
            && old_priority == priority
        {
            if old_ordinal != ordinal {
                tx.execute("UPDATE conversation_search_documents SET ordinal=?3 WHERE conversation_id=?1 AND document_id=?2", (key.as_str(), document.id.as_str(), ordinal)).await?;
            }
            continue;
        }
        let text_folded = folded(&document.text);
        tx.execute(
            "DELETE FROM conversation_search_grams WHERE conversation_id=?1 AND document_id=?2",
            (key.as_str(), document.id.as_str()),
        )
        .await?;
        tx.execute("INSERT INTO conversation_search_documents (conversation_id, document_id, ordinal, priority, text, folded, reveal)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(conversation_id,document_id) DO UPDATE SET
            ordinal=excluded.ordinal, priority=excluded.priority, text=excluded.text, folded=excluded.folded, reveal=excluded.reveal",
            (key.as_str(), document.id.as_str(), ordinal, priority, document.text.as_str(), text_folded.as_str(), serde_json::to_string(&document.reveal)?)).await?;
        for gram in grams(&text_folded) {
            tx.execute("INSERT INTO conversation_search_grams (gram, conversation_id, document_id) VALUES (?1, ?2, ?3)", (gram, key.as_str(), document.id.as_str())).await?;
        }
    }
    for id in previous.keys() {
        tx.execute(
            "DELETE FROM conversation_search_grams WHERE conversation_id=?1 AND document_id=?2",
            (key.as_str(), id.as_str()),
        )
        .await?;
        tx.execute(
            "DELETE FROM conversation_search_documents WHERE conversation_id=?1 AND document_id=?2",
            (key.as_str(), id.as_str()),
        )
        .await?;
    }
    Ok(())
}

impl Store {
    fn search_version(&mut self, key: &str) -> Result<Option<String>, StorageError> {
        self.runtime.block_on(async {
            let mut rows = self
                .connection
                .query(
                    "SELECT version FROM conversation_search WHERE conversation_id=?1",
                    [key],
                )
                .await?;
            rows.next()
                .await?
                .map(|row| row.get::<String>(0))
                .transpose()
                .map_err(Into::into)
        })
    }
    pub(super) fn backfill_search_one(&mut self) -> Result<bool, StorageError> {
        let next = self.runtime.block_on(async {
            let mut rows = self
                .connection
                .query(
                    "SELECT c.namespace, c.agent, c.session_id, t.checkpoint
                FROM conversations c JOIN transcript_checkpoints t ON t.conversation_id=c.id
                WHERE NOT EXISTS (SELECT 1 FROM conversation_search s WHERE s.conversation_id=c.id)
                ORDER BY c.updated_at DESC, c.id LIMIT 1",
                    (),
                )
                .await?;
            rows.next()
                .await?
                .map(|row| {
                    Ok::<_, StorageError>((
                        TranscriptIdentity {
                            namespace: row.get(0)?,
                            agent: agent_kind(&row.get::<String>(1)?)?,
                            session_id: row.get(2)?,
                        },
                        row.get::<Vec<u8>>(3)?,
                    ))
                })
                .transpose()
        })?;
        let Some((identity, blob)) = next else {
            return Ok(false);
        };
        let projection = checkpoint_projection(&identity, &blob);
        self.runtime.block_on(async {
            let tx = self.connection.transaction().await?;
            write_projection(&tx, &identity, &projection).await?;
            tx.commit().await?;
            Ok::<_, StorageError>(())
        })?;
        Ok(true)
    }

    fn search_saved(
        &mut self,
        needle: &str,
        namespace: Option<&str>,
        workspace: Option<&str>,
        limit: usize,
    ) -> Result<Vec<GlobalConversationSearchHit>, StorageError> {
        self.runtime.block_on(async {
            // A Unicode trigram is a lossless candidate filter. instr verifies
            // the complete literal; short queries use the persisted folded rows.
            let gram: String = needle.chars().take(3).collect();
            let gram = (gram.chars().count() == 3).then_some(gram);
            let candidates = if gram.is_some() {
                "JOIN conversation_search_grams g ON g.conversation_id=d.conversation_id AND g.document_id=d.document_id AND g.gram=?4"
            } else { "" };
            let short_query = if gram.is_none() { "AND ?4 IS NULL" } else { "" };
            let sql = format!("SELECT c.id, c.namespace, c.agent, c.session_id, c.updated_at,
                s.title, s.directory, s.workspace_id, MIN(d.priority)
                FROM conversations c JOIN conversation_search s ON s.conversation_id=c.id
                JOIN conversation_search_documents d ON d.conversation_id=c.id {candidates}
                WHERE (?1 IS NULL OR c.namespace=?1) AND (?2 IS NULL OR s.workspace_id=?2)
                AND instr(d.folded, ?3)>0 {short_query}
                GROUP BY c.id ORDER BY MIN(d.priority), c.updated_at DESC, c.id LIMIT ?5");
            let mut rows = self.connection.query(sql,
                (namespace, workspace, needle, gram.as_deref(), i64::try_from(limit).unwrap_or(i64::MAX))).await?;
            let mut hits = Vec::new();
            while let Some(row) = rows.next().await? {
                hits.push(GlobalConversationSearchHit {
                    key: row.get(0)?, namespace: row.get(1)?, agent: agent_kind(&row.get::<String>(2)?)?, session_id: row.get(3)?, updated_at: row.get(4)?,
                    title: row.get(5)?, directory: row.get(6)?, workspace_id: row.get(7)?, live: false, matches: Vec::new(),
                });
            }
            drop(rows);
            for hit in &mut hits {
                let mut docs = self.connection.query("SELECT document_id, text, reveal, priority FROM conversation_search_documents
                    WHERE conversation_id=?1 AND instr(folded,?2)>0 ORDER BY priority, ordinal, document_id LIMIT ?3",
                    (hit.key.as_str(), needle, i64::try_from(EXCERPTS_PER_CONVERSATION).unwrap_or(i64::MAX))).await?;
                while let Some(row) = docs.next().await? {
                    let kind = ChatSearchContentKind::from_priority(row.get(3)?);
                    let document = Document::from(ChatSearchDocument { id: row.get(0)?, text: row.get(1)?, reveal: serde_json::from_str(&row.get::<String>(2)?)?, kind });
                    if let Some(excerpt) = document.first_match(needle) { hit.matches.push(GlobalConversationMatch { kind, excerpt }); }
                }
            }
            Ok(hits)
        })
    }
}

pub(super) struct LiveSearchProjection {
    incarnation: u64,
    revision: u64,
    hit: GlobalConversationSearchHit,
    documents: Vec<Document>,
}

impl Worker {
    fn live_allowed(&self, identity: &TranscriptIdentity, incarnation: u64) -> bool {
        self.authorities
            .get(&identity.namespace)
            .is_none_or(|authority| {
                !authority.deleted
                    && authority.incarnation == incarnation
                    && authority
                        .retained
                        .as_ref()
                        .is_none_or(|keys| keys.contains(&identity.key()))
            })
    }

    fn refresh_live_search(&mut self, sources: &[AgentSessionManager]) {
        let mut retained = HashSet::new();
        for manager in sources {
            for (identity, incarnation, revision) in manager.search_catalog() {
                if !self.live_allowed(&identity, incarnation) {
                    continue;
                }
                let key = identity.key();
                retained.insert(key.clone());
                if self.live_search.get(&key).is_some_and(|live| {
                    live.incarnation == incarnation && live.revision == revision
                }) {
                    continue;
                }
                let Some(state) = manager.state(&key) else {
                    continue;
                };
                if !matches!(
                    state.status,
                    AgentTranscriptStatus::Live | AgentTranscriptStatus::Stale
                ) {
                    retained.remove(&key);
                    continue;
                }
                let projection = projection(&identity, &state);
                let mut previous: HashMap<_, _> = self
                    .live_search
                    .remove(&key)
                    .into_iter()
                    .flat_map(|live| live.documents)
                    .map(|doc| (doc.source.id.clone(), doc))
                    .collect();
                let mut documents: Vec<_> = projection
                    .documents
                    .into_iter()
                    .map(|source| {
                        if let Some(document) = previous.remove(&source.id)
                            && document.source.text == source.text
                            && document.source.kind == source.kind
                        {
                            return document;
                        }
                        Document::from(source)
                    })
                    .collect();
                documents.sort_by_key(|doc| doc.source.kind.priority());
                self.live_search.insert(
                    key.clone(),
                    LiveSearchProjection {
                        incarnation,
                        revision: state.revision,
                        hit: GlobalConversationSearchHit {
                            key,
                            namespace: identity.namespace,
                            agent: identity.agent,
                            session_id: identity.session_id,
                            title: projection.title,
                            directory: projection.directory,
                            workspace_id: projection.workspace_id,
                            updated_at: state
                                .info
                                .as_ref()
                                .and_then(|info| info.updated_at_ms)
                                .and_then(|value| i64::try_from(value).ok())
                                .unwrap_or(0),
                            live: true,
                            matches: Vec::new(),
                        },
                        documents,
                    },
                );
            }
        }
        self.live_search.retain(|key, _| retained.contains(key));
    }

    fn search_conversations(
        &mut self,
        query: String,
        namespace: Option<String>,
        workspace: Option<String>,
        offset: u32,
        sources: &[AgentSessionManager],
    ) -> Result<GlobalConversationSearchResults, AgentSessionError> {
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err(AgentSessionError::ReadFailed(
                "search query is too long".into(),
            ));
        }
        let needle = folded(query.trim());
        let mut result = GlobalConversationSearchResults {
            query,
            conversations: Vec::new(),
            next_offset: None,
            indexing: self.backfill_pending,
            truncated: false,
        };
        if needle.is_empty() {
            return Ok(result);
        }
        self.refresh_live_search(sources);
        let offset = usize::try_from(offset)
            .unwrap_or(MAX_CONVERSATIONS)
            .min(MAX_CONVERSATIONS);
        let take = (offset + PAGE_SIZE + 1).min(MAX_CONVERSATIONS + 1);
        let live_count = self.live_search.len();
        let mut hits = self.with_store(|store| {
            store.search_saved(
                &needle,
                namespace.as_deref(),
                workspace.as_deref(),
                take + live_count,
            )
        })?;
        hits.retain(|hit| !self.live_search.contains_key(&hit.key));
        for live in self.live_search.values() {
            if namespace
                .as_ref()
                .is_some_and(|namespace| namespace != &live.hit.namespace)
                || workspace
                    .as_ref()
                    .is_some_and(|workspace| Some(workspace) != live.hit.workspace_id.as_ref())
            {
                continue;
            }
            let matches: Vec<_> = live
                .documents
                .iter()
                .filter_map(|doc| {
                    doc.first_match(&needle)
                        .map(|excerpt| GlobalConversationMatch {
                            kind: doc.source.kind,
                            excerpt,
                        })
                })
                .take(EXCERPTS_PER_CONVERSATION)
                .collect();
            if !matches.is_empty() {
                let mut hit = live.hit.clone();
                hit.matches = matches;
                hits.push(hit);
            }
        }
        hits.sort_by(|a, b| {
            a.matches
                .first()
                .map(|matched| matched.kind.priority())
                .cmp(&b.matches.first().map(|matched| matched.kind.priority()))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.key.cmp(&b.key))
        });
        let end = (offset + PAGE_SIZE).min(MAX_CONVERSATIONS);
        result.truncated = hits.len() > MAX_CONVERSATIONS;
        if hits.len() > end && end < MAX_CONVERSATIONS {
            result.next_offset = u32::try_from(end).ok();
        }
        result.conversations = hits.into_iter().skip(offset).take(end - offset).collect();
        Ok(result)
    }
}

impl TranscriptDatabase {
    pub(crate) async fn search_conversations(
        &self,
        query: String,
        namespace: Option<String>,
        workspace: Option<String>,
        offset: u32,
        sources: Vec<AgentSessionManager>,
    ) -> Result<GlobalConversationSearchResults, AgentSessionError> {
        self.request(move |worker| {
            worker.search_conversations(query, namespace, workspace, offset, &sources)
        })
        .await
    }

    pub(crate) async fn read_search_conversation(
        &self,
        identity: TranscriptIdentity,
        known_version: Option<String>,
    ) -> Result<Option<SearchConversationSnapshot>, AgentSessionError> {
        let sources = crate::host_runtime::conversation_search_sources();
        self.request(move |worker| {
            let key = identity.key();
            for manager in sources {
                if let Some((_, incarnation, revision)) =
                    manager
                        .search_catalog()
                        .into_iter()
                        .find(|(current, incarnation, _)| {
                            current.key() == key && worker.live_allowed(current, *incarnation)
                        })
                {
                    let version = format!("live:{incarnation}:{revision}");
                    if known_version.as_ref() == Some(&version) {
                        return Ok(None);
                    }
                    if let Some(state) = manager.state(&key)
                        && matches!(
                            state.status,
                            AgentTranscriptStatus::Live | AgentTranscriptStatus::Stale
                        )
                    {
                        return Ok(Some(SearchConversationSnapshot {
                            version: format!("live:{incarnation}:{}", state.revision),
                            live: true,
                            state,
                        }));
                    }
                }
            }
            let version = worker
                .with_store(|store| store.search_version(&key))?
                .map(|version| format!("saved:{version}"));
            if version.is_some() && version == known_version {
                return Ok(None);
            }
            let blob = worker
                .with_store(|store| store.load(&key))?
                .ok_or_else(|| {
                    AgentSessionError::SessionClosed("saved conversation is unavailable".into())
                })?;
            let version = version.unwrap_or_else(|| format!("saved:{:x}", Sha256::digest(&blob)));
            let state = crate::agent_sessions::decode_cached_agent_transcript(
                identity.agent,
                identity.session_id,
                blob,
            )?;
            Ok(Some(SearchConversationSnapshot {
                version,
                live: false,
                state,
            }))
        })
        .await
    }
}

#[uniffi::export]
pub async fn search_agent_conversations(
    query: String,
    namespace: Option<String>,
    workspace_id: Option<String>,
    offset: u32,
) -> Result<GlobalConversationSearchResults, AgentSessionError> {
    database()?
        .search_conversations(
            query,
            namespace,
            workspace_id,
            offset,
            crate::host_runtime::conversation_search_sources(),
        )
        .await
}

#[uniffi::export]
pub async fn read_search_conversation(
    namespace: String,
    agent: AgentTranscriptKind,
    session_id: String,
    known_version: Option<String>,
) -> Result<Option<SearchConversationSnapshot>, AgentSessionError> {
    database()?
        .read_search_conversation(
            TranscriptIdentity {
                namespace,
                agent,
                session_id,
            },
            known_version,
        )
        .await
}
