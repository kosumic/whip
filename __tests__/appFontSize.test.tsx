import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Pressable, StyleSheet, Text as NativeText, TextInput } from 'react-native';
import { cssInterop, StyleSheet as InteropStyleSheet } from 'react-native-css-interop';
import { cssToReactNativeRuntime } from 'react-native-css-interop/css-to-rn';

import { AppFontScaleContext } from '../src/hooks/useAppFontScale';
import { Input } from '../src/components/ui/input';
import { Text } from '../src/components/ui/text';
import { Button } from '../src/components/ui/button';

// Exercise the same class-to-style resolution used by NativeWind on devices.
cssInterop(Pressable, { className: 'style' });
InteropStyleSheet.registerCompiled(cssToReactNativeRuntime(`
  .text-base { font-size: 16px; line-height: 24px; }
  .text-sm { font-size: 14px; line-height: 20px; }
  .text-\\[15px\\] { font-size: 15px; }
  .leading-5 { line-height: 20px; }
  .h-11 { height: 44px; }
  .py-2 { padding-top: 8px; padding-bottom: 8px; }
  .border { border-width: 1px; }
  .h-auto { height: auto; }
  .min-h-11 { min-height: 44px; }
  .min-w-0 { min-width: 0px; }
  .shrink { flex-shrink: 1; }
`));

let tree: ReactTestRenderer;
afterEach(() => act(() => tree?.unmount()));

test.each([0.8, 1, 1.5])('scales resolved class and inline text metrics at %s while preserving layout styles', scale => {
  act(() => {
    tree = create(<AppFontScaleContext.Provider value={scale}>
      <Text testID="label" className="text-[15px] leading-5" style={{ marginTop: 4, color: '#abcdef' }}>App text 中文</Text>
      <Text testID="custom" style={{ fontSize: 12, lineHeight: 18 }}>Custom</Text>
      <Text testID="terminal" appFontScaling={false} style={{ fontSize: 8, lineHeight: 11 }}>Terminal</Text>
    </AppFontScaleContext.Provider>);
  });
  const nativeStyle = (testID: string) => StyleSheet.flatten(tree.root.findAllByType(NativeText).find(node => node.props.testID === testID)!.props.style);
  expect(nativeStyle('label')).toMatchObject({ fontSize: 15 * scale, lineHeight: 20 * scale, marginTop: 4, color: '#abcdef' });
  expect(nativeStyle('custom')).toMatchObject({ fontSize: 12 * scale, lineHeight: 18 * scale });
  expect(nativeStyle('terminal')).toMatchObject({ fontSize: 8, lineHeight: 11 });
  const cjk = tree.root.findAllByType(NativeText).find(node => node.props.children === '中文')!;
  expect(StyleSheet.flatten(cjk.props.style)).not.toHaveProperty('fontSize');
});

test('changing size grows fixed-height inputs without remounting uncontrolled inputs', () => {
  const render = (scale: number) => <AppFontScaleContext.Provider value={scale}>
    <Input defaultValue="Unsaved draft 中文" />
  </AppFontScaleContext.Provider>;
  act(() => { tree = create(render(1)); });
  const input = tree.root.findByType(TextInput);
  expect(StyleSheet.flatten(input.props.style)).toMatchObject({ fontSize: 16, lineHeight: 20, height: 44 });
  act(() => { tree.update(render(1.5)); });
  expect(tree.root.findByType(TextInput)).toBe(input);
  expect(input.props.defaultValue).toBe('Unsaved draft 中文');
  expect(StyleSheet.flatten(input.props.style)).toMatchObject({ fontSize: 24, lineHeight: 30, height: 44, minHeight: 48 });
});

test('larger labels can wrap and grow buttons while preserving icon button dimensions', () => {
  const render = (scale: number) => <AppFontScaleContext.Provider value={scale}>
    <Button testID="text-button"><Text testID="button-label">A longer translated label</Text></Button>
    <Button testID="icon-button" size="icon" />
  </AppFontScaleContext.Provider>;
  act(() => { tree = create(render(1)); });
  const buttonStyle = (testID: string) => StyleSheet.flatten(tree.root.find(node => typeof node.type === 'string' && node.props.testID === testID).props.style);
  expect(buttonStyle('text-button')).toMatchObject({ height: 44 });
  act(() => { tree.update(render(1.5)); });
  expect(buttonStyle('text-button')).not.toHaveProperty('height');
  expect(buttonStyle('text-button')).toMatchObject({ minHeight: 44, paddingTop: 8, paddingBottom: 8 });
  expect(buttonStyle('icon-button')).toMatchObject({ height: 44 });
  const label = tree.root.findAllByType(NativeText).find(node => node.props.testID === 'button-label')!;
  expect(StyleSheet.flatten(label.props.style)).toMatchObject({ flexShrink: 1, minWidth: 0 });
});
