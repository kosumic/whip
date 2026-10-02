import { normalizeRichTextMarkdown } from '../src/lib/richTextMarkdown';

describe('rich text markdown normalization', () => {
  test('converts semantic HTML into native-renderable GitHub Markdown', () => {
    const result = normalizeRichTextMarkdown(`
      <h2>Build result</h2>
      <p>The <strong>release</strong> is <a href="https://example.com/a b">ready</a>.<br>Ship it.</p>
      <ul><li>Android</li><li>iOS &amp; macOS</li></ul>
      <table><tr><th>Target</th><th>Status</th></tr><tr><td>arm64</td><td>Done</td></tr></table>
    `);

    expect(result).toContain('## Build result');
    expect(result).toContain(
      'The **release** is [ready](https://example.com/a%20b).',
    );
    expect(result).toContain('- Android\n- iOS & macOS');
    expect(result).toContain(
      '| Target | Status |\n| --- | --- |\n| arm64 | Done |',
    );
  });

  test('renders HTML code and removes active or unsafe content', () => {
    const unsafeScheme = ['java', 'script:'].join('');
    const result = normalizeRichTextMarkdown(`
      <pre><code class="language-ts">const tag = &quot;&lt;main&gt;&quot;;</code></pre>
      <script>alert('no')</script>
      <p><a href="${unsafeScheme}alert(1)">Unsafe</a> <img alt="tracker" src="data:text/html,hi"></p>
    `);

    expect(result).toContain('```ts\nconst tag = "<main>";\n```');
    expect(result).toContain('Unsafe tracker');
    expect(result).not.toContain(unsafeScheme);
    expect(result).not.toContain("alert('no')");
  });

  test('preserves bare relative HTML images, linked images, and table images', () => {
    const result = normalizeRichTextMarkdown([
      '<p><img src="assets/icon.svg" alt="App"></p>',
      '<a href="docs/demo.md"><img src="assets/demo screen.webp" alt="Demo"></a>',
      '<table><tr><th>Preview</th></tr><tr><td><a href="https://example.com"><img src="./screens/a.png" alt="A|B"></a><br>Caption</td></tr></table>',
    ].join('\n'));

    expect(result).toContain('![App](assets/icon.svg)');
    expect(result).toContain('[![Demo](assets/demo%20screen.webp)](docs/demo.md)');
    expect(result).toContain('| [![A\\|B](./screens/a.png)](https://example.com) Caption |');
  });

  test('keeps image markup inside code and removes images inside active HTML', () => {
    const example = '`<img src="example.png">`';
    const result = normalizeRichTextMarkdown(`${example}\n<p><img src="real.png"></p><script><img src="hidden.png"></script>`);
    expect(result).toContain(example);
    expect(result).toContain('![Image](real.png)');
    expect(result).not.toContain('hidden.png');
  });

  test.each([['java', 'script:alert(1)'].join(''), 'file:///private.png', 'data:text/html,hi'])(
    'removes disallowed HTML image scheme %s without losing alt text',
    src => {
      expect(normalizeRichTextMarkdown(`<img src="${src}" alt="Fallback">`)).toBe('Fallback');
    },
  );

  test('keeps HTML examples inside existing Markdown code spans and fences', () => {
    const source = 'Use `<section>` here.\n\n```html\n<main>Hello</main>\n```';
    expect(normalizeRichTextMarkdown(source)).toBe(source);
  });

  test('leaves ordinary Markdown untouched', () => {
    const source = '# Result\n\n- one\n- two\n\n`x < y`';
    expect(normalizeRichTextMarkdown(source)).toBe(source);
  });

  test('preserves the Markdown syntax enabled by the native parser', () => {
    const source = [
      '**bold**',
      '',
      '*italic*',
      '',
      '~~deleted~~',
      '',
      '`inline code`',
      '',
      '```rust',
      'fn main() {}',
      '```',
      '',
      '- [ ] incomplete',
      '- [x] complete',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      'H~2~O',
      '',
      'x^2^',
      '',
      '==highlight==',
      '',
      '$E = mc^2$',
      '',
      String.raw`\(a + b\)`,
    ].join('\n');

    expect(normalizeRichTextMarkdown(source)).toBe(
      source.replace(String.raw`\(a + b\)`, '$a + b$'),
    );
  });

  test('converts OpenCode inline math delimiters for the native renderer', () => {
    expect(normalizeRichTextMarkdown(String.raw`\(x^2\)`)).toBe('$x^2$');
    const source = String.raw`Euler's identity \(e^{i\pi} + 1 = 0\) is compact.`;
    expect(normalizeRichTextMarkdown(source)).toBe(
      String.raw`Euler's identity $e^{i\pi} + 1 = 0$ is compact.`,
    );
  });

  test('converts multiline display math while preserving LaTeX commands and escaped dollars', () => {
    const equation = String.raw`P_{\text{liq}}=\frac{1510\times(1+1/10)}{1+0.05}=\boxed{\$1,581.90}`;
    expect(normalizeRichTextMarkdown(`\\[\n${equation}\n\\]`)).toBe(
      `$$\n${equation}\n$$`,
    );
  });

  test.each([' ', '\n', '\n\n'])(
    'separates display math from prose with blank lines (separator %j)',
    separator => {
      const source = `Before **math**.${separator}\\[x^2\\]${separator}After \\(y\\).`;
      expect(normalizeRichTextMarkdown(source)).toBe(
        'Before **math**.\n\n$$\nx^2\n$$\n\nAfter $y$.',
      );
    },
  );

  test('separates adjacent display equations without accumulating blank lines', () => {
    expect(normalizeRichTextMarkdown(String.raw`\[x\]\[y\]`)).toBe(
      '$$\nx\n$$\n\n$$\ny\n$$',
    );
  });

  test.each([
    '`\\[not math\\]`',
    '``\\[not `math`\\]``',
    '```tex\n\\[\nnot math\n\\]\n```',
    '~~~tex\n\\[not math\\]\n~~~',
  ])('preserves display delimiters inside code: %s', code => {
    const source = `${code}\n\n\\[x\\]`;
    expect(normalizeRichTextMarkdown(source)).toBe(`${code}\n\n$$\nx\n$$`);
  });

  test.each([
    String.raw`\\[not math\\]`,
    String.raw`\[not math\\]`,
    String.raw`\\[not math\]`,
    String.raw`\(not math\\)`,
    String.raw`[ P_{\text{liq}} = 10 ]`,
    String.raw`\[unfinished`,
    String.raw`unfinished\]`,
  ])('keeps literal or incomplete math delimiters untouched: %s', source => {
    expect(normalizeRichTextMarkdown(source)).toBe(source);
  });

  test('preserves escaped examples alongside real display math', () => {
    expect(normalizeRichTextMarkdown(String.raw`Literal \\[not math\\], then \[x\].`)).toBe(
      'Literal \\\\[not math\\\\], then\n\n$$\nx\n$$\n\n.',
    );
  });

  test('skips escaped closing delimiters within math', () => {
    expect(normalizeRichTextMarkdown(String.raw`\(x\\) + y\)`)).toBe(
      String.raw`$x\\) + y$`,
    );
    expect(normalizeRichTextMarkdown(String.raw`\[x\\] + y\]`)).toBe(
      '$$\n' + String.raw`x\\] + y` + '\n$$',
    );
  });

  test('normalizes HTML before math and preserves HTML code literals', () => {
    const source = String.raw`<p>Before <strong>math</strong>.</p><p>\[x &lt; y\]</p><p>After <code>\[not math\]</code>.</p><pre><code class="language-tex">\[
not math
\]</code></pre>`;
    const result = normalizeRichTextMarkdown(source);
    expect(result).toContain(
      'Before **math**.\n\n$$\nx \\< y\n$$\n\nAfter `\\[not math\\]`.',
    );
    expect(result).toContain('```tex\n\\[\nnot math\n\\]\n```');
  });

  test('does not convert OpenCode math delimiters inside code spans or fences', () => {
    const source = 'Outside \\(x^2\\).\n\nInline: `\\(not_math\\)`\n\n```tex\n\\(also_not_math\\)\n```';
    const expected = 'Outside $x^2$.\n\nInline: `\\(not_math\\)`\n\n```tex\n\\(also_not_math\\)\n```';
    expect(normalizeRichTextMarkdown(source)).toBe(expected);
  });

  test('keeps escaped OpenCode math delimiters literal', () => {
    const source = String.raw`Literal \\(not math\\), math \(x\).`;
    expect(normalizeRichTextMarkdown(source)).toBe(
      String.raw`Literal \\(not math\\), math $x$.`,
    );
  });

  test('keeps math-like text in HTML code elements literal', () => {
    expect(normalizeRichTextMarkdown(String.raw`<code>\(not_math\)</code> and \(x\)`)).toBe(
      '`\\(not_math\\)` and $x$',
    );
  });

  test('does not transform Markdown, HTML, or math delimiters inside code', () => {
    const source = [
      'Inline: `<strong>**bold**</strong> \\(x\\) $y$ H~2~O x^2^ ==mark==`',
      '',
      '```markdown',
      '<em>*italic*</em>',
      String.raw`\(not_math\) and $also_not_math$`,
      '~~deleted~~ H~2~O x^2^ ==highlight==',
      '```',
    ].join('\n');

    expect(normalizeRichTextMarkdown(source)).toBe(source);
  });

  test('replaces invalid numeric HTML entities according to HTML parsing rules', () => {
    expect(normalizeRichTextMarkdown('<p>Bad: &#999999999;</p>')).toBe(
      'Bad: \uFFFD',
    );
  });

  test.each([
    '<SCRIPT>hidden</SCRIPT>',
    '<script>hidden</script\t\n ignored>',
    '<script>hidden</script/ignored>',
    '<style>hidden</style>',
    '<noscript>hidden</noscript>',
    '<template><p>hidden</p></template>',
    '<iframe>hidden</iframe>',
    '<object><p>hidden</p></object>',
    '<embed src="hidden">',
    '<!-- hidden <!-- nested -->',
  ])('omits active elements and comments without joining tags: %s', html => {
    expect(normalizeRichTextMarkdown(`<p>Before</p>${html}<p>After</p>`)).toBe(
      'Before\n\nAfter',
    );
  });

  test('omits unclosed active HTML, including when there are no prose tags', () => {
    expect(normalizeRichTextMarkdown('<script>hidden')).toBe('');
    expect(normalizeRichTextMarkdown('<p>Visible</p><!-- hidden')).toBe('Visible');
  });

  test('escapes leftover angle brackets instead of rebuilding HTML after removing tags', () => {
    expect(normalizeRichTextMarkdown('<p><<em></em>script>alert(1)<<b></b>/script></p>')).toBe(
      '\\<script\\>alert(1)\\</script\\>',
    );
  });

  test('decodes text entities once and keeps encoded tags as literal Markdown text', () => {
    expect(normalizeRichTextMarkdown('<p>&lt;script&gt;literal&lt;/script&gt; &amp;lt;img&amp;gt;</p>')).toBe(
      '\\<script\\>literal\\</script\\> &lt;img&gt;',
    );
  });

  test('keeps backslashes from cancelling escapes around decoded HTML tags', () => {
    expect(normalizeRichTextMarkdown(String.raw`<p>\&lt;img src=x onerror=alert(1)\&gt;</p>`)).toBe(
      String.raw`\\\<img src=x onerror=alert(1)\\\>`,
    );
  });

  test('handles quoted angle brackets, omitted closing tags, and unsafe encoded targets', () => {
    const result = normalizeRichTextMarkdown([
      '<p><a title="1 > 0" href="https://example.com/a b">Ready</a>',
      '<p><a href="jav&#x61;script:alert(1)">Unsafe</a>',
      '<p><img src="java&#x09;script:alert(1)" alt="Fallback">',
    ].join(''));
    expect(result).toBe('[Ready](https://example.com/a%20b)\n\nUnsafe\n\nFallback');
  });

  test('keeps brackets in link labels literal while preserving linked images', () => {
    expect(normalizeRichTextMarkdown('<a href="https://example.com">[label] <strong>[bold]</strong><img src="icon.png" alt="[icon]"></a>')).toBe(
      '[\\[label\\] **\\[bold\\]**![\\[icon\\]](icon.png)](https://example.com)',
    );
  });

  test('omits active content inside tables and details while preserving their formatting', () => {
    const result = normalizeRichTextMarkdown([
      '<details><summary>Result</summary><p>Safe<script>hidden</script></p></details>',
      '<table><tr><th>Name<th>Status<tr><td>A<td>Ready<script>hidden</script></table>',
    ].join(''));
    expect(result).toBe('**Result**\n\nSafe\n\n| Name | Status |\n| --- | --- |\n| A | Ready |');
  });

  test('preserves code whitespace and literal HTML alongside malformed active HTML', () => {
    const code = '~~~html\n<script>example</script>\n~~~';
    const result = normalizeRichTextMarkdown(`${code}\n\n<p>Safe</p><pre><code>  &lt;tag&gt;\n\n\n  value</code></pre><script>hidden</script\t ignored>`);
    expect(result).toBe(`${code}\n\nSafe\n\n\`\`\`\n  <tag>\n\n\n  value\n\`\`\``);
  });

  test('rejects fence delimiters or newlines in HTML code language attributes', () => {
    expect(normalizeRichTextMarkdown('<pre data-language="js&#10;```&#10;injected"><code>safe</code></pre>')).toBe(
      '```\nsafe\n```',
    );
  });

  test('does not interpret literal placeholder text as protected code', () => {
    const token = '\uE002WHIP_HTML_CODE_0\uE003';
    const markdownToken = '\uE000WHIP_CODE_0\uE001';
    expect(normalizeRichTextMarkdown(`<p>${token} ${markdownToken} <code>actual</code> \`literal\`</p>`)).toBe(
      `${token} ${markdownToken} \`actual\` \`literal\``,
    );
  });
});
