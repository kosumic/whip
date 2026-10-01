import {
  markdownImageTargets,
  resolveRemoteMarkdownPath,
  rewriteMarkdownImages,
} from '../src/lib/markdownRemoteLinks';
import { normalizeRichTextMarkdown } from '../src/lib/richTextMarkdown';

describe('remote Markdown links', () => {
  it('resolves relative, parent, encoded, and absolute remote paths', () => {
    expect(resolveRemoteMarkdownPath('/home/me/repo/docs/README.md', './images/app.png')).toBe(
      '/home/me/repo/docs/images/app.png',
    );
    expect(resolveRemoteMarkdownPath('/home/me/repo/docs/README.md', '../assets/app.png#preview')).toBe(
      '/home/me/repo/assets/app.png',
    );
    expect(resolveRemoteMarkdownPath('/home/me/repo/README.md', 'assets/app%20screen.png')).toBe(
      '/home/me/repo/assets/app screen.png',
    );
    expect(resolveRemoteMarkdownPath('/home/me/repo/README.md', '/shared/app.png')).toBe(
      '/shared/app.png',
    );
  });

  it.each(['https://example.com/app.png', 'data:image/png;base64,abc', '//cdn.example.com/app.png', '#demo'])(
    'leaves non-SFTP target %s alone',
    target => {
      expect(resolveRemoteMarkdownPath('/home/me/repo/README.md', target)).toBeNull();
    },
  );

  it('finds inline image destinations with titles, angle brackets, and parentheses', () => {
    const markdown = [
      '![App](assets/app.png "Screenshot")',
      '![Wide](<assets/wide app.png>)',
      '![Build](assets/build_(arm64).png)',
      '[ordinary](docs/guide.md)',
    ].join('\n');

    expect(markdownImageTargets(markdown).map(image => image.target)).toEqual([
      'assets/app.png',
      'assets/wide app.png',
      'assets/build_(arm64).png',
    ]);
  });

  it('rewrites only image destinations whose remote files were cached', () => {
    const markdown = '![Local](images/local.png) ![Web](https://example.com/web.png)';
    expect(rewriteMarkdownImages(
      markdown,
      target => target === 'images/local.png' ? 'file:///cache/local.png' : undefined,
    )).toBe('![Local](file:///cache/local.png) ![Web](https://example.com/web.png)');
  });

  it('loads and rewrites image reference definitions', () => {
    const markdown = [
      '![App screenshot][app]',
      '![Collapsed][]',
      '',
      '[app]: assets/app.png "App"',
      '[collapsed]: <assets/collapsed image.png>',
      '[unused]: assets/unused.png',
    ].join('\n');

    expect(markdownImageTargets(markdown).map(image => image.target)).toEqual([
      'assets/app.png',
      'assets/collapsed image.png',
    ]);
    expect(rewriteMarkdownImages(
      markdown,
      target => target.includes('collapsed') ? 'file:///cache/collapsed.png' : undefined,
    )).toContain('[collapsed]: <file:///cache/collapsed.png>');
  });

  it('does not treat image syntax in code as a remote asset', () => {
    const markdown = [
      '`![Inline](inline.png)`',
      '',
      '```markdown',
      '![Fenced](fenced.png)',
      '```',
      '',
      '![Rendered](rendered.png)',
    ].join('\n');

    expect(markdownImageTargets(markdown).map(image => image.target)).toEqual(['rendered.png']);
  });

  it('discovers and rewrites normalized HTML images without losing links or tables', () => {
    const markdown = normalizeRichTextMarkdown([
      '<a href="./details.md"><img src="assets/icon.svg" alt="Icon"></a>',
      '<table><tr><td><img src="screens/app.png" alt="App"></td></tr></table>',
      '`<img src="example.png">`',
    ].join('\n'));
    expect(markdownImageTargets(markdown).map(image => image.target)).toEqual([
      'assets/icon.svg', 'screens/app.png',
    ]);
    const rewritten = rewriteMarkdownImages(markdown, target => `file:///cache/${target.split('/').pop()}.png`);
    expect(rewritten).toContain('[![Icon](file:///cache/icon.svg.png)](./details.md)');
    expect(rewritten).toContain('| ![App](file:///cache/app.png.png) |');
    expect(rewritten).toContain('`<img src="example.png">`');
  });

});
