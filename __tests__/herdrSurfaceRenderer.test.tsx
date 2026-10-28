import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { TerminalRendererHost } from '../src/components/TerminalRenderer';
import type { TerminalRendererProps } from '../src/components/TerminalRendererHost';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
}));

jest.mock('../src/components/TerminalRendererHost', () => {
  const R: typeof React = require('react');
  const {
    TerminalResidencyEndReason,
  } = require('../src/lib/terminalResidency');
  return {
    TerminalRendererHost: R.forwardRef(
      (props: TerminalRendererProps, _ref: unknown) => {
        R.useEffect(
          () => () =>
            props.onResidencyEnd?.(
              props.activeTarget!,
              TerminalResidencyEndReason.Evicted,
            ),
          [],
        );
        return R.createElement(
          'Xterm',
          props as unknown as Record<string, unknown>,
        );
      },
    ),
  };
});
jest.mock('../src/components/SkiaTerminalRenderer', () => {
  const R: typeof React = require('react');
  return {
    __esModule: true,
    default: R.forwardRef((props, _ref) => R.createElement('Skia', props)),
  };
});
function rendererProps(
  renderer: 'xterm.js' | 'skia',
  kind = 'herdr',
  onResidencyEnd = jest.fn(),
): TerminalRendererProps {
  return {
    preferences: { herdrRenderer: renderer },
    activeTarget: { key: 'pane', session: { paneId: '1-1', kind } },
    onResidencyEnd,
  } as unknown as TerminalRendererProps;
}
it('keeps ordinary SSH panes on xterm with the experimental flag enabled', async () => {
  let root: ReactTestRenderer;
  await act(async () => {
    root = create(<TerminalRendererHost {...rendererProps('skia', 'ssh')} />);
  });
  expect(
    root!.root.findAll(node => String(node.type) === 'Xterm'),
  ).toHaveLength(1);
  expect(root!.root.findAll(node => String(node.type) === 'Skia')).toHaveLength(
    0,
  );
  await act(async () => root!.unmount());
});
it('switches a Herdr pane without evicting its independently owned transcript and recovers to xterm', async () => {
  let root: ReactTestRenderer;
  const evicted = jest.fn();
  await act(async () => {
    root = create(
      <TerminalRendererHost {...rendererProps('xterm.js', 'herdr', evicted)} />,
    );
  });
  await act(async () =>
    root!.update(
      <TerminalRendererHost {...rendererProps('skia', 'herdr', evicted)} />,
    ),
  );
  expect(root!.root.findAll(node => String(node.type) === 'Skia')).toHaveLength(
    1,
  );
  expect(
    root!.root.findAll(node => String(node.type) === 'Xterm'),
  ).toHaveLength(0);
  expect(evicted).not.toHaveBeenCalled();
  const skia = root!.root.find(node => String(node.type) === 'Skia');
  await act(async () => skia.props.onUseXterm());
  expect(
    root!.root.findAll(node => String(node.type) === 'Xterm'),
  ).toHaveLength(1);
  await act(async () => root!.unmount());
  expect(evicted).toHaveBeenCalledTimes(1);
});
