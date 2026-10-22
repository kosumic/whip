import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useHerdrInstallation } from '../src/hooks/useHerdrInstallation';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function host() {
  const operation = deferred();
  let output!: (text: string) => void;
  const native = {
    herdrSetup: jest.fn(async () => ({ status: 'missing', installCommand: 'official installer' })),
    installHerdr: jest.fn((callback: (text: string) => void) => {
      output = callback;
      return operation.promise;
    }),
  };
  return { operation, native, emit: (text: string) => output(text) };
}

let renderer: ReactTestRenderer;
let controller: ReturnType<typeof useHerdrInstallation>;
afterEach(() => act(() => renderer?.unmount()));

function mount() {
  const first = host();
  const second = host();
  const runtimesRef = { current: new Map([
    ['one', { client: { activeNative: first.native } }],
    ['two', { client: { activeNative: second.native } }],
  ]) };
  function Harness({ selectedHost }: { selectedHost: string }) {
    controller = useHerdrInstallation({ runtimesRef } as unknown as Parameters<typeof useHerdrInstallation>[0]);
    return <>{selectedHost}</>;
  }
  act(() => { renderer = create(<Harness selectedHost="one" />); });
  return { first, second, runtimesRef, navigate: (selectedHost: string) => renderer.update(<Harness selectedHost={selectedHost} />) };
}

test('keeps installs independent while navigating to and using another host', async () => {
  const { first, second, navigate } = mount();
  let one!: Promise<void>;
  let two!: Promise<void>;
  act(() => {
    one = controller.installHerdr('one', 'command one');
    expect(controller.installHerdr('one', 'command one')).toBe(one);
  });
  act(() => navigate('two'));
  await act(async () => {
    expect(await controller.checkHerdr('two')).toEqual({ status: 'missing', installCommand: 'official installer' });
    two = controller.installHerdr('two', 'command two');
    first.emit('download in progress\n');
    second.emit('installed on two\n');
    second.operation.resolve();
    await two;
  });
  expect(controller.installations.one).toMatchObject({ phase: 'installing', output: 'download in progress\n' });
  expect(controller.installations.two).toMatchObject({ phase: 'succeeded', output: 'installed on two\n', command: 'command two' });
  expect(first.native.installHerdr).toHaveBeenCalledTimes(1);
  act(() => navigate('one'));
  await act(async () => {
    first.emit('Herdr is ready.\n');
    first.operation.resolve();
    await one;
  });
  expect(controller.installations.one).toMatchObject({ phase: 'succeeded', output: 'Herdr is ready.\n', command: 'command one' });
});

test('retains failure output without retrying the install', async () => {
  const { first } = mount();
  await act(async () => {
    const install = controller.installHerdr('one', 'installer');
    first.emit('download failed\n');
    first.operation.reject(new Error('network unavailable'));
    await install;
  });
  expect(controller.installations.one).toMatchObject({ phase: 'failed', output: 'download failed\n', error: 'Error: network unavailable' });
  expect(first.native.installHerdr).toHaveBeenCalledTimes(1);
});

test('ignores late progress from a closed or replaced host runtime', async () => {
  const { first, runtimesRef } = mount();
  let install!: Promise<void>;
  act(() => { install = controller.installHerdr('one', 'installer'); });
  runtimesRef.current.delete('one');
  await act(async () => {
    first.emit('stale output');
    first.operation.resolve();
    await install;
  });
  expect(controller.installations.one.output).toBe('');
});
