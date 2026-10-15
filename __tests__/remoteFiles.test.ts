import {
  formatRemoteFileSize,
  isRemoteHiddenPath,
  joinRemotePath,
  MAX_REMOTE_TEXT_PREVIEW_BYTES,
  nextRemoteFileSort,
  normalizeRemotePath,
  parentRemotePath,
  remoteCodeLanguage,
  remoteEntryName,
  remotePreviewKind,
  sortRemoteEntries,
} from '../src/lib/remoteFiles';

const entry = (name: string, isDirectory = false) => ({
  name: name.replace(/\/$/, ''),
  path: `/${name.replace(/\/$/, '')}`,
  kind: isDirectory ? 'directory' as const : 'file' as const,
  size: 0,
});

describe('remote file paths', () => {
  it('starts relative and tilde paths from the remote home', () => {
    expect(normalizeRemotePath(undefined, '/home/kosumi')).toBe('/home/kosumi');
    expect(normalizeRemotePath('~/repos/herdr', '/home/kosumi')).toBe(
      '/home/kosumi/repos/herdr',
    );
    expect(normalizeRemotePath('../shared', '/home/kosumi')).toBe(
      '/home/shared',
    );
  });

  it('joins entries and navigates to parents without escaping root', () => {
    expect(remoteEntryName(entry('src/'))).toBe('src');
    expect(joinRemotePath('/home/kosumi', 'src/')).toBe('/home/kosumi/src');
    expect(joinRemotePath('/', 'etc')).toBe('/etc');
    expect(parentRemotePath('/home/kosumi/src')).toBe('/home/kosumi');
    expect(parentRemotePath('/')).toBe('/');
  });

  it('sorts directories first and filenames naturally', () => {
    expect(
      sortRemoteEntries([
        entry('file10.ts'),
        entry('z-dir/', true),
        entry('file2.ts'),
        entry('a-dir/', true),
      ]).map(remoteEntryName),
    ).toEqual(['a-dir', 'z-dir', 'file2.ts', 'file10.ts']);
  });

  it('sorts remote entries by size or modification date in either direction', () => {
    const oldSmall = {
      ...entry('old-small.txt'),
      size: 10,
      modifiedAt: 100,
    };
    const newLarge = {
      ...entry('new-large.txt'),
      size: 200,
      modifiedAt: 300,
    };
    const middle = {
      ...entry('middle.txt'),
      size: 50,
      modifiedAt: 200,
    };
    const directory = {
      ...entry('folder/', true),
      size: 999,
      modifiedAt: 50,
    };

    expect(
      sortRemoteEntries(
        [oldSmall, directory, newLarge, middle],
        'size',
        'descending',
      ).map(remoteEntryName),
    ).toEqual(['folder', 'new-large.txt', 'middle.txt', 'old-small.txt']);
    expect(
      sortRemoteEntries(
        [oldSmall, directory, newLarge, middle],
        'modified',
        'ascending',
      ).map(remoteEntryName),
    ).toEqual(['folder', 'old-small.txt', 'middle.txt', 'new-large.txt']);
  });

  it('identifies hidden files and hidden path segments', () => {
    expect(isRemoteHiddenPath('.env')).toBe(true);
    expect(isRemoteHiddenPath('src/.generated/schema.ts')).toBe(true);
    expect(isRemoteHiddenPath('src/App.tsx')).toBe(false);
  });

  it('uses natural defaults and reverses a selected sort field', () => {
    expect(nextRemoteFileSort('name', 'ascending', 'modified')).toEqual({
      field: 'modified',
      direction: 'descending',
    });
    expect(nextRemoteFileSort('modified', 'descending', 'modified')).toEqual({
      field: 'modified',
      direction: 'ascending',
    });
    expect(nextRemoteFileSort('size', 'descending', 'name')).toEqual({
      field: 'name',
      direction: 'ascending',
    });
  });
});

describe('remote file previews', () => {
  it.each(['notes', 'notes.txt', 'server.log', 'source.rs', 'README.md'])(
    'pages large text files: %s', filename => {
      expect(remotePreviewKind(filename, 10 * 1024 * 1024)).toBe('paged-text');
    },
  );

  it.each(['notes', '/repo/notes', '.gitignore', 'LICENSE', '資料'])('offers a text preview for extensionless %s', filename => {
    expect(remotePreviewKind(filename, 0)).toBe('text');
    expect(remotePreviewKind(filename, MAX_REMOTE_TEXT_PREVIEW_BYTES)).toBe('text');
    expect(remotePreviewKind(filename, MAX_REMOTE_TEXT_PREVIEW_BYTES + 1)).toBe('paged-text');
    expect(remotePreviewKind(filename, undefined)).toBe('unsupported');
  });

  it('keeps extensionless code filenames specialized and unknown extensions unsupported', () => {
    expect(remotePreviewKind('Dockerfile', 1000)).toBe('code');
    expect(remotePreviewKind('Makefile', 1000)).toBe('code');
    expect(remotePreviewKind('notes.custom', 1000)).toBe('unsupported');
  });

  it('selects the production preview for supported file types and sizes', () => {
    expect(remotePreviewKind('README.md', 1000)).toBe('markdown');
    expect(remotePreviewKind('index.html', 1000)).toBe('html');
    expect(remotePreviewKind('legacy.htm', 1000)).toBe('html');
    expect(remotePreviewKind('App.tsx', 1000)).toBe('code');
    expect(remotePreviewKind('config.json', 1000)).toBe('code');
    expect(remotePreviewKind('config.toml', 1000)).toBe('code');
    expect(remotePreviewKind('config.yaml', 1000)).toBe('code');
    expect(remotePreviewKind('notes.txt', 1000)).toBe('text');
    expect(remotePreviewKind('photo.png', 1000)).toBe('image');
    expect(remotePreviewKind('architecture.svg', 1000)).toBe('svg');
    expect(remotePreviewKind('architecture.mmd', 1000)).toBe('mermaid');
    expect(remotePreviewKind('sequence.mermaid', 1000)).toBe('mermaid');
    expect(remotePreviewKind('large.mmd', 100_001)).toBe('unsupported');
    expect(remotePreviewKind('large.svg', 600 * 1024)).toBe('unsupported');
    expect(remotePreviewKind('recording.mp4', 1000)).toBe('video');
    expect(remotePreviewKind('screen.webm', 1000)).toBe('video');
    expect(remotePreviewKind('large.mov', 20 * 1024 * 1024 * 1024)).toBe(
      'video',
    );
    expect(remotePreviewKind('podcast.mp3', 1000)).toBe('audio');
    expect(remotePreviewKind('voice.opus', 1000)).toBe('audio');
    expect(remotePreviewKind('report.pdf', 1000)).toBe('pdf');
    expect(remotePreviewKind('archive.zip', 1000)).toBe('unsupported');
  });

  it('maps remote filenames to syntax highlighter languages', () => {
    expect(remoteCodeLanguage('Component.tsx')).toBe('typescript');
    expect(remoteCodeLanguage('Dockerfile')).toBe('dockerfile');
    expect(remoteCodeLanguage('script.sh')).toBe('bash');
    expect(remoteCodeLanguage('settings.json')).toBe('json');
    expect(remoteCodeLanguage('settings.toml')).toBe('toml');
    expect(remoteCodeLanguage('settings.yml')).toBe('yaml');
    expect(remoteCodeLanguage('README.md')).toBe('markdown');
    expect(remoteCodeLanguage('architecture.svg')).toBe('xml');
    expect(remoteCodeLanguage('unknown.source')).toBe('plaintext');
  });

  it('formats file sizes compactly', () => {
    expect(formatRemoteFileSize(0)).toBe('0 B');
    expect(formatRemoteFileSize(1536)).toBe('1.5 KB');
    expect(formatRemoteFileSize(12 * 1024 * 1024)).toBe('12 MB');
  });
});
