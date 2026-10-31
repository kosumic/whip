const mockNative = {
  readTerminals: jest.fn(() => ({
    terminals: jest.fn().mockResolvedValue({
      resumeBlob: 'opaque native resume',
      fontSizes: [{ terminalId: 'term', size: 11 }],
      invalidFonts: false,
    }),
  })),
};
jest.mock('../src/services/sessionPersistence', () => ({
  sessionPersistence: () => mockNative,
  terminalStorageEffect: (
    _kind: string,
    _host: string,
    effect: () => Promise<unknown>,
  ) => effect(),
}));
import { loadPersistedTerminals } from '../src/services/persistedTerminals';
beforeEach(() => jest.clearAllMocks());

test('converts the typed native font projection into a presentation map', async () => {
  expect(await loadPersistedTerminals('host')).toEqual({
    resumeBlob: 'opaque native resume',
    fontSizes: new Map([['term', 11]]),
  });
  expect(mockNative.readTerminals).toHaveBeenCalledWith('host');
});

test('native read failures propagate without exposing the resume blob', async () => {
  mockNative.readTerminals.mockReturnValueOnce({
    terminals: jest.fn().mockRejectedValue(new Error('read unavailable')),
  });
  await expect(loadPersistedTerminals('host')).rejects.toThrow(
    'read unavailable',
  );
});
