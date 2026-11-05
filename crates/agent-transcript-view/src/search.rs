//! Literal Unicode search and bounded excerpts derived from canonical transcripts.
#[cfg(test)]
mod tests;
pub mod transcript;
#[cfg(test)]
mod transcript_tests;
use crate::{ChatSearchFocus, ChatSearchMatch, ChatSearchResults};
/// Maximum returned matches, including a focused match outside the usual cap.
pub const MAX_MATCHES: usize = 500;
/// Maximum Unicode characters retained on either side of a search match.
pub const CONTEXT_CHARS: usize = 48;

pub struct ChatSearchDocument {
    pub id: String,
    pub text: String,
    pub reveal: Vec<String>,
}

struct Document {
    pub source: ChatSearchDocument,
    pub folded: String,
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
    fn first_match(&self, needle: &str) -> Option<ChatSearchMatch> {
        let start = self.folded.find(needle)?;
        let (start, end) = self.source_range(start, start + needle.len());
        Some(self.excerpt(start, end))
    }
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
            reveal: self.source.reveal.clone(),
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
pub struct SearchState {
    documents: Vec<Document>,
    results: ChatSearchResults,
}

impl SearchState {
    /// Replace the derived index, consuming its documents without cloning them.
    pub fn set_documents(&mut self, documents: Vec<ChatSearchDocument>) {
        self.documents = documents.into_iter().map(Document::from).collect();
    }
    /// Rebuild derived searchable text from a borrowed canonical snapshot.
    pub fn restore(&mut self, state: &agent_transcript_core::AgentTranscriptState) {
        self.set_documents(transcript::documents(state));
    }
    pub fn navigate(&mut self, backwards: bool) -> ChatSearchResults {
        let count = self.results.matches.len();
        if count > 0 {
            let current = self.results.selected.unwrap_or(0) as usize;
            let index = if backwards {
                (current + count - 1) % count
            } else {
                (current + 1) % count
            };
            self.results.selected = u32::try_from(index).ok();
        }
        self.results.clone()
    }

    pub fn select(&mut self, index: u32) -> ChatSearchResults {
        if (index as usize) < self.results.matches.len() {
            self.results.selected = Some(index);
        }
        self.results.clone()
    }

    pub fn focus(&mut self, focus: ChatSearchFocus) -> ChatSearchResults {
        let needle: String = self
            .results
            .query
            .trim()
            .chars()
            .flat_map(char::to_lowercase)
            .collect();
        if needle.is_empty() {
            return self.results.clone();
        }
        if let Some(index) = self
            .results
            .matches
            .iter()
            .position(|hit| hit.document_id == focus.document_id && hit.offset == focus.offset)
        {
            self.results.selected = u32::try_from(index).ok();
        } else if let Some(document) = self
            .documents
            .iter()
            .find(|doc| doc.source.id == focus.document_id)
        {
            let matched = document
                .folded
                .match_indices(&needle)
                .find(|(start, _)| {
                    document.source_range(*start, *start + needle.len()).0 as u64 == focus.offset
                })
                .map(|(start, _)| {
                    let (start, end) = document.source_range(start, start + needle.len());
                    document.excerpt(start, end)
                })
                .or_else(|| document.first_match(&needle));
            if let Some(matched) = matched {
                if let Some(index) = self.results.matches.iter().position(|hit| {
                    hit.document_id == matched.document_id && hit.offset == matched.offset
                }) {
                    self.results.selected = u32::try_from(index).ok();
                    return self.results.clone();
                }
                if self.results.matches.len() == MAX_MATCHES {
                    self.results.matches.pop();
                    self.results.truncated = true;
                }
                self.results.matches.push(matched);
                self.results.selected = u32::try_from(self.results.matches.len() - 1).ok();
            }
        }
        self.results.clone()
    }
    pub fn search(&mut self, query: String) -> ChatSearchResults {
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
