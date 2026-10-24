import { buttonVariants } from '../src/components/ui/button';

jest.mock('react-native-css-interop/jsx-runtime', () =>
  jest.requireActual('react/jsx-runtime'),
);
jest.mock('react-native', () => ({
  Platform: { select: (options: { default?: unknown }) => options.default },
  Pressable: 'Pressable',
}));
jest.mock(
  '@/src/components/ui/text',
  () => ({
    TextClassContext: jest.requireActual('react').createContext(undefined),
  }),
);
jest.mock(
  '@/src/lib/utils',
  () => ({
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(' '),
  }),
);

describe('button layout', () => {
  test('native variants stay at least 44pt without tablet-width shrinking', () => {
    const classNames = buttonVariants().split(/\s+/);

    expect(classNames).toEqual(
      expect.arrayContaining(['h-11', 'min-h-11', 'min-w-11', 'px-4', 'py-0']),
    );
    expect(classNames).not.toContain('py-2');
    expect(classNames.some(className => className.startsWith('sm:'))).toBe(false);
  });

  test.each([
    ['default', 'h-11'],
    ['sm', 'h-11'],
    ['lg', 'h-12'],
  ] as const)('native %s buttons have an adequate fixed height', (size, height) => {
    const classNames = buttonVariants({ size }).split(/\s+/);

    expect(classNames).toEqual(expect.arrayContaining(['min-h-11', 'min-w-11', height]));
    expect(classNames.some(className => className.startsWith('sm:'))).toBe(false);
  });

  test('native icon buttons resolve to a 44pt square', () => {
    const classNames = buttonVariants({ size: 'icon' }).split(/\s+/);

    expect(classNames).toEqual(
      expect.arrayContaining(['h-11', 'w-11', 'min-h-11', 'min-w-11']),
    );
    expect(classNames.some(className => className.startsWith('sm:'))).toBe(false);
  });
});
