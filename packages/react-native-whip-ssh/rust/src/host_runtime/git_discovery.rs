//! Host-local discovery cache. Inheritance requires evidence from both listings;
//! a path prefix alone cannot rule out a nested repository or a symlink.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use crate::remote_ops::{GitRepository, RemoteFileEntry, RemoteFileKind, remote_parent};

const CACHE_TTL: Duration = Duration::from_secs(60);
const MAX_CACHE_ENTRIES: usize = 256;
const GIT_MARKER: &str = ".git";

#[derive(Debug, PartialEq, Eq)]
pub(super) enum GitDiscoveryResult {
    Repository(GitRepository),
    NotRepository,
}

impl GitDiscoveryResult {
    pub(super) fn into_repository(self) -> Option<GitRepository> {
        match self {
            Self::Repository(repository) => Some(repository),
            Self::NotRepository => None,
        }
    }
}

impl From<Option<GitRepository>> for GitDiscoveryResult {
    fn from(repository: Option<GitRepository>) -> Self {
        repository.map_or(Self::NotRepository, Self::Repository)
    }
}

#[derive(Clone)]
struct Discovery {
    repository: Option<GitRepository>,
    observed: Instant,
}

struct Directory {
    marker: Option<RemoteFileEntry>,
    directories: HashSet<String>,
    observed: Instant,
}

#[derive(Default)]
pub(super) struct GitDiscoveryCache {
    generation: u64,
    revision: u64,
    discoveries: HashMap<String, Discovery>,
    directories: HashMap<String, Directory>,
}

impl GitDiscoveryCache {
    fn invalidate_path(&mut self, path: &str) {
        let prefix = format!("{}/", path.trim_end_matches('/'));
        self.discoveries
            .retain(|key, _| key != path && !key.starts_with(&prefix));
        self.revision += 1;
    }

    fn prepare(&mut self, generation: u64, now: Instant) {
        if self.generation != generation {
            self.discoveries.clear();
            self.directories.clear();
            self.generation = generation;
            self.revision += 1;
        }
        self.discoveries
            .retain(|_, entry| now.duration_since(entry.observed) < CACHE_TTL);
        self.directories
            .retain(|_, entry| now.duration_since(entry.observed) < CACHE_TTL);
        // Bound memory even when browsing many unique directories in one minute.
        if self.discoveries.len() >= MAX_CACHE_ENTRIES
            || self.directories.len() >= MAX_CACHE_ENTRIES
        {
            self.discoveries.clear();
            self.directories.clear();
            self.revision += 1;
        }
    }

    pub(super) fn observe(
        &mut self,
        generation: u64,
        path: &str,
        entries: &[RemoteFileEntry],
        now: Instant,
    ) {
        self.prepare(generation, now);
        let marker = entries
            .iter()
            .find(|entry| entry.name == GIT_MARKER)
            .cloned();
        let directories: HashSet<_> = entries
            .iter()
            .filter(|entry| entry.kind == RemoteFileKind::Directory && entry.name != GIT_MARKER)
            .map(|entry| entry.path.clone())
            .collect();
        let removed: Vec<_> = self.directories.get(path).map_or_else(Vec::new, |entry| {
            entry
                .directories
                .difference(&directories)
                .cloned()
                .collect()
        });
        for child in removed {
            self.invalidate_path(&child);
        }
        let marker_changed = self
            .directories
            .get(path)
            .map_or_else(|| marker.is_some(), |directory| directory.marker != marker);
        if marker_changed {
            self.invalidate_path(path);
        }
        self.directories.insert(
            path.to_owned(),
            Directory {
                marker,
                directories,
                observed: now,
            },
        );
    }

    pub(super) fn lookup(
        &mut self,
        generation: u64,
        path: &str,
        now: Instant,
    ) -> Option<GitDiscoveryResult> {
        self.prepare(generation, now);
        if let Some(entry) = self.discoveries.get(path) {
            return Some(entry.repository.clone().into());
        }
        let directory = self.directories.get(path)?;
        // Worktrees and submodules use a .git file; any marker blocks inheritance.
        if directory.marker.is_some() {
            return None;
        }
        let parent = remote_parent(path).ok()?;
        if parent == path || !self.directories.get(&parent)?.directories.contains(path) {
            return None;
        }
        let entry = self.discoveries.get(&parent)?.clone();
        if let Some(repository) = &entry.repository {
            // Git returns physical roots. Do not infer across an aliased path.
            let prefix = format!("{}/", repository.root.trim_end_matches('/'));
            if parent != repository.root && !parent.starts_with(&prefix) {
                return None;
            }
        }
        let result = entry.repository.clone();
        // Preserve the original expiry instead of extending it on navigation.
        self.discoveries.insert(path.to_owned(), entry);
        Some(result.into())
    }

    pub(super) fn revision(&self) -> u64 {
        self.revision
    }

    pub(super) fn insert(
        &mut self,
        generation: u64,
        revision: u64,
        path: String,
        repository: Option<GitRepository>,
        now: Instant,
    ) {
        // A listing or reconnect may invalidate a discovery still in flight.
        if self.generation == generation && self.revision == revision {
            self.discoveries.insert(
                path,
                Discovery {
                    repository,
                    observed: now,
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, kind: RemoteFileKind) -> RemoteFileEntry {
        RemoteFileEntry {
            name: path.rsplit('/').next().unwrap().to_owned(),
            path: path.to_owned(),
            kind,
            size: None,
            modified_at: None,
            permissions: None,
        }
    }

    fn repository(root: &str) -> GitRepository {
        GitRepository {
            root: root.to_owned(),
            has_head: true,
        }
    }

    fn remember(
        cache: &mut GitDiscoveryCache,
        path: &str,
        result: Option<GitRepository>,
        now: Instant,
    ) {
        let _ = cache.lookup(1, path, now);
        cache.insert(1, cache.revision(), path.to_owned(), result, now);
    }

    #[test]
    fn exact_paths_cache_positive_and_negative_results() {
        let mut cache = GitDiscoveryCache::default();
        let now = Instant::now();
        remember(&mut cache, "/repo", Some(repository("/repo")), now);
        remember(&mut cache, "/outside", None, now);
        assert_eq!(
            cache.lookup(1, "/repo", now),
            Some(GitDiscoveryResult::Repository(repository("/repo")))
        );
        assert_eq!(
            cache.lookup(1, "/outside", now),
            Some(GitDiscoveryResult::NotRepository)
        );
        assert_eq!(cache.lookup(1, "/repo2", now), None);
    }

    #[test]
    fn listed_ordinary_children_inherit_without_renewing_expiry() {
        let mut cache = GitDiscoveryCache::default();
        let now = Instant::now();
        cache.observe(
            1,
            "/repo",
            &[entry("/repo/child", RemoteFileKind::Directory)],
            now,
        );
        remember(&mut cache, "/repo", Some(repository("/repo")), now);
        let later = now + CACHE_TTL / 2;
        cache.observe(1, "/repo/child", &[], later);
        assert_eq!(
            cache.lookup(1, "/repo/child", later),
            Some(GitDiscoveryResult::Repository(repository("/repo")))
        );
        assert_eq!(cache.lookup(1, "/repo/child", now + CACHE_TTL), None);
        assert_eq!(cache.lookup(1, "/repo", now + CACHE_TTL), None);
    }

    #[test]
    fn negative_parent_results_do_not_hide_nested_repositories_or_worktrees() {
        for marker_kind in [RemoteFileKind::Directory, RemoteFileKind::File] {
            for parent_result in [None, Some(repository("/parent"))] {
                let mut cache = GitDiscoveryCache::default();
                let now = Instant::now();
                cache.observe(
                    1,
                    "/parent",
                    &[entry("/parent/nested", RemoteFileKind::Directory)],
                    now,
                );
                remember(&mut cache, "/parent", parent_result, now);
                cache.observe(
                    1,
                    "/parent/nested",
                    &[
                        entry("/parent/nested/.git", marker_kind),
                        entry("/parent/nested/src", RemoteFileKind::Directory),
                    ],
                    now,
                );
                assert_eq!(cache.lookup(1, "/parent/nested", now), None);
                remember(
                    &mut cache,
                    "/parent/nested",
                    Some(repository("/parent/nested")),
                    now,
                );
                cache.observe(1, "/parent/nested/src", &[], now);
                assert_eq!(
                    cache.lookup(1, "/parent/nested/src", now),
                    Some(GitDiscoveryResult::Repository(repository("/parent/nested")))
                );
            }
        }
    }

    #[test]
    fn inheritance_requires_both_listings_and_a_physical_directory() {
        let mut cache = GitDiscoveryCache::default();
        let now = Instant::now();
        cache.observe(
            1,
            "/repo",
            &[
                entry("/repo/link", RemoteFileKind::Symlink),
                entry("/repo/.git", RemoteFileKind::Directory),
                entry("/repo/child", RemoteFileKind::Directory),
            ],
            now,
        );
        remember(&mut cache, "/repo", Some(repository("/repo")), now);
        assert_eq!(cache.lookup(1, "/repo/child", now), None);
        for path in ["/repo/link", "/repo/.git", "/repo/unlisted/deep"] {
            cache.observe(1, path, &[], now);
            assert_eq!(cache.lookup(1, path, now), None);
        }
        // A discovery through a symlink can be cached exactly, but its physical
        // root does not establish the lexical ancestry of subsequent paths.
        cache.observe(
            1,
            "/alias",
            &[entry("/alias/child", RemoteFileKind::Directory)],
            now,
        );
        remember(&mut cache, "/alias", Some(repository("/elsewhere")), now);
        cache.observe(1, "/alias/child", &[], now);
        assert_eq!(cache.lookup(1, "/alias/child", now), None);
    }

    #[test]
    fn marker_changes_invalidate_descendants_and_in_flight_discoveries() {
        let mut cache = GitDiscoveryCache::default();
        let now = Instant::now();
        cache.observe(
            1,
            "/repo",
            &[entry("/repo/.git", RemoteFileKind::Directory)],
            now,
        );
        remember(&mut cache, "/repo", Some(repository("/repo")), now);
        remember(&mut cache, "/repo/child", Some(repository("/repo")), now);
        let revision = cache.revision();
        cache.observe(1, "/repo", &[], now);
        cache.insert(
            1,
            revision,
            "/repo".to_owned(),
            Some(repository("/repo")),
            now,
        );
        assert_eq!(cache.lookup(1, "/repo", now), None);
        assert_eq!(cache.lookup(1, "/repo/child", now), None);
        remember(&mut cache, "/repo", None, now);
        cache.observe(
            1,
            "/repo",
            &[entry("/repo/.git", RemoteFileKind::File)],
            now,
        );
        assert_eq!(cache.lookup(1, "/repo", now), None);
    }

    #[test]
    fn an_ordinary_new_listing_does_not_discard_an_in_flight_parent_discovery() {
        let mut cache = GitDiscoveryCache::default();
        let now = Instant::now();
        cache.observe(
            1,
            "/repo",
            &[entry("/repo/child", RemoteFileKind::Directory)],
            now,
        );
        let revision = cache.revision();
        cache.observe(1, "/repo/child", &[], now);
        cache.insert(
            1,
            revision,
            "/repo".to_owned(),
            Some(repository("/repo")),
            now,
        );
        assert_eq!(
            cache.lookup(1, "/repo/child", now),
            Some(GitDiscoveryResult::Repository(repository("/repo")))
        );
    }

    #[test]
    fn replacing_a_directory_with_a_symlink_invalidates_its_cached_result() {
        let mut cache = GitDiscoveryCache::default();
        let now = Instant::now();
        cache.observe(
            1,
            "/repo",
            &[entry("/repo/child", RemoteFileKind::Directory)],
            now,
        );
        remember(&mut cache, "/repo/child", Some(repository("/repo")), now);
        cache.observe(
            1,
            "/repo",
            &[entry("/repo/child", RemoteFileKind::Symlink)],
            now,
        );
        cache.observe(1, "/repo/child", &[], now);
        assert_eq!(cache.lookup(1, "/repo/child", now), None);
    }

    #[test]
    fn reconnect_and_expiry_drop_negative_results() {
        let mut cache = GitDiscoveryCache::default();
        let now = Instant::now();
        remember(&mut cache, "/outside", None, now);
        assert_eq!(cache.lookup(1, "/outside", now + CACHE_TTL), None);
        remember(&mut cache, "/outside", None, now);
        let revision = cache.revision();
        assert_eq!(cache.lookup(2, "/outside", now), None);
        cache.insert(1, revision, "/outside".to_owned(), None, now);
        assert_eq!(cache.lookup(2, "/outside", now), None);
    }

    #[test]
    fn cache_size_is_bounded() {
        let mut cache = GitDiscoveryCache::default();
        let now = Instant::now();
        for index in 0..MAX_CACHE_ENTRIES * 2 {
            remember(&mut cache, &format!("/folder{index}"), None, now);
        }
        assert!(cache.discoveries.len() <= MAX_CACHE_ENTRIES);
    }
}
