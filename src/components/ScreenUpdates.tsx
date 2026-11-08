import { memo, type ReactNode } from 'react';
import { ScreenVisibilityContext } from '../lib/screenVisibility';

interface Props {
  active: boolean;
  /** Allow retained content to prepare changed data without following parent renders. */
  updateKey?: unknown;
  children: () => ReactNode;
}

/** Keep a mounted screen's local state, but stop routine parent-driven updates.
 * Commit the hide transition so its effects/animations can deactivate first.
 * Reopening always renders the latest props; context changes still propagate.
 * Transport and session lifecycle owners must remain outside this boundary.
 */
export const ScreenUpdates = memo(
  function DeferredScreen({ active, children }: Props) {
    return (
      <ScreenVisibilityContext.Provider value={active}>
        {children()}
      </ScreenVisibilityContext.Provider>
    );
  },
  (previous, next) => !previous.active && !next.active &&
    Object.is(previous.updateKey, next.updateKey),
);
