import type { RuntimeGitDiff, RuntimeGitRepository, RuntimeGitStatusEntry } from 'react-native-whip-ssh';

export type RemoteGitRepository = RuntimeGitRepository;
export type RemoteGitStatusEntry = RuntimeGitStatusEntry;
export type RemoteGitDiff = RuntimeGitDiff;
export type RemoteGitDiffRow = RuntimeGitDiff['rows'][number];

export interface RemoteGitTreeDirectoryRow {
  kind: 'directory';
  key: string;
  path: string;
  name: string;
  depth: number;
  changeCount: number;
}

export interface RemoteGitTreeFileRow {
  kind: 'file';
  key: string;
  name: string;
  depth: number;
  status: RemoteGitStatusEntry;
}

export type RemoteGitTreeRow = RemoteGitTreeDirectoryRow | RemoteGitTreeFileRow;

/** A sorted hierarchy shared by the visible rows and file review navigation. */
export interface RemoteGitTree {
  readonly path: string;
  readonly name: string;
  readonly changeCount: number;
  readonly directories: readonly RemoteGitTree[];
  readonly files: readonly { readonly name: string; readonly status: RemoteGitStatusEntry }[];
}

const gitTreeCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export function buildRemoteGitTree(
  statuses: readonly RemoteGitStatusEntry[],
): RemoteGitTree {
  const root = gitTreeDirectory('', '');
  for (const status of statuses) {
    const parts = status.path.split('/');
    const name = parts.pop() || status.path;
    let directory = root;
    for (const part of parts) {
      const path = directory.path ? `${directory.path}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = gitTreeDirectory(path, part);
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({ name, status });
  }

  return finalizeGitTree(root);
}

export function flattenRemoteGitTree(
  tree: RemoteGitTree,
  collapsedPaths: ReadonlySet<string>,
): RemoteGitTreeRow[] {
  const rows: RemoteGitTreeRow[] = [];
  appendGitTreeRows(tree, 0, collapsedPaths, rows);
  return rows;
}

/** Collect every file in display order, including collapsed descendants. */
export function collectRemoteGitFiles(tree: RemoteGitTree): RemoteGitStatusEntry[] {
  const files: RemoteGitStatusEntry[] = [];
  const appendFiles = (directory: RemoteGitTree) => {
    for (const child of directory.directories) appendFiles(child);
    for (const file of directory.files) files.push(file.status);
  };
  appendFiles(tree);
  return files;
}

export function buildRemoteGitTreeRows(
  statuses: readonly RemoteGitStatusEntry[],
  collapsedPaths: ReadonlySet<string>,
): RemoteGitTreeRow[] {
  return flattenRemoteGitTree(buildRemoteGitTree(statuses), collapsedPaths);
}

export function remoteGitStatusLabel(status: RemoteGitStatusEntry): string {
  if (isRemoteGitEntryUntracked(status)) return '??';
  const codes = [status.indexStatus, status.worktreeStatus].filter(
    code => code !== ' ',
  );
  return codes.join('') || 'M';
}

export function isRemoteGitEntryUntracked(
  status: RemoteGitStatusEntry,
): boolean {
  return status.indexStatus === '?' && status.worktreeStatus === '?';
}

export function isRemoteGitEntryDeleted(status: RemoteGitStatusEntry): boolean {
  return status.indexStatus === 'D' || status.worktreeStatus === 'D';
}

interface MutableGitTreeDirectory {
  path: string;
  name: string;
  directories: Map<string, MutableGitTreeDirectory>;
  files: Array<{ name: string; status: RemoteGitStatusEntry }>;
}

function gitTreeDirectory(path: string, name: string): MutableGitTreeDirectory {
  return {
    path,
    name,
    directories: new Map(),
    files: [],
  };
}

function finalizeGitTree(directory: MutableGitTreeDirectory): RemoteGitTree {
  const directories = [...directory.directories.values()]
    .map(finalizeGitTree)
    .sort((first, second) => gitTreeCollator.compare(first.name, second.name));
  const files = directory.files;
  files.sort((first, second) =>
    gitTreeCollator.compare(first.name, second.name),
  );
  return {
    path: directory.path,
    name: directory.name,
    changeCount: files.length + directories.reduce((count, child) => count + child.changeCount, 0),
    directories,
    files,
  };
}

function appendGitTreeRows(
  directory: RemoteGitTree,
  depth: number,
  collapsedPaths: ReadonlySet<string>,
  rows: RemoteGitTreeRow[],
): void {
  for (const child of directory.directories) {
    rows.push({
      kind: 'directory',
      key: `directory:${child.path}`,
      path: child.path,
      name: child.name,
      depth,
      changeCount: child.changeCount,
    });
    if (!collapsedPaths.has(child.path)) {
      appendGitTreeRows(child, depth + 1, collapsedPaths, rows);
    }
  }

  for (const file of directory.files) {
    rows.push({
      kind: 'file',
      key: `file:${file.status.indexStatus}${file.status.worktreeStatus}:${file.status.path}`,
      name: file.name,
      depth,
      status: file.status,
    });
  }
}
