//! Agent-independent search over the native chat's presentation documents.

use std::sync::Arc;

use parking_lot::Mutex;

const MAX_MATCHES: usize = 500;
const CONTEXT_CHARS: usize = 48;

#[derive(uniffi::Record)]
pub struct ChatSearchDocument {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct ChatSearchMatch {
    pub document_id: String,
    /// Byte offset in the original document; identity only, never a JS string offset.
    pub offset: u64,
    pub before: String,
    pub matched: String,
    pub after: String,
    pub leading: bool,
    pub trailing: bool,
}

#[derive(Clone, Default, uniffi::Record)]
pub struct ChatSearchResults {
    pub query: String,
    pub matches: Vec<ChatSearchMatch>,
    pub selected: Option<u32>,
    pub truncated: bool,
}

struct Document {
    source: ChatSearchDocument,
    folded: String,
    /// Only non-ASCII text needs a mapping from lowercase bytes to source bytes.
    boundaries: Vec<(usize, usize)>,
}

impl From<ChatSearchDocument> for Document {
    fn from(source: ChatSearchDocument) -> Self {
        let mut folded = String::with_capacity(source.text.len());
        let mut boundaries = Vec::new();
        if source.text.is_ascii() {
            folded = source.text.to_ascii_lowercase();
        } else {
            for (offset, character) in source.text.char_indices() {
                boundaries.push((folded.len(), offset));
                folded.extend(character.to_lowercase());
            }
            boundaries.push((folded.len(), source.text.len()));
        }
        Self {
            source,
            folded,
            boundaries,
        }
    }
}

impl Document {
    fn source_range(&self, start: usize, end: usize) -> (usize, usize) {
        if self.boundaries.is_empty() {
            return (start, end);
        }
        let first = self
            .boundaries
            .partition_point(|&(offset, _)| offset <= start)
            - 1;
        let last = self.boundaries.partition_point(|&(offset, _)| offset < end);
        (self.boundaries[first].1, self.boundaries[last].1)
    }

    fn excerpt(&self, start: usize, end: usize) -> ChatSearchMatch {
        let text = &self.source.text;
        let before = text[..start]
            .char_indices()
            .rev()
            .nth(CONTEXT_CHARS - 1)
            .map_or(0, |(offset, _)| offset);
        let after = text[end..]
            .char_indices()
            .nth(CONTEXT_CHARS)
            .map_or(text.len(), |(offset, _)| end + offset);
        ChatSearchMatch {
            document_id: self.source.id.clone(),
            offset: start as u64,
            before: text[before..start].to_owned(),
            matched: text[start..end].to_owned(),
            after: text[end..after].to_owned(),
            leading: before > 0,
            trailing: after < text.len(),
        }
    }
}

#[derive(Default)]
struct SearchState {
    documents: Vec<Document>,
    results: ChatSearchResults,
}

impl SearchState {
    fn search(&mut self, query: String) -> ChatSearchResults {
        let selected = (self.results.query == query)
            .then(|| {
                self.results
                    .selected
                    .and_then(|index| self.results.matches.get(index as usize))
            })
            .flatten()
            .map(|hit| (hit.document_id.clone(), hit.offset));
        // Use the same per-character mapping as documents (including expansions).
        let needle = query
            .trim()
            .chars()
            .flat_map(char::to_lowercase)
            .collect::<String>();
        let mut results = ChatSearchResults {
            query,
            ..ChatSearchResults::default()
        };
        if !needle.is_empty() {
            'documents: for document in &self.documents {
                let mut previous = None;
                for (offset, matched) in document.folded.match_indices(&needle) {
                    let range = document.source_range(offset, offset + matched.len());
                    // Lowercase expansion can map several matches to the same character.
                    if previous == Some(range) {
                        continue;
                    }
                    previous = Some(range);
                    if results.matches.len() == MAX_MATCHES {
                        results.truncated = true;
                        break 'documents;
                    }
                    results.matches.push(document.excerpt(range.0, range.1));
                }
            }
        }
        if !results.matches.is_empty() {
            let index = selected
                .and_then(|(id, offset)| {
                    results
                        .matches
                        .iter()
                        .position(|hit| hit.document_id == id && hit.offset == offset)
                })
                .unwrap_or(0);
            results.selected = u32::try_from(index).ok();
        }
        self.results = results.clone();
        results
    }
}

#[derive(Default, uniffi::Object)]
pub struct ChatSearchIndex {
    state: Mutex<SearchState>,
}

#[uniffi::export]
impl ChatSearchIndex {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Replace the loaded snapshot, pruning removed messages and branches.
    pub fn set_documents(&self, documents: Vec<ChatSearchDocument>) {
        self.state.lock().documents = documents.into_iter().map(Document::from).collect();
    }

    pub fn search(&self, query: String) -> ChatSearchResults {
        self.state.lock().search(query)
    }

    pub fn navigate(&self, backwards: bool) -> ChatSearchResults {
        let mut state = self.state.lock();
        let count = state.results.matches.len();
        if count > 0 {
            let current = state.results.selected.unwrap_or(0) as usize;
            let index = if backwards {
                (current + count - 1) % count
            } else {
                (current + 1) % count
            };
            state.results.selected = u32::try_from(index).ok();
        }
        state.results.clone()
    }

    pub fn select(&self, index: u32) -> ChatSearchResults {
        let mut state = self.state.lock();
        if (index as usize) < state.results.matches.len() {
            state.results.selected = Some(index);
        }
        state.results.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(id: &str, text: &str) -> ChatSearchDocument {
        ChatSearchDocument {
            id: id.into(),
            text: text.into(),
        }
    }

    #[test]
    fn finds_literal_case_insensitive_occurrences_and_wraps_both_ways() {
        let index = ChatSearchIndex::new();
        index.set_documents(vec![
            document("prompt", "Fix a.b then A.B"),
            document("tool", "aXb a.b"),
        ]);
        let results = index.search("a.b".into());
        assert_eq!(results.matches.len(), 3);
        assert_eq!(results.matches[1].matched, "A.B");
        assert_eq!(index.navigate(true).selected, Some(2));
        assert_eq!(index.navigate(false).selected, Some(0));
        assert_eq!(index.select(2).selected, Some(2));
        assert_eq!(index.select(99).selected, Some(2));
        assert_eq!(index.search("   ".into()).selected, None);
        assert!(index.navigate(true).matches.is_empty());
    }

    #[test]
    fn unicode_lowercase_expansion_and_emoji_preserve_original_excerpts() {
        let index = ChatSearchIndex::new();
        index.set_documents(vec![document("text", "😀 İSTANBUL — CAFÉ 中文 😀")]);
        let results = index.search("i".into());
        assert_eq!(results.matches[0].matched, "İ");
        assert_eq!(results.matches[0].before, "😀 ");
        assert_eq!(index.search("café".into()).matches[0].matched, "CAFÉ");
        assert_eq!(index.search("中文".into()).matches[0].matched, "中文");
        assert_eq!(index.search("😀".into()).matches.len(), 2);
        index.set_documents(vec![document("greek", "ΟΣ")]);
        assert_eq!(index.search("ΟΣ".into()).matches[0].matched, "ΟΣ");
    }

    #[test]
    fn snapshot_updates_preserve_selection_and_remove_stale_matches() {
        let index = ChatSearchIndex::new();
        index.set_documents(vec![document("a", "match"), document("b", "match")]);
        index.search("match".into());
        index.navigate(false);
        index.set_documents(vec![
            document("older", "match"),
            document("a", "match"),
            document("b", "match and more match"),
        ]);
        let results = index.search("match".into());
        assert_eq!(results.selected, Some(2));
        index.set_documents(vec![document("a", "replaced")]);
        assert!(index.search("match".into()).matches.is_empty());
        assert_eq!(index.search("replaced".into()).selected, Some(0));
    }

    #[test]
    fn results_and_unicode_excerpts_are_bounded() {
        let index = ChatSearchIndex::new();
        index.set_documents(vec![document("large", &"hit ".repeat(MAX_MATCHES + 1))]);
        let results = index.search("hit".into());
        assert_eq!(results.matches.len(), MAX_MATCHES);
        assert!(results.truncated);
        index.set_documents(vec![document(
            "unicode",
            &format!("{}needle{}", "😀".repeat(100), "界".repeat(100)),
        )]);
        let results = index.search("needle".into());
        let hit = &results.matches[0];
        assert_eq!(hit.before.chars().count(), CONTEXT_CHARS);
        assert_eq!(hit.after.chars().count(), CONTEXT_CHARS);
        assert!(hit.leading && hit.trailing);
    }
}
