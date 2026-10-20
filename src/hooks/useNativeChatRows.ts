import { useEffect, useRef, useState } from 'react';
import { NativeChatRows, type ChatRowsSource, type ChatRowUpdate } from 'react-native-whip-ssh/src/chatRows';
import { ChatRowStore } from '../lib/nativeChatRows';
import type { AgentChatState } from '../agentChat';
import { operationalErrorDetails, recordOperationalDiagnostic } from '../services/operationalDiagnostics';

/** One outstanding poll per viewport. Updates may overtake JS transcript
 * delivery; stage them until their referenced objects have arrived. */
export function useNativeChatRows(source: ChatRowsSource | undefined, state: AgentChatState, working: boolean, expanded: ReadonlySet<string>) {
  const transcriptRevision = state.revision;
  const revisionToken = source?.type === 'conversation' ? state.transcript : transcriptRevision;
  // Tool/meta detail controls stay entirely in React, including their toggles.
  const expansionKey = JSON.stringify([...expanded].filter(id => {
    try { const key: unknown = JSON.parse(id); return Array.isArray(key) && key.length === 2 && key[1] === 'changes'; }
    catch { return false; }
  }).sort());
  const [store, setStore] = useState(() => new ChatRowStore());
  const [, render] = useState(0);
  const latest = useRef({ transcriptRevision, working, expansionKey });
  latest.current = { transcriptRevision, working, expansionKey };
  const refresh = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    const current = new ChatRowStore();
    setStore(current);
    if (!source) return;
    const fail = (error: unknown) => {
      current.error = 'The conversation could not be prepared. Reopen Chat View to retry.';
      recordOperationalDiagnostic('warn', 'Application', 'chat-row-projection-failed', operationalErrorDetails(error));
      render(value => value + 1);
    };
    let owner: NativeChatRows;
    try { owner = new NativeChatRows(source); } catch (error) { fail(error); return; }
    let disposed = false;
    let running = false;
    let pending = false;
    let staged: ChatRowUpdate | undefined;
    let recover = false;
    let recoveryAttempts = 0;
    let requestedRevision = latest.current.transcriptRevision ?? 0;
    const commit = () => {
      if (!staged) return;
      const revision = latest.current.transcriptRevision;
      if (revision !== undefined && staged.transcriptRevision > revision) return;
      const rows = current.rows;
      const wasReady = current.ready;
      const hadError = Boolean(current.error);
      recover = !current.apply(staged);
      staged = undefined;
      if (recover) {
        recoveryAttempts += 1;
        if (recoveryAttempts === 1) pending = true;
        else fail(new Error('Native row recovery returned an invalid patch'));
      } else {
        recoveryAttempts = 0;
        current.error = undefined;
        if (rows !== current.rows || !wasReady || hadError) render(value => value + 1);
      }
    };
    const poll = async () => {
      pending = false;
      const revision = latest.current.transcriptRevision ?? 0;
      if (revision < requestedRevision) {
        // Restored/replaced sources can restart their transcript revision.
        // Discard a staged response from the previous source incarnation.
        staged = undefined;
        recover = true;
      }
      requestedRevision = revision;
      commit();
      if (staged) return;
      running = true;
      const input = latest.current;
      try {
        const update = await owner.poll(recover ? 0 : current.revision, input.transcriptRevision ?? 0, input.working, JSON.parse(input.expansionKey) as string[]);
        if (!disposed) {
          staged = update;
          commit();
        }
      } catch (error) {
        if (!disposed) fail(error);
      } finally {
        running = false;
        if (pending && !disposed) void poll();
      }
    };
    refresh.current = () => {
      if (running) pending = true;
      else void poll();
    };
    return () => {
      disposed = true;
      refresh.current = undefined;
      owner.dispose();
    };
  }, [source]);
  useEffect(() => { refresh.current?.(); }, [source, transcriptRevision, revisionToken, working, expansionKey]);
  return store;
}
