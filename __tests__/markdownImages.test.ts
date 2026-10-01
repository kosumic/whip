import { fetch } from 'expo/fetch';
import { renderMarkdownSvg } from 'react-native-whip-ssh';

import { cacheWebMarkdownSvg } from '../src/services/markdownImages';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('react-native-whip-ssh', () => ({ renderMarkdownSvg: jest.fn() }));
jest.mock('../src/services/backgroundOperations', () => ({
  bestEffortCleanup: (promise: Promise<unknown>) => { void promise; },
}));
const mockWrite = jest.fn();
const mockDelete = jest.fn();
const mockCreate = jest.fn();
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: class {
    uri: string;
    exists = true;
    constructor(parent: string, name: string) { this.uri = `${parent}/${name}`; }
    create = mockCreate;
    delete = mockDelete;
  },
  File: class {
    uri: string;
    constructor(parent: { uri: string }, name: string) { this.uri = `${parent.uri}/${name}`; }
    write = mockWrite;
  },
}));

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
const cancel = jest.fn().mockResolvedValue(undefined);
const signal = new AbortController().signal;

function response(chunks: Uint8Array[], mime = 'image/svg+xml') {
  const read = jest.fn();
  for (const value of chunks) read.mockResolvedValueOnce({ done: false, value });
  read.mockResolvedValue({ done: true });
  return {
    ok: true, headers: new Map([['content-type', mime]]),
    body: { cancel, getReader: () => ({ read, cancel }) },
  } as unknown as Awaited<ReturnType<typeof fetch>>;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(renderMarkdownSvg).mockResolvedValue('cG5n');
  jest.mocked(fetch).mockResolvedValue(response([new TextEncoder().encode(svg)]));
});

test('identifies extensionless web SVGs by MIME and caches the rendered PNG', async () => {
  const cached = await cacheWebMarkdownSvg('https://img.shields.io/badge/build-passing', signal, 1024);
  expect(fetch).toHaveBeenCalledWith('https://img.shields.io/badge/build-passing', { signal: expect.any(AbortSignal) });
  expect(renderMarkdownSvg).toHaveBeenCalledWith(svg);
  expect(mockWrite).toHaveBeenCalledWith('cG5n', { encoding: 'base64' });
  expect(cached?.uri).toMatch(/^file:\/\/\/cache\/.*\/markdown-image\.png$/);
  expect(cached?.sourceBytes).toBe(svg.length);
  cached?.dispose();
  expect(mockDelete).toHaveBeenCalledTimes(1);
});

test('cancels non-SVG responses and leaves known bitmap URLs to the native renderer', async () => {
  jest.mocked(fetch).mockResolvedValue(response([], 'image/png'));
  expect(await cacheWebMarkdownSvg('https://example.com/image', signal, 1024)).toBeNull();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(await cacheWebMarkdownSvg('https://example.com/image.png', signal, 1024)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(renderMarkdownSvg).not.toHaveBeenCalled();
});

test('bounds downloaded bytes before rasterization, including chunked responses', async () => {
  jest.mocked(fetch).mockResolvedValue(response([new Uint8Array(8), new Uint8Array(8)]));
  await expect(cacheWebMarkdownSvg('https://example.com/image.svg', signal, 10)).rejects.toThrow('size limit');
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(renderMarkdownSvg).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

test('does not create cache files if the preview closes during web SVG rendering', async () => {
  const controller = new AbortController();
  jest.mocked(renderMarkdownSvg).mockImplementation(async () => {
    controller.abort();
    return 'cG5n';
  });
  expect(await cacheWebMarkdownSvg('https://example.com/image.svg', controller.signal, 1024)).toBeNull();
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
});

test('decodes UTF-8 correctly across chunk boundaries', async () => {
  const source = svg.replace('/>', '><text>世界</text></svg>');
  const bytes = new TextEncoder().encode(source);
  const split = new TextEncoder().encode(source.slice(0, source.indexOf('世'))).length + 1;
  jest.mocked(fetch).mockResolvedValue(response([bytes.slice(0, split), bytes.slice(split)]));
  await cacheWebMarkdownSvg('https://example.com/image.svg', signal, 1024);
  expect(renderMarkdownSvg).toHaveBeenCalledWith(source);
});
