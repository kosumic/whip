//! Short-lived directory snapshots for one SSH connection. Reads always refresh
//! over SFTP; the UI can separately request a recent snapshot without waiting.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::remote_ops::{RemoteDirectoryListing, remote_parent};

const CACHE_TTL: Duration = Duration::from_secs(60);
const MAX_CACHE_ENTRIES: usize = 32;

struct Snapshot {
    listing: RemoteDirectoryListing,
    updated_at: Instant,
    request: u64,
    last_used: u64,
}

#[derive(Clone, Copy)]
pub(super) struct DirectoryRequest {
    generation: u64,
    revision: u64,
    sequence: u64,
}

#[derive(Default)]
pub(super) struct DirectoryCache {
    generation: u64,
    revision: u64,
    sequence: u64,
    entries: HashMap<String, Snapshot>,
}

impl DirectoryCache {
    fn prepare(&mut self, generation: u64, now: Instant) -> bool {
        if generation < self.generation {
            return false;
        }
        if self.generation != generation {
            self.clear();
            self.generation = generation;
        }
        self.entries
            .retain(|_, snapshot| now.duration_since(snapshot.updated_at) < CACHE_TTL);
        self.sequence += 1;
        true
    }

    pub(super) fn clear(&mut self) {
        self.entries.clear();
        self.revision += 1;
    }

    pub(super) fn lookup(
        &mut self,
        generation: u64,
        path: &str,
        now: Instant,
    ) -> Option<RemoteDirectoryListing> {
        if !self.prepare(generation, now) {
            return None;
        }
        let snapshot = self.entries.get_mut(path)?;
        snapshot.last_used = self.sequence;
        Some(snapshot.listing.clone())
    }

    pub(super) fn begin(&mut self, generation: u64, now: Instant) -> DirectoryRequest {
        let _ = self.prepare(generation, now);
        DirectoryRequest {
            generation,
            revision: self.revision,
            sequence: self.sequence,
        }
    }

    pub(super) fn insert(
        &mut self,
        request: DirectoryRequest,
        listing: RemoteDirectoryListing,
        now: Instant,
    ) {
        // Do not revive a listing invalidated by a mutation/reconnect, or let
        // an earlier request overwrite a newer refresh of the same directory.
        if request.generation != self.generation
            || request.revision != self.revision
            || self
                .entries
                .get(&listing.path)
                .is_some_and(|entry| entry.request > request.sequence)
        {
            return;
        }
        self.entries
            .retain(|_, entry| now.duration_since(entry.updated_at) < CACHE_TTL);
        if self.entries.len() >= MAX_CACHE_ENTRIES
            && !self.entries.contains_key(&listing.path)
            && let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(path, _)| path.clone())
        {
            self.entries.remove(&oldest);
        }
        self.entries.insert(
            listing.path.clone(),
            Snapshot {
                listing,
                updated_at: now,
                request: request.sequence,
                last_used: request.sequence,
            },
        );
    }

    pub(super) fn invalidate(&mut self, generation: u64, paths: &[String], ancestors: bool) {
        if generation != self.generation {
            return;
        }
        self.revision += 1;
        for path in paths {
            let prefix = format!("{}/", path.trim_end_matches('/'));
            let parent = remote_parent(path).ok();
            self.entries.retain(|key, _| {
                key != path
                    && !key.starts_with(&prefix)
                    && parent.as_ref() != Some(key)
                    && !(ancestors && path.starts_with(&format!("{}/", key.trim_end_matches('/'))))
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remember(cache: &mut DirectoryCache, path: &str, now: Instant) {
        let request = cache.begin(1, now);
        cache.insert(
            request,
            RemoteDirectoryListing {
                path: path.to_owned(),
                entries: vec![],
            },
            now,
        );
    }

    #[test]
    fn returning_to_a_directory_uses_snapshot_without_extending_ttl() {
        let mut cache = DirectoryCache::default();
        let now = Instant::now();
        remember(&mut cache, "/home", now);
        remember(&mut cache, "/home/projects", now);
        assert_eq!(
            cache.lookup(1, "/home", now + CACHE_TTL / 2).unwrap().path,
            "/home"
        );
        assert!(cache.lookup(1, "/home", now + CACHE_TTL).is_none());
    }

    #[test]
    fn reconnect_and_clear_reject_old_listings() {
        let mut cache = DirectoryCache::default();
        let now = Instant::now();
        remember(&mut cache, "/home", now);
        let old = cache.begin(1, now);
        assert!(cache.lookup(2, "/home", now).is_none());
        cache.insert(
            old,
            RemoteDirectoryListing {
                path: "/home".into(),
                entries: vec![],
            },
            now,
        );
        assert!(cache.lookup(2, "/home", now).is_none());
        let request = cache.begin(2, now);
        cache.clear();
        cache.insert(
            request,
            RemoteDirectoryListing {
                path: "/home".into(),
                entries: vec![],
            },
            now,
        );
        assert!(cache.lookup(2, "/home", now).is_none());
    }

    #[test]
    fn old_generation_reads_cannot_clear_the_new_connections_cache() {
        let mut cache = DirectoryCache::default();
        let now = Instant::now();
        let request = cache.begin(2, now);
        cache.insert(
            request,
            RemoteDirectoryListing {
                path: "/home".into(),
                entries: vec![],
            },
            now,
        );
        let stale = cache.begin(1, now);
        assert!(cache.lookup(1, "/home", now).is_none());
        cache.insert(
            stale,
            RemoteDirectoryListing {
                path: "/home/old".into(),
                entries: vec![],
            },
            now,
        );
        assert!(cache.lookup(2, "/home", now).is_some());
        assert!(cache.lookup(2, "/home/old", now).is_none());
    }

    #[test]
    fn rename_invalidates_both_parents_and_subtrees_with_path_boundaries() {
        let mut cache = DirectoryCache::default();
        let now = Instant::now();
        for path in [
            "/a",
            "/b",
            "/a/old",
            "/a/old/child",
            "/b/new",
            "/a/older",
            "/unrelated",
        ] {
            remember(&mut cache, path, now);
        }
        cache.invalidate(1, &["/a/old".into(), "/b/new".into()], false);
        for path in ["/a", "/b", "/a/old", "/a/old/child", "/b/new"] {
            assert!(cache.lookup(1, path, now).is_none());
        }
        for path in ["/a/older", "/unrelated"] {
            assert!(cache.lookup(1, path, now).is_some());
        }
    }

    #[test]
    fn recursive_mkdir_invalidates_ancestor_listings_including_root() {
        let mut cache = DirectoryCache::default();
        let now = Instant::now();
        for path in ["/", "/a", "/a/b", "/ab"] {
            remember(&mut cache, path, now);
        }
        cache.invalidate(1, &["/a/b/new".into()], true);
        for path in ["/", "/a", "/a/b"] {
            assert!(cache.lookup(1, path, now).is_none());
        }
        assert!(cache.lookup(1, "/ab", now).is_some());
    }

    #[test]
    fn mutation_rejects_in_flight_listing_and_old_generation_mutation_is_ignored() {
        let mut cache = DirectoryCache::default();
        let now = Instant::now();
        let request = cache.begin(1, now);
        cache.invalidate(1, &["/home/file".into()], false);
        cache.insert(
            request,
            RemoteDirectoryListing {
                path: "/home".into(),
                entries: vec![],
            },
            now,
        );
        assert!(cache.lookup(1, "/home", now).is_none());
        remember(&mut cache, "/home", now);
        cache.invalidate(0, &["/home/file".into()], false);
        assert!(cache.lookup(1, "/home", now).is_some());
    }

    #[test]
    fn later_refresh_wins_even_when_earlier_read_completes_last() {
        let mut cache = DirectoryCache::default();
        let now = Instant::now();
        let first = cache.begin(1, now);
        let second = cache.begin(1, now);
        let listing = RemoteDirectoryListing {
            path: "/home".into(),
            entries: vec![],
        };
        cache.insert(second, listing.clone(), now);
        cache.insert(first, listing, now);
        assert_eq!(cache.entries["/home"].request, second.sequence);
    }

    #[test]
    fn evicts_least_recently_used_directory_at_capacity() {
        let mut cache = DirectoryCache::default();
        let now = Instant::now();
        for index in 0..MAX_CACHE_ENTRIES {
            remember(&mut cache, &format!("/folder{index}"), now);
        }
        assert!(cache.lookup(1, "/folder0", now).is_some());
        remember(&mut cache, "/new", now);
        assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);
        assert!(cache.lookup(1, "/folder0", now).is_some());
        assert!(cache.lookup(1, "/folder1", now).is_none());
    }
}
