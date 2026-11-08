import { useCallback, useState } from 'react';
import type { ListViewToken } from 'react-native';

export const ANIMATION_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 1 };

/** Only publish changes when rows enter or leave the viewport. */
export function useViewableKeys() {
  const [viewableKeys, setViewableKeys] = useState<ReadonlySet<string>>(() => new Set());
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    const next = new Set(viewableItems.filter(item => item.isViewable).map(item => item.key));
    setViewableKeys(previous => previous.size === next.size && [...next].every(key => previous.has(key))
      ? previous : next);
  }, []);
  return { viewableKeys, onViewableItemsChanged };
}
