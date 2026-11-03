export const MIN_XTERM_CACHE_CAPACITY = 3;
export const DEFAULT_XTERM_CACHE_CAPACITY = 20;

export function terminalCacheCapacity(capacity: number): number {
  return Number.isSafeInteger(capacity) && capacity >= MIN_XTERM_CACHE_CAPACITY
    ? capacity : DEFAULT_XTERM_CACHE_CAPACITY;
}

export function touchTerminalRendererEntry<T>(
  entries: Map<string, T>,
  key: string,
): T | undefined {
  if (!entries.has(key)) return undefined;
  const entry = entries.get(key) as T;
  entries.delete(key);
  entries.set(key, entry);
  return entry;
}

export function terminalRendererEvictionKeys(
  keys: readonly string[],
  capacity: number,
  protectedKeys: ReadonlySet<string>,
): string[] {
  const normalizedCapacity = terminalCacheCapacity(capacity);
  const protectedCount = keys.reduce(
    (count, key) => count + (protectedKeys.has(key) ? 1 : 0),
    0,
  );
  const targetSize = Math.max(normalizedCapacity, protectedCount);
  let remaining = keys.length;
  const evictions: string[] = [];
  for (const key of keys) {
    if (remaining <= targetSize) break;
    if (protectedKeys.has(key)) continue;
    evictions.push(key);
    remaining -= 1;
  }
  return evictions;
}
