import { appStorage } from '../src/services/appStorage';

import {
  REMOTE_FILE_PREFERENCES_KEY,
  defaultRemoteFilePreferences,
  loadRemoteFilePreferences,
  saveRemoteFilePreferences,
} from '../src/services/remoteFilePreferences';

jest.mock('../src/services/appStorage', () => ({
  __esModule: true,
  appStorage: {
    getItem: jest.fn(),
    setItem: jest.fn(),
  },
}));

const getItem = appStorage.getItem as jest.MockedFunction<
  typeof appStorage.getItem
>;
const setItem = appStorage.setItem as jest.MockedFunction<
  typeof appStorage.setItem
>;

beforeEach(() => {
  jest.clearAllMocks();
});

it('hides dotfiles by default when no preference has been saved', async () => {
  getItem.mockResolvedValue(null);

  await expect(loadRemoteFilePreferences()).resolves.toEqual({
    showHiddenFiles: false,
    sortField: 'name',
    sortDirection: 'ascending',
  });
});

it('loads persisted hidden-file and sorting preferences', async () => {
  getItem.mockResolvedValue(
    JSON.stringify({
      showHiddenFiles: false,
      sortField: 'modified',
      sortDirection: 'descending',
    }),
  );

  await expect(loadRemoteFilePreferences()).resolves.toEqual({
    showHiddenFiles: false,
    sortField: 'modified',
    sortDirection: 'descending',
  });
  expect(getItem).toHaveBeenCalledWith(REMOTE_FILE_PREFERENCES_KEY);
});

it('falls back safely for missing or invalid fields', async () => {
  getItem.mockResolvedValue(
    JSON.stringify({
      showHiddenFiles: 'yes',
      sortField: 'extension',
      sortDirection: 'sideways',
    }),
  );

  await expect(loadRemoteFilePreferences()).resolves.toEqual(
    defaultRemoteFilePreferences,
  );
});

it('persists the complete preference object', async () => {
  const preferences = {
    showHiddenFiles: false,
    sortField: 'size' as const,
    sortDirection: 'descending' as const,
  };

  await saveRemoteFilePreferences(preferences);

  expect(setItem).toHaveBeenCalledWith(
    REMOTE_FILE_PREFERENCES_KEY,
    JSON.stringify(preferences),
  );
});
