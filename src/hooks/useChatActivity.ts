import { useEffect, useState } from 'react';

export const CHAT_TOOL_ACTIVITY_MIN_MS = 3_000;

export interface ChatActivity {
  title: string;
  detail: string;
}

export interface ChatToolActivity {
  id: string;
  activity: ChatActivity;
}

interface HeldTool extends ChatToolActivity {
  scope: string;
  until: number;
}

/** Keep brief calls readable without retaining them in transcript history. */
export function useChatActivity(
  enabled: boolean,
  scope: string,
  summary: ChatActivity | undefined,
  tool: ChatToolActivity | undefined,
): ChatActivity | undefined {
  const [held, setHeld] = useState<HeldTool>();
  useEffect(() => {
    if (!enabled || held && held.scope !== scope && !tool) {
      setHeld(undefined);
      return;
    }
    if (tool) {
      setHeld(current => {
        if (current?.scope === scope && current.id === tool.id) {
          return current.activity.title === tool.activity.title && current.activity.detail === tool.activity.detail
            ? current : { ...current, activity: tool.activity };
        }
        return { ...tool, scope, until: Date.now() + CHAT_TOOL_ACTIVITY_MIN_MS };
      });
      return;
    }
    if (!held) return;
    const remaining = held.until - Date.now();
    if (remaining <= 0) {
      setHeld(undefined);
      return;
    }
    const timer = setTimeout(() => setHeld(current => current === held ? undefined : current), remaining);
    return () => clearTimeout(timer);
  }, [enabled, scope, tool, held]);
  if (!enabled) return undefined;
  return tool?.activity ?? (held?.scope === scope ? held.activity : summary);
}
