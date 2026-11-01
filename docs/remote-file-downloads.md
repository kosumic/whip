# Remote file downloads

Context-menu and preview downloads use `downloadRemoteEntry` and the same progress
panel. The destination picker runs before SSH starts. Native Rust transfers into
private staging; Expo then copies into the selected directory without overwriting
existing entries. Preview downloads fetch the original remote bytes, rather than
publishing a potentially edited or decoded preview cache.

File transfers show bytes, total size, and a percentage. Directory totals are
unknown and use an indeterminate indicator. Percentage stays below 100 until the
destination copy succeeds. Saving has its own indeterminate phase: Expo's copy
API has no progress callback or cancellation. Closing the owner during saving
detaches the UI, but staging stays alive until the copy resolves. Copy failures
retain their error and may leave a partial destination; check that location
before retrying. Existing destination files are never overwritten.

## Verification

Run the behavioral checks in the development environment:

```sh
nix develop --command npm test -- --runInBand \
  __tests__/remoteFileDownload.test.ts \
  __tests__/remoteFileManagerLoading.test.tsx \
  __tests__/githubAssetDownload.test.ts
```

The tests cover large byte counts, known and unknown totals, filesystem and SAF
destinations, SSH/copy failures, retry, cancellation, unmounts, and host changes.
They mock native filesystem operations; the following device checks complement
them on both iOS and Android:

1. Download a file larger than 100 MB from both entry points. Check increasing
   bytes/total, percentage, and bar, followed by Saving and then Complete. Verify
   the destination size and checksum against the remote source.
2. Download a directory containing nested files from its context menu. Check
   increasing bytes with an indeterminate indicator and verify all saved files.
3. Cancel during SSH, dismiss the picker, close the manager externally, and
   disconnect/reconnect the host. Check that no stale progress appears when
   reopening or switching hosts and that cancelled transfers publish nothing.
4. Select a destination containing the same name, or a document provider that
   rejects the write. Check the save error remains visible, Complete never
   appears, and retry works after choosing a suitable destination.
5. During Saving, check cancellation is disabled and the limitation is visible.
   With a slow provider, check that the interface continues to respond. If the
   provider fails partway through a directory, inspect the partial destination
   before retrying.
