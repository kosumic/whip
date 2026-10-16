import { useState, useSyncExternalStore, type SetStateAction } from 'react';

/** One value for rendering and synchronous native callbacks, including batched events. */
export function useSynchronousState<T>(initialValue: T) {
  const [store] = useState(() => {
    let current = initialValue;
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      set: (next: SetStateAction<T>) => {
        const value = typeof next === 'function'
          ? (next as (previous: T) => T)(current)
          : next;
        if (Object.is(current, value)) return;
        current = value;
        for (const listener of listeners) listener();
      },
    };
  });
  const value = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return [value, store.getSnapshot, store.set] as const;
}
