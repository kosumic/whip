import { useLayoutEffect, useRef } from 'react';

/** Keep presentation callbacks stable while dispatching through committed props. */
export function useCommittedCallbacks<Props extends object>(props: Props): Props {
  const committed = useRef(props);
  const callbacks = useRef(new Map<keyof Props, (...args: unknown[]) => unknown>());
  useLayoutEffect(() => { committed.current = props; });
  const result = { ...props };
  for (const key of Object.keys(props) as (keyof Props)[]) {
    if (typeof props[key] !== 'function') continue;
    let callback = callbacks.current.get(key);
    if (!callback) {
      callback = (...args: unknown[]) => {
        const current = committed.current[key];
        return typeof current === 'function' ? Reflect.apply(current, undefined, args) : undefined;
      };
      callbacks.current.set(key, callback);
    }
    result[key] = callback as Props[typeof key];
  }
  return result;
}
