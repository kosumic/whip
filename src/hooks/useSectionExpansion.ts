import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useRef, useState } from 'react';

import { reportBackgroundFailure } from '../services/backgroundOperations';

/** Persists presentation state independently from the settings inside a section. */
export function useSectionExpansion(
  section: 'usage' | 'notifications' | 'appearance',
  defaultExpanded = false,
) {
  const storageKey = `whip.${section}.expanded.v1`;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const expandedRef = useRef(defaultExpanded);
  const expansionChanged = useRef(false);

  useEffect(() => {
    let active = true;
    reportBackgroundFailure(
      AsyncStorage.getItem(storageKey).then(value => {
        if (active && !expansionChanged.current) {
          const next = value === null ? defaultExpanded : value === 'true';
          expandedRef.current = next;
          setExpanded(next);
        }
      }),
      `${section}-expansion-load`,
    );
    return () => {
      active = false;
    };
  }, [defaultExpanded, section, storageKey]);

  const toggleExpanded = () => {
    const next = !expandedRef.current;
    expansionChanged.current = true;
    expandedRef.current = next;
    setExpanded(next);
    reportBackgroundFailure(
      AsyncStorage.setItem(storageKey, String(next)),
      `${section}-expansion-persist`,
    );
  };

  return { expanded, toggleExpanded };
}
