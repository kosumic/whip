import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CHAT_VIEWPORT_CAPACITY, PRIORITY_CHAT_VIEWPORT_CAPACITY, type ChatViewportState } from '../lib/chatViewportState';

// Keep the selected chat and its most recent neighbour ready for quick switching.
export { CHAT_VIEWPORT_CAPACITY } from '../lib/chatViewportState';

/** Only bounds mounted UI. Native transcript/terminal residency is independent. */
export function useChatViewportRetention(
  keys: readonly string[],
  activeKey: string | null,
  priorityKeys: readonly string[] = [],
) {
  const [recent, setRecent] = useState<readonly string[]>([]);
  const snapshots = useRef(new Map<string, ChatViewportState>());
  const live = useMemo(() => new Set(keys), [keys]);
  const ordered = recent.filter(key => live.has(key) && key !== activeKey);
  if (activeKey && live.has(activeKey)) ordered.push(activeKey);
  const retained = ordered.slice(-CHAT_VIEWPORT_CAPACITY);

  useLayoutEffect(() => {
    if (
      recent.length !== retained.length ||
      recent.some((key, index) => key !== retained[index])
    ) {
      setRecent(retained);
    }
    for (const key of snapshots.current.keys()) {
      if (!live.has(key)) snapshots.current.delete(key);
    }
  }, [recent, retained, live]);

  // Priority residency never changes the two-entry visit history.
  const priority = priorityKeys.slice(0, PRIORITY_CHAT_VIEWPORT_CAPACITY).filter(key => live.has(key));
  return { retained: new Set([...retained, ...priority]), snapshots: snapshots.current };
}
