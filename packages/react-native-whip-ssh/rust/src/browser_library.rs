//! Personal browser data, separate from agent session archives.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};
const MAX_HISTORY: usize = 500;
const MAX_SAVED: usize = 100;
const MAX_SNAPSHOT: usize = 2 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize, uniffi::Record)]
pub struct BrowserSite {
    pub url: String,
    pub title: String,
    pub visited_at: u64,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Library {
    bookmarks: Vec<BrowserSite>,
    history: Vec<BrowserSite>,
    shortcuts: Vec<BrowserSite>,
    tunneled_hosts: BTreeSet<String>,
}
fn site(url: String, title: String, visited_at: u64) -> Option<BrowserSite> {
    if url.len() > 8192 {
        return None;
    }
    let parsed = url::Url::parse(&url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return None;
    }
    Some(BrowserSite {
        url: parsed.to_string(),
        title: title.trim().chars().take(256).collect(),
        visited_at,
    })
}
fn insert(sites: &mut Vec<BrowserSite>, entry: BrowserSite, maximum: usize) {
    sites.retain(|old| old.url != entry.url);
    sites.insert(0, entry);
    sites.truncate(maximum);
}
#[derive(uniffi::Object)]
pub struct BrowserLibrary {
    data: Mutex<Library>,
}
#[uniffi::export]
impl BrowserLibrary {
    #[uniffi::constructor]
    pub fn new(snapshot: String) -> Arc<Self> {
        let mut data = if snapshot.len() <= MAX_SNAPSHOT {
            serde_json::from_str::<Library>(&snapshot).unwrap_or_default()
        } else {
            Library::default()
        };
        if snapshot.is_empty() {
            for (title, url) in [
                ("X", "https://x.com/"),
                ("YouTube", "https://www.youtube.com/"),
                ("Reddit", "https://www.reddit.com/"),
                ("Hacker News", "https://news.ycombinator.com/"),
                ("Wikipedia", "https://www.wikipedia.org/"),
                ("小红书", "https://www.xiaohongshu.com/"),
                ("知乎", "https://www.zhihu.com/"),
            ] {
                if let Some(entry) = site(url.into(), title.into(), 0) {
                    data.shortcuts.push(entry);
                }
            }
        }
        for (list, maximum) in [
            (&mut data.history, MAX_HISTORY),
            (&mut data.bookmarks, MAX_SAVED),
            (&mut data.shortcuts, MAX_SAVED),
        ] {
            let restored = std::mem::take(list);
            for entry in restored.into_iter().take(maximum).rev() {
                if let Some(entry) = site(entry.url, entry.title, entry.visited_at) {
                    insert(list, entry, maximum);
                }
            }
        }
        data.tunneled_hosts
            .retain(|id| !id.is_empty() && id.len() <= 256);
        Arc::new(Self {
            data: Mutex::new(data),
        })
    }
    pub fn bookmarks(&self) -> Vec<BrowserSite> {
        self.data.lock().bookmarks.clone()
    }
    pub fn history(&self) -> Vec<BrowserSite> {
        self.data.lock().history.clone()
    }
    pub fn shortcuts(&self) -> Vec<BrowserSite> {
        self.data.lock().shortcuts.clone()
    }
    pub fn visit(&self, url: String, title: String, visited_at: u64) {
        if let Some(entry) = site(url, title, visited_at) {
            insert(&mut self.data.lock().history, entry, MAX_HISTORY);
        }
    }
    pub fn bookmark(&self, url: String, title: String) {
        if let Some(entry) = site(url, title, 0) {
            insert(&mut self.data.lock().bookmarks, entry, MAX_SAVED);
        }
    }
    pub fn add_shortcut(&self, url: String, title: String) {
        if let Some(entry) = site(url, title, 0) {
            insert(&mut self.data.lock().shortcuts, entry, MAX_SAVED);
        }
    }
    pub fn remove_bookmark(&self, url: String) {
        self.data.lock().bookmarks.retain(|entry| entry.url != url);
    }
    pub fn remove_history(&self, url: String) {
        self.data.lock().history.retain(|entry| entry.url != url);
    }
    pub fn remove_shortcut(&self, url: String) {
        self.data.lock().shortcuts.retain(|entry| entry.url != url);
    }
    pub fn clear_history(&self) {
        self.data.lock().history.clear();
    }
    pub fn tunneling(&self, host_id: String) -> bool {
        self.data.lock().tunneled_hosts.contains(&host_id)
    }
    pub fn set_tunneling(&self, host_id: String, enabled: bool) {
        if host_id.is_empty() || host_id.len() > 256 {
            return;
        }
        let mut data = self.data.lock();
        if enabled {
            data.tunneled_hosts.insert(host_id);
        } else {
            data.tunneled_hosts.remove(&host_id);
        }
    }
    pub fn snapshot(&self) -> String {
        serde_json::to_string(&*self.data.lock()).unwrap_or_default()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn data_round_trips_and_rejects_unsafe_urls() {
        let library = BrowserLibrary::new(String::new());
        assert_eq!(library.shortcuts().len(), 7);
        for url in [
            "about:blank",
            "file:///etc/passwd",
            "https://user:secret@example.com",
        ] {
            library.bookmark(url.into(), "bad".into());
        }
        assert!(library.bookmarks().is_empty());
        library.bookmark("https://example.com".into(), "Example".into());
        library.visit("https://example.com".into(), "First".into(), 10);
        library.visit("https://example.com/".into(), "Latest".into(), 20);
        library.set_tunneling("saved-host".into(), true);
        for entry in library.shortcuts() {
            library.remove_shortcut(entry.url);
        }
        let restored = BrowserLibrary::new(library.snapshot());
        assert!(restored.shortcuts().is_empty());
        assert_eq!(restored.history().len(), 1);
        assert_eq!(restored.history()[0].title, "Latest");
        assert!(restored.tunneling("saved-host".into()));
        assert!(!restored.tunneling("other-host".into()));
        restored.clear_history();
        assert!(restored.history().is_empty());
        assert_eq!(restored.bookmarks().len(), 1);
    }
}
