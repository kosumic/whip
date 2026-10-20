import {
  buildRemoteGitTree,
  buildRemoteGitTreeRows,
  collectRemoteGitFiles,
  flattenRemoteGitTree,
  isRemoteGitEntryDeleted,
  isRemoteGitEntryUntracked,
  remoteGitStatusLabel,
  type RemoteGitStatusEntry,
} from '../src/lib/remoteGit';
import { isRemoteHiddenPath } from '../src/lib/remoteFiles';

const status = (path: string, overrides: Partial<RemoteGitStatusEntry> = {}): RemoteGitStatusEntry => ({
  indexStatus: ' ',
  worktreeStatus: 'M',
  path,
  originalPath: null,
  absolutePath: `/repo/${path}`,
  ...overrides,
});

describe('remote Git status presentation', () => {
  it('labels normalized Rust status records', () => {
    expect(remoteGitStatusLabel(status('modified.ts'))).toBe('M');
    expect(remoteGitStatusLabel(status('new.ts', { indexStatus: '?', worktreeStatus: '?' }))).toBe('??');
    expect(isRemoteGitEntryUntracked(status('new.ts', { indexStatus: '?', worktreeStatus: '?' }))).toBe(true);
    expect(isRemoteGitEntryDeleted(status('gone.ts', { worktreeStatus: 'D' }))).toBe(true);
  });
});

describe('remote Git status tree', () => {
  it('groups directories before files and tracks nesting and change counts', () => {
    const rows = buildRemoteGitTreeRows(
      [status('README.md'), status('src/App.tsx'), status('src/components/Button.tsx'), status('assets/logo.svg')],
      new Set(),
    );

    expect(rows.map(row => [
      row.kind,
      row.name,
      row.depth,
      row.kind === 'directory' ? row.changeCount : row.status.path,
    ])).toEqual([
      ['directory', 'assets', 0, 1],
      ['file', 'logo.svg', 1, 'assets/logo.svg'],
      ['directory', 'src', 0, 2],
      ['directory', 'components', 1, 1],
      ['file', 'Button.tsx', 2, 'src/components/Button.tsx'],
      ['file', 'App.tsx', 1, 'src/App.tsx'],
      ['file', 'README.md', 0, 'README.md'],
    ]);
  });

  it('omits descendants of collapsed directories without losing root files', () => {
    const rows = buildRemoteGitTreeRows(
      [status('README.md'), status('src/App.tsx'), status('src/lib/api.ts')],
      new Set(['src']),
    );

    expect(rows.map(row => row.key)).toEqual(['directory:src', 'file: M:README.md']);
  });

  it('constructs a sorted nested hierarchy with recursive counts before flattening', () => {
    const entries = [status('src/lib/deep/file.ts'), status('src/App.tsx'), status('src/lib/api.ts'), status('README.md')];
    const tree = buildRemoteGitTree(entries);

    expect(tree).toEqual({
      path: '', name: '', changeCount: 4,
      directories: [{
        path: 'src', name: 'src', changeCount: 3,
        directories: [{
          path: 'src/lib', name: 'lib', changeCount: 2,
          directories: [{
            path: 'src/lib/deep', name: 'deep', changeCount: 1,
            directories: [], files: [{ name: 'file.ts', status: entries[0] }],
          }],
          files: [{ name: 'api.ts', status: entries[2] }],
        }],
        files: [{ name: 'App.tsx', status: entries[1] }],
      }],
      files: [{ name: 'README.md', status: entries[3] }],
    });
  });

  it('naturally sorts directories and filenames while preserving case and accent ties', () => {
    const entries = [
      status('dir10/file.ts'), status('dir2/file.ts'), status('dir1/file.ts'),
      status('file10.ts'), status('File2.ts'), status('file1.ts'), status('file2.ts'),
      status('Éclair.ts'), status('eclair.ts'),
    ];
    const tree = buildRemoteGitTree(Object.freeze(entries));

    expect(tree.directories.map(directory => directory.name)).toEqual(['dir1', 'dir2', 'dir10']);
    expect(tree.files.map(file => file.name)).toEqual(['Éclair.ts', 'eclair.ts', 'file1.ts', 'File2.ts', 'file2.ts', 'file10.ts']);
    expect(collectRemoteGitFiles(tree).map(file => file.path)).toEqual([
      'dir1/file.ts', 'dir2/file.ts', 'dir10/file.ts',
      'Éclair.ts', 'eclair.ts', 'file1.ts', 'File2.ts', 'file2.ts', 'file10.ts',
    ]);
  });

  it('reuses the same hierarchy across collapse changes and keeps review order and counts', () => {
    const entries = [status('README.md'), status('src/App.tsx'), status('src/lib/api.ts'), status('src/lib/deep/file.ts')];
    const tree = buildRemoteGitTree(entries);
    const expanded = flattenRemoteGitTree(tree, new Set());
    const reviewFiles = collectRemoteGitFiles(tree);
    const src = tree.directories[0];
    const lib = src.directories[0];
    // Frozen child arrays ensure repeated flattening cannot sort the tree in place.
    Object.freeze(src.directories);
    Object.freeze(src.files);

    expect(flattenRemoteGitTree(tree, new Set(['src/lib', 'missing']))).toEqual([
      { kind: 'directory', key: 'directory:src', path: 'src', name: 'src', depth: 0, changeCount: 3 },
      { kind: 'directory', key: 'directory:src/lib', path: 'src/lib', name: 'lib', depth: 1, changeCount: 2 },
      { kind: 'file', key: 'file: M:src/App.tsx', name: 'App.tsx', depth: 1, status: entries[1] },
      { kind: 'file', key: 'file: M:README.md', name: 'README.md', depth: 0, status: entries[0] },
    ]);
    expect(flattenRemoteGitTree(tree, new Set(['src', 'src/lib']))).toEqual([expanded[0], expanded.at(-1)]);
    expect(flattenRemoteGitTree(tree, new Set())).toEqual(expanded);
    expect(tree.directories[0]).toBe(src);
    expect(src.directories[0]).toBe(lib);
    expect(collectRemoteGitFiles(tree)).toEqual(reviewFiles);
    expect(reviewFiles).toEqual([entries[3], entries[2], entries[1], entries[0]]);
  });

  it('preserves original status references, rename metadata, untracked badges, and row keys', () => {
    const renamed = Object.freeze(status('src/new.ts', { originalPath: 'old.ts', indexStatus: 'R', worktreeStatus: ' ' }));
    const untracked = Object.freeze(status('new.ts', { indexStatus: '?', worktreeStatus: '?' }));
    const tree = buildRemoteGitTree([untracked, renamed]);
    const rows = flattenRemoteGitTree(tree, new Set());
    const files = rows.flatMap(row => row.kind === 'file' ? [row.status] : []);

    expect(tree.directories[0].files[0].status).toBe(renamed);
    expect(tree.files[0].status).toBe(untracked);
    expect(files[0]).toBe(renamed);
    expect(files[1]).toBe(untracked);
    expect(collectRemoteGitFiles(tree)[0]).toBe(renamed);
    expect(collectRemoteGitFiles(tree)[1]).toBe(untracked);
    expect(rows.map(row => row.key)).toEqual(['directory:src', 'file:R :src/new.ts', 'file:??:new.ts']);
    expect(files.map(remoteGitStatusLabel)).toEqual(['R', '??']);
  });

  it('uses filtered status entries for both rows and navigation without counting hidden descendants', () => {
    const entries = [status('.env'), status('.hidden/file.ts'), status('src/.cache/file.ts'), status('src/visible.ts'), status('README.md')];
    const tree = buildRemoteGitTree(entries.filter(entry => !isRemoteHiddenPath(entry.path)));

    expect(tree.changeCount).toBe(2);
    expect(tree.directories[0].changeCount).toBe(1);
    expect(flattenRemoteGitTree(tree, new Set()).map(row => row.key)).toEqual([
      'directory:src', 'file: M:src/visible.ts', 'file: M:README.md',
    ]);
    expect(collectRemoteGitFiles(tree)).toEqual([entries[3], entries[4]]);
    expect(collectRemoteGitFiles(buildRemoteGitTree(entries))).toHaveLength(5);
  });

  it('handles empty status results and root-level files', () => {
    const empty = buildRemoteGitTree([]);
    expect(empty).toEqual({ path: '', name: '', changeCount: 0, directories: [], files: [] });
    expect(flattenRemoteGitTree(empty, new Set(['src']))).toEqual([]);
    expect(collectRemoteGitFiles(empty)).toEqual([]);

    const entries = [status('file10.ts'), status('file2.ts')];
    const tree = buildRemoteGitTree(entries);
    expect(tree.changeCount).toBe(2);
    expect(tree.directories).toEqual([]);
    expect(flattenRemoteGitTree(tree, new Set(['src'])).map(row => [row.key, row.depth])).toEqual([
      ['file: M:file2.ts', 0], ['file: M:file10.ts', 0],
    ]);
    expect(collectRemoteGitFiles(tree)).toEqual([entries[1], entries[0]]);
  });
});
