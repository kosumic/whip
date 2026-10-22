import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useHerdrInstallation } from '../src/hooks/useHerdrInstallation';

jest.mock('react-native-css-interop/jsx-runtime', () => jest.requireActual('react/jsx-runtime'));

function host() {
  let resolve!: (outcome: 'succeeded' | 'cancelled') => void;
  let reject!: (error: Error) => void;
  const operation = new Promise<'succeeded' | 'cancelled'>((done, fail) => { resolve = done; reject = fail; });
  const native = {
    herdrSetup: jest.fn(async () => ({ status: 'missing' as const, installCommand: 'official installer' })),
    prepareHerdrInstallation: jest.fn(),
    installHerdr: jest.fn(() => operation),
  };
  return { native, resolve, reject };
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
  let sequence = 0;
  const tabs = new Map<string, string[]>();
  const terminals = {
    openSshShell: jest.fn((sessionId: string, _title: string, prepare: (id: string) => void) => {
      const id = `shell-${++sequence}`;
      prepare(id);
      tabs.set(sessionId, [...tabs.get(sessionId) ?? [], id]);
      return id;
    }),
    selectSshShell: jest.fn(),
    get: (id: string) => ({ sessions: (tabs.get(id) ?? []).map(terminalId => ({ terminalId })) }),
  };
  const select = jest.fn();
  const navigation = { selectPane: jest.fn() };
  const t = (key: string) => key;
  function Harness({ selectedHost }: { selectedHost: string }) {
    controller = useHerdrInstallation({ runtimesRef, terminals, select, navigation, t } as unknown as Parameters<typeof useHerdrInstallation>[0]);
    return <>{selectedHost}</>;
  }
  act(() => { renderer = create(<Harness selectedHost="one" />); });
  return { first, second, runtimesRef, terminals, tabs, select, navigate: (selectedHost: string) => renderer.update(<Harness selectedHost={selectedHost} />) };
}

test('runs independently on each host in one prepared SSH terminal tab', async () => {
  const { first, second, terminals, select, navigate } = mount();
  let one!: Promise<void>;
  let two!: Promise<void>;
  act(() => {
    one = controller.installHerdr('one');
    expect(controller.installHerdr('one')).toBe(one);
  });
  expect(terminals.openSshShell).toHaveBeenCalledTimes(1);
  expect(first.native.prepareHerdrInstallation).toHaveBeenCalledWith('shell-1');
  expect(first.native.installHerdr).toHaveBeenCalledWith('shell-1');
  expect(select).toHaveBeenLastCalledWith('one', 'terminal');
  act(() => navigate('two'));
  await act(async () => {
    expect(await controller.checkHerdr('two')).toEqual({ status: 'missing', installCommand: 'official installer' });
    two = controller.installHerdr('two');
    second.resolve('succeeded');
    await two;
  });
  expect(controller.installations.one).toEqual({ phase: 'installing', terminalId: 'shell-1' });
  expect(controller.installations.two).toEqual({ phase: 'succeeded', terminalId: 'shell-2' });
  await act(async () => { first.resolve('succeeded'); await one; });
  expect(controller.installations.one.phase).toBe('succeeded');
});

test('Open terminal selects the same tab without running the installer again', () => {
  const { terminals, first, select, navigate } = mount();
  act(() => { void controller.installHerdr('one'); });
  act(() => navigate('two'));
  act(() => { controller.openHerdrInstallation('one'); });
  expect(terminals.selectSshShell).toHaveBeenCalledWith('one', 'shell-1');
  expect(select).toHaveBeenLastCalledWith('one', 'terminal');
  expect(terminals.openSshShell).toHaveBeenCalledTimes(1);
  expect(first.native.installHerdr).toHaveBeenCalledTimes(1);
});

test.each(['cancelled', 'failed'] as const)('clears installing state after terminal reports %s without an automatic retry', async phase => {
  const { first } = mount();
  await act(async () => {
    const install = controller.installHerdr('one');
    if (phase === 'failed') first.reject(new Error('Installer failed; review terminal output'));
    else first.resolve('cancelled');
    await install;
  });
  expect(controller.installations.one).toMatchObject({ phase, terminalId: 'shell-1' });
  expect(first.native.installHerdr).toHaveBeenCalledTimes(1);
});

test('ignores completion from a replaced or closed host runtime', async () => {
  const { first, runtimesRef, navigate } = mount();
  let install!: Promise<void>;
  act(() => { install = controller.installHerdr('one'); });
  runtimesRef.current.delete('one');
  await act(async () => { first.resolve('succeeded'); await install; navigate('two'); });
  expect(controller.installations.one).toBeUndefined();
});

test('drops the link after its terminal tab is closed', async () => {
  const { first, terminals, tabs } = mount();
  await act(async () => {
    const install = controller.installHerdr('one');
    tabs.delete('one');
    first.reject(new Error('Installation terminal was closed'));
    await install;
  });
  expect(controller.installations.one).toBeUndefined();
  act(() => { controller.openHerdrInstallation('one'); });
  expect(terminals.selectSshShell).not.toHaveBeenCalled();
});
