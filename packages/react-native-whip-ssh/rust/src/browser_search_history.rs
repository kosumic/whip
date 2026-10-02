//! Local, bounded search suggestions. Page URLs and agent navigation stay out.

use std::sync::Arc;

use parking_lot::Mutex;

const MAX_SEARCHES: usize = 50;
const MAX_QUERY_CHARS: usize = 512;
const MAX_SNAPSHOT_BYTES: usize = 128 * 1024;

fn normalized(query: &str) -> Option<String> {
    let query = query.trim();
    (!query.is_empty()
        && query.chars().count() <= MAX_QUERY_CHARS
        && !query.chars().any(char::is_control))
    .then(|| query.to_owned())
}

#[derive(uniffi::Object)]
pub struct BrowserSearchHistory {
    queries: Mutex<Vec<String>>,
}

#[uniffi::export]
impl BrowserSearchHistory {
    #[uniffi::constructor]
    pub fn new(snapshot: String) -> Arc<Self> {
        let history = Arc::new(Self {
            queries: Mutex::new(Vec::new()),
        });
        if snapshot.len() <= MAX_SNAPSHOT_BYTES
            && let Ok(queries) = serde_json::from_str::<Vec<String>>(&snapshot)
        {
            // Preserve newest-first order while applying the same bounds and deduplication.
            for query in queries.into_iter().take(MAX_SEARCHES).rev() {
                history.record(query);
            }
        }
        history
    }

    pub fn record(&self, query: String) {
        let Some(query) = normalized(&query) else {
            return;
        };
        let folded = query.to_lowercase();
        let mut queries = self.queries.lock();
        queries.retain(|old| old.to_lowercase() != folded);
        queries.insert(0, query);
        queries.truncate(MAX_SEARCHES);
    }

    pub fn suggestions(&self, query: String) -> Vec<String> {
        let needle = query.trim().to_lowercase();
        self.queries
            .lock()
            .iter()
            .filter(|saved| saved.to_lowercase().contains(&needle))
            .cloned()
            .collect()
    }

    pub fn remove(&self, query: String) {
        let folded = query.trim().to_lowercase();
        self.queries
            .lock()
            .retain(|old| old.to_lowercase() != folded);
    }

    pub fn clear(&self) {
        self.queries.lock().clear();
    }

    pub fn snapshot(&self) -> String {
        serde_json::to_string(&*self.queries.lock()).unwrap_or_else(|_| "[]".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_searches_move_to_front_and_filter_without_case_sensitivity() {
        let history = BrowserSearchHistory::new(String::new());
        for query in ["rust", "日本語", "Rust Android", " RUST "] {
            history.record(query.into());
        }
        assert_eq!(history.suggestions("ruST".into()), ["RUST", "Rust Android"]);
        assert_eq!(history.suggestions("日本".into()), ["日本語"]);
        let restored = BrowserSearchHistory::new(history.snapshot());
        assert_eq!(
            restored.suggestions(String::new()),
            ["RUST", "Rust Android", "日本語"]
        );
        restored.remove("rust".into());
        assert_eq!(restored.suggestions("rust".into()), ["Rust Android"]);
        restored.clear();
        assert_eq!(restored.snapshot(), "[]");
    }

    #[test]
    fn malformed_history_and_invalid_queries_are_bounded() {
        let history = BrowserSearchHistory::new("[1, null]".into());
        for query in [
            String::new(),
            " \t ".into(),
            "a\nb".into(),
            "x".repeat(MAX_QUERY_CHARS + 1),
        ] {
            history.record(query);
        }
        assert!(history.suggestions(String::new()).is_empty());
        for index in 0..MAX_SEARCHES + 5 {
            history.record(format!("query {index}"));
        }
        let queries = history.suggestions(String::new());
        assert_eq!(queries.len(), MAX_SEARCHES);
        assert_eq!(queries[0], "query 54");
        assert_eq!(queries.last().unwrap(), "query 5");
    }
}
