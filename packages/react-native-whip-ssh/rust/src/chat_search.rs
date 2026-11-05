//! Whip's async owner and FFI registration for portable transcript search.
use crate::agent_sessions::ids::TranscriptKey;
use crate::agent_sessions::{AgentSessionError, AgentSessionManager};
use crate::agent_transcript::AgentTranscriptKind;
use crate::transcript_database::{TranscriptDatabase, TranscriptIdentity};
use agent_transcript_view::SearchState;
#[cfg(test)]
use agent_transcript_view::search::{CONTEXT_CHARS, ChatSearchDocument, MAX_MATCHES};
pub use agent_transcript_view::{ChatSearchFocus, ChatSearchMatch, ChatSearchResults};
use parking_lot::Mutex;
use std::sync::Arc;

#[derive(Default)]
struct SearchCache {
    index: SearchState,
    revision: Option<u64>,
}

enum SearchSource {
    Live {
        manager: AgentSessionManager,
        key: TranscriptKey,
    },
    Saved {
        database: TranscriptDatabase,
        identity: TranscriptIdentity,
    },
    #[cfg(test)]
    Loaded,
}

#[derive(uniffi::Object)]
pub struct ChatSearchIndex {
    source: SearchSource,
    state: Mutex<SearchCache>,
}

impl ChatSearchIndex {
    pub(crate) fn for_live(manager: AgentSessionManager, key: TranscriptKey) -> Arc<Self> {
        Arc::new(Self {
            source: SearchSource::Live { manager, key },
            state: Mutex::default(),
        })
    }

    pub(crate) fn for_checkpoint(
        database: TranscriptDatabase,
        identity: TranscriptIdentity,
    ) -> Arc<Self> {
        Arc::new(Self {
            source: SearchSource::Saved { database, identity },
            state: Mutex::default(),
        })
    }

    #[cfg(test)]
    fn new() -> Arc<Self> {
        Arc::new(Self {
            source: SearchSource::Loaded,
            state: Mutex::default(),
        })
    }

    #[cfg(test)]
    fn set_documents(&self, documents: Vec<ChatSearchDocument>) {
        self.state.lock().index.set_documents(documents);
    }
}

#[uniffi::export]
impl ChatSearchIndex {
    #[uniffi::constructor]
    pub fn for_saved(
        namespace: String,
        agent: AgentTranscriptKind,
        session_id: String,
    ) -> Result<Arc<Self>, AgentSessionError> {
        Ok(Self::for_checkpoint(
            crate::transcript_database::database()?,
            TranscriptIdentity {
                namespace,
                agent,
                session_id,
            },
        ))
    }

    /// Only queries and bounded results cross the mobile bridge. Snapshot
    /// cloning, document construction and matching run off the UI thread.
    pub async fn search(
        self: Arc<Self>,
        query: String,
        focus: Option<ChatSearchFocus>,
    ) -> Result<ChatSearchResults, AgentSessionError> {
        if query.trim().is_empty() {
            return Ok(self.state.lock().index.search(query));
        }
        let uninitialized = self.state.lock().revision.is_none();
        let saved = if let SearchSource::Saved { database, identity } = &self.source
            && uninitialized
        {
            Some(
                database
                    .read_transcript(identity.clone())
                    .await?
                    .ok_or_else(|| {
                        AgentSessionError::SessionClosed("saved chat is unavailable".into())
                    })?,
            )
        } else {
            None
        };
        crate::runtime()
            .map_err(AgentSessionError::ReadFailed)?
            .spawn_blocking(move || {
                let mut state = self.state.lock();
                let snapshot = match &self.source {
                    SearchSource::Live { manager, key } => {
                        manager.search_snapshot(key, state.revision)?
                    }
                    SearchSource::Saved { .. } => saved,
                    #[cfg(test)]
                    SearchSource::Loaded => None,
                };
                if let Some(snapshot) = snapshot {
                    state.index.restore(&snapshot);
                    state.revision = Some(snapshot.revision);
                }
                let result = state.index.search(query);
                let result = focus.map_or(result, |focus| state.index.focus(focus));
                drop(state);
                Ok(result)
            })
            .await
            .map_err(|error| {
                AgentSessionError::ReadFailed(format!("chat search task failed: {error}"))
            })?
    }

    pub fn navigate(&self, backwards: bool) -> ChatSearchResults {
        self.state.lock().index.navigate(backwards)
    }

    pub fn select(&self, index: u32) -> ChatSearchResults {
        self.state.lock().index.select(index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(id: &str, text: &str) -> ChatSearchDocument {
        ChatSearchDocument {
            id: id.into(),
            text: text.into(),
            reveal: vec![id.into()],
        }
    }

    fn search(index: &Arc<ChatSearchIndex>, query: &str) -> ChatSearchResults {
        futures::executor::block_on(index.clone().search(query.into(), None)).unwrap()
    }

    #[test]
    fn global_result_focus_reveals_a_document_beyond_the_normal_match_cap() {
        let index = ChatSearchIndex::new();
        index.set_documents(vec![
            document("noisy-tool", &"needle ".repeat(MAX_MATCHES + 1)),
            document("message", "needle"),
        ]);
        let results = futures::executor::block_on(index.clone().search(
            "needle".into(),
            Some(ChatSearchFocus {
                document_id: "message".into(),
                offset: 0,
            }),
        ))
        .unwrap();
        assert!(results.truncated);
        assert_eq!(results.matches.len(), MAX_MATCHES);
        assert_eq!(
            results.matches[results.selected.unwrap() as usize].document_id,
            "message"
        );
        let stale = futures::executor::block_on(index.search(
            "needle".into(),
            Some(ChatSearchFocus {
                document_id: "message".into(),
                offset: 999,
            }),
        ))
        .unwrap();
        assert_eq!(
            stale
                .matches
                .iter()
                .filter(|hit| hit.document_id == "message")
                .count(),
            1
        );
    }

    #[test]
    fn finds_literal_case_insensitive_occurrences_and_wraps_both_ways() {
        let index = ChatSearchIndex::new();
        index.set_documents(vec![
            document("prompt", "Fix a.b then A.B"),
            document("tool", "aXb a.b"),
        ]);
        let results = search(&index, "a.b");
        assert_eq!(results.matches.len(), 3);
        assert_eq!(results.matches[1].matched, "A.B");
        assert_eq!(index.navigate(true).selected, Some(2));
        assert_eq!(index.navigate(false).selected, Some(0));
        assert_eq!(index.select(2).selected, Some(2));
        assert_eq!(index.select(99).selected, Some(2));
        assert_eq!(search(&index, "   ").selected, None);
        assert!(index.navigate(true).matches.is_empty());
    }

    #[test]
    fn unicode_lowercase_expansion_and_emoji_preserve_original_excerpts() {
        let index = ChatSearchIndex::new();
        index.set_documents(vec![document("text", "😀 İSTANBUL — CAFÉ 中文 😀")]);
        let results = search(&index, "i");
        assert_eq!(results.matches[0].matched, "İ");
        assert_eq!(results.matches[0].before, "😀 ");
        assert_eq!(search(&index, "café").matches[0].matched, "CAFÉ");
        assert_eq!(search(&index, "中文").matches[0].matched, "中文");
        assert_eq!(search(&index, "😀").matches.len(), 2);
        index.set_documents(vec![document("greek", "ΟΣ")]);
        assert_eq!(search(&index, "ΟΣ").matches[0].matched, "ΟΣ");
    }

    #[test]
    fn snapshot_updates_preserve_selection_and_remove_stale_matches() {
        let index = ChatSearchIndex::new();
        index.set_documents(vec![document("a", "match"), document("b", "match")]);
        search(&index, "match");
        index.navigate(false);
        index.set_documents(vec![
            document("older", "match"),
            document("a", "match"),
            document("b", "match and more match"),
        ]);
        let results = search(&index, "match");
        assert_eq!(results.selected, Some(2));
        index.set_documents(vec![document("a", "replaced")]);
        assert!(search(&index, "match").matches.is_empty());
        assert_eq!(search(&index, "replaced").selected, Some(0));
    }

    #[test]
    fn results_and_unicode_excerpts_are_bounded() {
        let index = ChatSearchIndex::new();
        index.set_documents(vec![document("large", &"hit ".repeat(MAX_MATCHES + 1))]);
        let results = search(&index, "hit");
        assert_eq!(results.matches.len(), MAX_MATCHES);
        assert!(results.truncated);
        index.set_documents(vec![document(
            "unicode",
            &format!("{}needle{}", "😀".repeat(100), "界".repeat(100)),
        )]);
        let results = search(&index, "needle");
        let hit = &results.matches[0];
        assert_eq!(hit.before.chars().count(), CONTEXT_CHARS);
        assert_eq!(hit.after.chars().count(), CONTEXT_CHARS);
        assert!(hit.leading && hit.trailing);
    }
}
