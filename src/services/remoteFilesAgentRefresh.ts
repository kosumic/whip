import type { RuntimeAgentStatusTransition } from 'react-native-whip-ssh';
import type { HerdrSnapshot } from '../types';
import type { HerdrClient } from './HerdrClient';
import { refreshCachedRemoteDirectories } from './remoteDirectoryQueries';
import { cachedRemoteGitRepository, refreshCachedRemoteGitState, remoteConnectionRequest } from './remoteGitQueries';

/** Completion events refresh known data; opening Herd never probes unknown directories. */
export async function refreshRemoteFilesOnAgentDone(client: HerdrClient, snapshot: HerdrSnapshot, transitions: RuntimeAgentStatusTransition[]) {
  const completed = transitions.filter(transition => transition.previous
    && transition.previous !== 'done' && transition.current === 'done');
  if (!completed.length || !client.activeNative) return;
  const connection = remoteConnectionRequest(client);
  if (!connection.isCurrent()) return;
  const roots = new Map<string, { git: boolean; paths: Set<string> }>();
  for (const transition of completed) {
    const pane = snapshot.agents.find(agent => agent.pane_id === transition.paneId)
      ?? snapshot.panes.find(agent => agent.pane_id === transition.paneId);
    const path = pane?.foreground_cwd || pane?.cwd;
    if (!path) continue;
    const repository = cachedRemoteGitRepository(connection, path);
    const root = repository?.root ?? path;
    const entry = roots.get(root) ?? { git: Boolean(repository), paths: new Set<string>() };
    entry.paths.add(path);
    roots.set(root, entry);
  }
  await Promise.all([...roots].map(async ([root, entry]) => {
    await Promise.all([
      refreshCachedRemoteDirectories(connection, root, entry.paths),
      ...(entry.git ? [refreshCachedRemoteGitState(connection, root)] : []),
    ]);
  }));
}
