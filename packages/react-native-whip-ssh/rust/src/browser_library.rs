//! Personal browser data, separate from agent session archives.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};
const MAX_HISTORY: usize = 500;
const MAX_SAVED: usize = 100;
const MAX_SNAPSHOT: usize = 2 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize, uniffi::Record)]
pub struct BrowserSavedDownload {
    pub id: String,
    pub name: String,
    pub bytes: u64,
    pub total_bytes: i64,
    pub mime_type: String,
    pub state: String,
    pub created_at: u64,
}
impl BrowserSavedDownload {
    fn valid(&self) -> bool {
        self.id.len() == 36
            && self.id.bytes().enumerate().all(|(index, byte)| {
                if matches!(index, 8 | 13 | 18 | 23) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
            && !self.name.is_empty()
            && self.name.len() <= 1024
            && !self.name.contains(['/', '\\'])
            && !self.name.chars().any(char::is_control)
            && !matches!(self.name.as_str(), "." | "..")
            && self.mime_type.len() <= 256
            && self.total_bytes >= -1
            && matches!(
                self.state.as_str(),
                "downloading" | "complete" | "failed" | "cancelled" | "interrupted"
            )
    }
}
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
    downloads: Vec<BrowserSavedDownload>,
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
        data.downloads.retain(BrowserSavedDownload::valid);
        for entry in &mut data.downloads {
            if entry.state == "downloading" {
                entry.state = "interrupted".into();
            }
        }
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
    pub fn downloads(&self) -> Vec<BrowserSavedDownload> {
        self.data.lock().downloads.clone()
    }
    /// Native adapters report transfer facts; Rust validates and owns the index.
    pub fn record_download(&self, json: String) {
        let Ok(entry) = serde_json::from_str::<BrowserSavedDownload>(&json) else {
            return;
        };
        if !entry.valid() {
            return;
        }
        let mut data = self.data.lock();
        data.downloads.retain(|old| old.id != entry.id);
        data.downloads.push(entry);
        data.downloads.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
    }
    pub fn remove_download(&self, id: String) {
        self.data.lock().downloads.retain(|entry| entry.id != id);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn download(id: &str, state: &str) -> String {
        serde_json::json!({"id":id,"name":"report.pdf","bytes":12,"total_bytes":24,
            "mime_type":"application/pdf","state":state,"created_at":42})
        .to_string()
    }
    #[test]
    fn downloads_persist_progress_completion_and_interrupted_transfers() {
        let library = BrowserLibrary::new(String::new());
        let first = "12345678-1234-1234-1234-123456789012";
        let second = "12345678-1234-1234-1234-123456789013";
        library.record_download(download(first, "downloading"));
        library.record_download(download(second, "downloading"));
        library.record_download(download(first, "complete"));
        let restored = BrowserLibrary::new(library.snapshot());
        assert_eq!(restored.downloads().len(), 2);
        assert_eq!(restored.downloads()[0].state, "complete");
        assert_eq!(restored.downloads()[1].state, "interrupted");
        assert_eq!(restored.downloads()[0].bytes, 12);
        restored.remove_download(first.into());
        assert_eq!(restored.downloads()[0].id, second);
    }
    #[test]
    fn download_metadata_cannot_select_arbitrary_paths() {
        let library = BrowserLibrary::new(String::new());
        library.record_download(download("../../secrets", "complete"));
        let id = "12345678-1234-1234-1234-123456789012";
        for name in ["../secret", "..", "file\\secret", "bad\nname"] {
            let mut entry: serde_json::Value =
                serde_json::from_str(&download(id, "complete")).unwrap();
            entry["name"] = name.into();
            library.record_download(entry.to_string());
        }
        library.record_download(download(id, "unknown"));
        assert!(library.downloads().is_empty());
    }
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
