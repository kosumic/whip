import type { ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { HerdScreen, MoreScreen } from '../src/components/deferredScreens';

const mockMoreInitialized = jest.fn();
const mockHerdInitialized = jest.fn();

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));
jest.mock('../src/components/MoreScreen', () => {
  mockMoreInitialized();
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    MoreScreen: ({ openAiConfigRequest }: { openAiConfigRequest: number }) => {
      const [expanded, setExpanded] = React.useState(false);
      return React.createElement('SettingsPage', {
        openAiConfigRequest,
        expanded,
        onToggle: () => setExpanded(value => !value),
      });
    },
  };
});
jest.mock('../src/components/HerdScreen', () => {
  mockHerdInitialized();
  return { HerdScreen: 'HerdPage' };
});

test('unvisited screens stay uninitialized, while an opened screen retains state and receives updated props', () => {
  expect(mockMoreInitialized).not.toHaveBeenCalled();
  expect(mockHerdInitialized).not.toHaveBeenCalled();
  const props = { openAiConfigRequest: 1 } as ComponentProps<typeof MoreScreen>;
  let view!: ReactTestRenderer;
  try {
    act(() => { view = create(<MoreScreen {...props} />); });
    expect(mockMoreInitialized).toHaveBeenCalledTimes(1);
    expect(mockHerdInitialized).not.toHaveBeenCalled();
    act(() => { view.root.findByType('SettingsPage' as never).props.onToggle(); });
    act(() => view.update(<MoreScreen {...props} openAiConfigRequest={2} />));
    expect(view.root.findByType('SettingsPage' as never).props).toMatchObject({
      expanded: true,
      openAiConfigRequest: 2,
    });
    expect(mockMoreInitialized).toHaveBeenCalledTimes(1);
    act(() => view.update(<HerdScreen {...{} as ComponentProps<typeof HerdScreen>} />));
    expect(mockHerdInitialized).toHaveBeenCalledTimes(1);
    expect(view.root.findAllByType('HerdPage' as never)).toHaveLength(1);
  } finally {
    act(() => view?.unmount());
  }
});
