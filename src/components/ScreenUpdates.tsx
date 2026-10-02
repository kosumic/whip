import { memo, type ReactNode } from 'react';

interface Props {
  active: boolean;
  children: () => ReactNode;
}

/** Keep a mounted screen's local state, but stop routine parent-driven updates.
 * Commit the hide transition so its effects/animations can deactivate first.
 * Reopening always renders the latest props; context changes still propagate.
 * Transport and session lifecycle owners must remain outside this boundary.
 */
export const ScreenUpdates = memo(
  function DeferredScreen({ children }: Props) {
    return children();
  },
  (previous, next) => !previous.active && !next.active,
);
