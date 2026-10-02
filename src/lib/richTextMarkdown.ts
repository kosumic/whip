import { parse, type DefaultTreeAdapterMap } from 'parse5';

type HtmlNode = DefaultTreeAdapterMap['childNode'];
type HtmlElement = DefaultTreeAdapterMap['element'];

const OMITTED_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'head',
]);
const BLOCK_TAGS = new Set([
  'p', 'div', 'article', 'aside', 'section', 'main', 'header', 'footer',
  'figure', 'figcaption',
]);
const HTML_TAG_PATTERN = /<\/?([a-z][a-z0-9]*)\b/gi;
const HTML_TAG_NAMES = new Set([
  ...OMITTED_TAGS, ...BLOCK_TAGS,
  'a', 'b', 'blockquote', 'body', 'br', 'code', 'del', 'details', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'html', 'i', 'img', 'kbd',
  'li', 'ol', 'pre', 's', 'small', 'span', 'strong', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);
const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const IMAGE_SCHEMES = new Set(['http', 'https']);
const INLINE_MARKERS = new Map([
  ['strong', '**'], ['b', '**'], ['em', '*'], ['i', '*'], ['del', '~~'], ['s', '~~'],
]);

function containsSupportedHtmlTag(value: string): boolean {
  return value.includes('<!--') || Array.from(value.matchAll(HTML_TAG_PATTERN)).some(
    match => HTML_TAG_NAMES.has(match[1].toLowerCase()),
  );
}

function attribute(element: HtmlElement, name: string): string | null {
  return element.attrs.find(attr => attr.name === name && !attr.namespace)?.value ?? null;
}

function escapeAngles(value: string): string {
  // Double preceding backslashes so they cannot cancel the Markdown escape.
  return value.replace(/(\\*)([<>])/g, (_match, backslashes: string, angle: string) =>
    `${backslashes.replaceAll('\\', '\\\\')}\\${angle}`,
  );
}

function escapeLabel(value: string): string {
  return value.replace(/([\\[\]<>|])/g, '\\$1');
}

function safeTarget(value: string | null, allowedSchemes: ReadonlySet<string>): string | null {
  if (!value) return null;
  const target = value.trim();
  if (!target || Array.from(target).some(character => character.charCodeAt(0) < 32)) return null;
  const scheme = target.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  if (scheme && !allowedSchemes.has(scheme.toLowerCase())) return null;
  return target.replace(/[\\ ()<>]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function textContent(node: HtmlNode): string {
  if ('value' in node) return node.value;
  if (!('tagName' in node) || OMITTED_TAGS.has(node.tagName)) return '';
  if (node.tagName === 'br') return '\n';
  return node.childNodes.map(textContent).join('');
}

function codeFence(value: string, language = ''): string {
  const longestRun = Math.max(
    2,
    ...Array.from(value.matchAll(/`+/g), match => match[0].length),
  );
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${language}\n${value.replace(/^\n+|\n+$/g, '')}\n${fence}`;
}

function inlineCode(value: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), match => match[0].length),
  );
  const fence = '`'.repeat(longestRun + 1);
  const padding = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

function childElements(element: HtmlElement): HtmlElement[] {
  return element.childNodes.filter((node): node is HtmlElement => 'tagName' in node);
}

function tableRows(element: HtmlElement): HtmlElement[] {
  return childElements(element).flatMap(child => {
    if (child.tagName === 'tr') return [child];
    if (['tbody', 'thead', 'tfoot'].includes(child.tagName)) return tableRows(child);
    return [];
  });
}

type RenderChildren = (nodes: HtmlNode[], inLink?: boolean) => string;

function compactMarkdown(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tableToMarkdown(table: HtmlElement, render: RenderChildren): string {
  const rows = tableRows(table).map(row =>
    childElements(row)
      .filter(cell => cell.tagName === 'td' || cell.tagName === 'th')
      .map(cell => ({
        header: cell.tagName === 'th',
        value: compactMarkdown(render(cell.childNodes)).replaceAll('|', '\\|'),
      })),
  ).filter(row => row.length > 0);
  if (!rows.length) return '';

  const columnCount = Math.max(...rows.map(row => row.length));
  const normalized = rows.map(row =>
    Array.from({ length: columnCount }, (_, index) => row[index]?.value ?? ''),
  );
  const headerIndex = rows.findIndex(row => row.some(cell => cell.header));
  const firstRow = headerIndex >= 0
    ? normalized.splice(headerIndex, 1)[0]
    : normalized.shift()!;
  const line = (row: string[]) => `| ${row.join(' | ')} |`;
  return `\n\n${line(firstRow)}\n${line(firstRow.map(() => '---'))}${
    normalized.length ? `\n${normalized.map(line).join('\n')}` : ''
  }\n\n`;
}

function listToMarkdown(list: HtmlElement, render: RenderChildren): string {
  const items = childElements(list).filter(child => child.tagName === 'li');
  const lines = items.map((item, index) => {
    const prefix = list.tagName === 'ol' ? `${index + 1}.` : '-';
    const content = render(item.childNodes).trim();
    return `${prefix} ${content.replace(/\n/g, '\n  ')}`;
  });
  return `\n\n${lines.join('\n')}\n\n`;
}

function convertHtml(value: string): string {
  const protectedFragments: string[] = [];
  // Use a prefix absent from the input so literal text cannot impersonate code.
  let fragmentPrefix = '\uE002WHIP_HTML_CODE_';
  while (value.includes(fragmentPrefix)) fragmentPrefix += '_';
  const protect = (markdown: string) => {
    const token = `${fragmentPrefix}${protectedFragments.length}\uE003`;
    protectedFragments.push(markdown);
    return token;
  };
  const render: RenderChildren = (nodes, inLink = false) =>
    nodes.map(node => renderNode(node, inLink)).join('');
  const renderNode = (node: HtmlNode, inLink: boolean): string => {
    if ('value' in node) return inLink ? escapeLabel(node.value) : escapeAngles(node.value);
    if (!('tagName' in node) || OMITTED_TAGS.has(node.tagName)) return '';
    const { tagName, childNodes } = node;
    switch (tagName) {
      case 'pre': {
        const code = childElements(node).find(child => child.tagName === 'code');
        const language = attribute(node, 'data-language')
          ?? (code && attribute(code, 'class')?.match(/(?:^|\s)language-([\w+-]+)/)?.[1])
          ?? '';
        // A language attribute must not be able to close the fence or add lines.
        const safeLanguage = /^[\w+-]*$/.test(language) ? language : '';
        return `\n\n${protect(codeFence(textContent(node), safeLanguage))}\n\n`;
      }
      case 'code':
      case 'kbd':
        return protect(inlineCode(textContent(node)));
      case 'img': {
        const alt = attribute(node, 'alt') ?? 'Image';
        const label = escapeLabel(alt);
        const target = safeTarget(attribute(node, 'src'), IMAGE_SCHEMES);
        return protect(target ? `![${label}](${target})` : label);
      }
      case 'a': {
        const label = compactMarkdown(render(childNodes, true));
        const target = safeTarget(attribute(node, 'href'), LINK_SCHEMES);
        return protect(target ? `[${label}](${target})` : label);
      }
      case 'table':
        return tableToMarkdown(node, render);
      case 'ul':
      case 'ol':
        return listToMarkdown(node, render);
      case 'details': {
        const summary = childElements(node).find(child => child.tagName === 'summary');
        const title = summary ? `**${compactMarkdown(render(summary.childNodes))}**\n\n` : '';
        return `\n\n${title}${render(childNodes.filter(child => child !== summary))}\n\n`;
      }
      case 'blockquote':
        return `\n\n${render(childNodes).trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
      case 'hr':
        return '\n\n---\n\n';
      case 'br':
        return '\n';
      default: {
        const content = render(childNodes, inLink);
        const marker = INLINE_MARKERS.get(tagName);
        if (marker) return content ? `${marker}${content}${marker}` : '';
        if (/^h[1-6]$/.test(tagName)) {
          return `\n\n${'#'.repeat(Number(tagName[1]))} ${compactMarkdown(content)}\n\n`;
        }
        return BLOCK_TAGS.has(tagName) ? `${content}\n\n` : content;
      }
    }
  };

  // The HTML5 parser handles comments, raw-text elements, quoted attributes,
  // malformed end tags, and entity decoding. Never serialize its HTML tree.
  let output = render(parse(value).childNodes)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Escaped brackets in generated links/images are Markdown, not math syntax.
  output = normalizeOpenCodeMath(output);
  // A link can contain an image or code token. Restore its outer token first.
  for (let index = protectedFragments.length - 1; index >= 0; index -= 1) {
    output = output.replaceAll(`${fragmentPrefix}${index}\uE003`, protectedFragments[index]);
  }
  return output.trim();
}

function protectMarkdownCode(value: string): { content: string; restore: (output: string) => string } {
  const protectedMarkdown: string[] = [];
  let prefix = '\uE000WHIP_CODE_';
  while (value.includes(prefix)) prefix += '_';
  const protect = (match: string) => {
    const token = `${prefix}${protectedMarkdown.length}\uE001`;
    protectedMarkdown.push(match);
    return token;
  };
  const content = value
    .replace(/^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^\1\2[ \t]*$|$)/gm, protect)
    .replace(/(`+)(?!`)([^\n]*?)\1/g, protect);
  return {
    content,
    restore: output => {
      protectedMarkdown.forEach((markdown, index) => {
        output = output.replaceAll(`${prefix}${index}\uE001`, markdown);
      });
      return output;
    },
  };
}

function normalizeOpenCodeMath(value: string): string {
  const protectedCode = protectMarkdownCode(value);
  let previousDisplayEnd = -1;
  const converted = protectedCode.content.replace(
    // Consume escaped backslash pairs before considering either delimiter.
    /\\\\|\\\(((?:\\[^\n]|[^\\\n])*?)\\\)|\s*\\\[((?:\\[\s\S]|[^\\])*?)\\\]\s*/g,
    (match, inline: string | undefined, display: string | undefined, offset: number, source: string) => {
      if (inline !== undefined) return `$${inline}$`;
      if (display === undefined) return match;

      // Keep display math on its own block, including beside prose or other math.
      const before = offset > 0 && offset !== previousDisplayEnd ? '\n\n' : '';
      previousDisplayEnd = offset + match.length;
      const after = previousDisplayEnd < source.length ? '\n\n' : '';
      return `${before}$$\n${display.trim()}\n$$${after}`;
    },
  );
  return protectedCode.restore(converted);
}

/**
 * Normalizes prose HTML into the native GFM renderer used by chat and file
 * previews. Existing Markdown code spans/fences are protected so examples of
 * markup stay examples instead of becoming rendered elements.
 */
export function normalizeRichTextMarkdown(value: string): string {
  const protectedCode = protectMarkdownCode(value);
  if (!containsSupportedHtmlTag(protectedCode.content)) return normalizeOpenCodeMath(value);
  return protectedCode.restore(convertHtml(protectedCode.content));
}
