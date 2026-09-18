const HTML_TAG_PATTERN = /<\/?([a-z][a-z0-9]*)\b/gi;
const HTML_TAG_NAMES = new Set([
  'a', 'article', 'aside', 'b', 'blockquote', 'body', 'br', 'code', 'del',
  'details', 'div', 'em', 'figcaption', 'figure', 'footer', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'i', 'img',
  'kbd', 'li', 'main', 'ol', 'p', 'pre', 's', 'section', 'small', 'span',
  'strong', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'u', 'ul',
]);

function containsSupportedHtmlTag(value: string): boolean {
  return Array.from(value.matchAll(HTML_TAG_PATTERN)).some(match =>
    HTML_TAG_NAMES.has(match[1].toLowerCase()),
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  copy: '©',
  gt: '>',
  hellip: '…',
  laquo: '«',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  raquo: '»',
  rdquo: '”',
  reg: '®',
  rsquo: '’',
  trade: '™',
};

function decodeEntities(value: string, escapeAngles = false): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi,
    (entity, name: string) => {
      let decoded: string | undefined;
      if (name.startsWith('#x') || name.startsWith('#X')) {
        const codePoint = Number.parseInt(name.slice(2), 16);
        if (
          codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          decoded = String.fromCodePoint(codePoint);
        }
      } else if (name.startsWith('#')) {
        const codePoint = Number.parseInt(name.slice(1), 10);
        if (
          codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          decoded = String.fromCodePoint(codePoint);
        }
      } else {
        decoded = NAMED_ENTITIES[name.toLowerCase()];
      }
      if (!decoded) return entity;
      return escapeAngles
        ? decoded.replaceAll('<', '\\<').replaceAll('>', '\\>')
        : decoded;
    },
  );
}

function attribute(tag: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(
    new RegExp(
      `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`,
      'i',
    ),
  );
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function safeLinkTarget(value: string | null): string | null {
  if (!value) return null;
  const target = value.trim();
  if (!/^(?:https?:|mailto:|tel:|\/|#|\.\.?\/)/i.test(target)) return null;
  return target
    .replaceAll(' ', '%20')
    .replaceAll(')', '%29')
    .replaceAll('>', '%3E');
}

function plainText(value: string): string {
  return decodeEntities(
    value
      .replace(/<br\b[^>]*\/?\s*>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' '),
    true,
  ).trim();
}

function codeFence(value: string, language = ''): string {
  const longestRun = Math.max(
    2,
    ...Array.from(value.matchAll(/`+/g), match => match[0].length),
  );
  const fence = '`'.repeat(longestRun + 1);
  return `\n\n${fence}${language}\n${value.replace(
    /^\n+|\n+$/g,
    '',
  )}\n${fence}\n\n`;
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

function tableToMarkdown(table: string): string {
  const rows = Array.from(
    table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi),
    row => {
      return Array.from(
        row[1].matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi),
        cell => ({
          header: cell[1].toLowerCase() === 'h',
          value: plainText(cell[2]).replaceAll('|', '\\|'),
        }),
      );
    },
  ).filter(row => row.length > 0);
  if (!rows.length) return '';

  const columnCount = Math.max(...rows.map(row => row.length));
  const normalized = rows.map(row =>
    Array.from({ length: columnCount }, (_, index) => row[index]?.value ?? ''),
  );
  const headerIndex = rows.findIndex(row => row.some(cell => cell.header));
  const firstRow =
    headerIndex >= 0
      ? normalized.splice(headerIndex, 1)[0]
      : normalized.shift()!;
  const line = (row: string[]) => `| ${row.join(' | ')} |`;
  return `\n\n${line(firstRow)}\n${line(firstRow.map(() => '---'))}${
    normalized.length ? `\n${normalized.map(line).join('\n')}` : ''
  }\n\n`;
}

function listToMarkdown(list: string, ordered: boolean): string {
  const items = Array.from(
    list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi),
    match => plainText(match[1]),
  );
  if (!items.length) return plainText(list);
  return `\n\n${items
    .map((item, index) => `${ordered ? `${index + 1}.` : '-'} ${item}`)
    .join('\n')}\n\n`;
}

function convertHtml(value: string): string {
  const protectedCode: string[] = [];
  const protectCode = (markdown: string) => {
    const token = `\uE002WHIP_HTML_CODE_${protectedCode.length}\uE003`;
    protectedCode.push(markdown);
    return token;
  };
  let output = value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<(?:script|style|noscript|template|iframe|object|embed|head)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|iframe|object|embed|head)\s*>/gi,
      '',
    )
    .replace(
      /<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>/gi,
      (_match, attributes: string, body: string) => {
        const code = body.replace(/^\s*<code\b[^>]*>|<\/code\s*>\s*$/gi, '');
        const language =
          attribute(attributes, 'data-language') ??
          attribute(
            body.match(/^\s*<code\b[^>]*>/i)?.[0] ?? '',
            'class',
          )?.match(/(?:^|\s)language-([\w+-]+)/)?.[1] ??
          '';
        return protectCode(
          codeFence(
            decodeEntities(
              code.replace(/<br\b[^>]*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''),
            ),
            language,
          ),
        );
      },
    )
    .replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, tableToMarkdown);

  for (let depth = 0; depth < 4; depth += 1) {
    const next = output.replace(
      /<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi,
      (_match, type: string, body: string) =>
        listToMarkdown(body, type.toLowerCase() === 'ol'),
    );
    if (next === output) break;
    output = next;
  }

  output = output
    .replace(
      /<details\b[^>]*>([\s\S]*?)<\/details\s*>/gi,
      (_match, body: string) => {
        const summary = body.match(/<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i);
        const details = body.replace(
          /<summary\b[^>]*>[\s\S]*?<\/summary\s*>/i,
          '',
        );
        return `\n\n${
          summary ? `**${plainText(summary[1])}**\n\n` : ''
        }${plainText(details)}\n\n`;
      },
    )
    .replace(
      /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi,
      (_match, body: string) => {
        const quote = plainText(body);
        return `\n\n${quote
          .split('\n')
          .map(line => `> ${line}`)
          .join('\n')}\n\n`;
      },
    )
    .replace(
      /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi,
      (_match, level: string, body: string) =>
        `\n\n${'#'.repeat(Number(level))} ${plainText(body)}\n\n`,
    )
    .replace(
      /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
      (_match, attributes: string, body: string) => {
        const label = plainText(body);
        const target = safeLinkTarget(attribute(attributes, 'href'));
        return target ? `[${label.replaceAll(']', '\\]')}](${target})` : label;
      },
    )
    .replace(/<img\b([^>]*)\/?\s*>/gi, (_match, attributes: string) => {
      const alt = attribute(attributes, 'alt') ?? 'Image';
      const target = safeLinkTarget(attribute(attributes, 'src'));
      return target ? `![${alt.replaceAll(']', '\\]')}](${target})` : alt;
    })
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, '**$1**')
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)\s*>/gi, '*$1*')
    .replace(/<(?:del|s)\b[^>]*>([\s\S]*?)<\/(?:del|s)\s*>/gi, '~~$1~~')
    .replace(
      /<(?:code|kbd)\b[^>]*>([\s\S]*?)<\/(?:code|kbd)\s*>/gi,
      (_match, body: string) =>
        protectCode(inlineCode(decodeEntities(body.replace(/<[^>]*>/g, '')))),
    )
    .replace(/<hr\b[^>]*\/?\s*>/gi, '\n\n---\n\n')
    .replace(/<br\b[^>]*\/?\s*>/gi, '\n')
    .replace(
      /<\/(?:p|div|article|aside|section|main|header|footer|figure|figcaption)\s*>/gi,
      '\n\n',
    )
    .replace(
      /<(?:p|div|article|aside|section|main|header|footer|figure|figcaption)\b[^>]*>/gi,
      '',
    )
    .replace(
      /<\/?(?:html|body|span|small|u|summary|tbody|thead|tfoot|tr|td|th|li)\b[^>]*>/gi,
      '',
    )
    .replace(/<[^>]*>/g, '');

  return decodeEntities(output, true)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(
      /\uE002WHIP_HTML_CODE_(\d+)\uE003/g,
      (_match, index: string) => protectedCode[Number(index)] ?? '',
    );
}

function normalizeOpenCodeMath(value: string): string {
  const protectedMarkdown: string[] = [];
  const protect = (match: string) => {
    const token = `\uE004WHIP_MATH_CODE_${protectedMarkdown.length}\uE005`;
    protectedMarkdown.push(match);
    return token;
  };
  const withProtectedCode = value
    .replace(/^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^\1\2[ \t]*$|$)/gm, protect)
    .replace(/(`+)(?!`)([^\n]*?)\1/g, protect);
  let previousDisplayEnd = -1;
  const converted = withProtectedCode.replace(
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
  return converted.replace(
    /\uE004WHIP_MATH_CODE_(\d+)\uE005/g,
    (_match, index: string) => protectedMarkdown[Number(index)] ?? '',
  );
}

/**
 * Normalizes prose HTML into the native GFM renderer used by chat and file
 * previews. Existing Markdown code spans/fences are protected so examples of
 * markup stay examples instead of becoming rendered elements.
 */
export function normalizeRichTextMarkdown(value: string): string {
  if (!containsSupportedHtmlTag(value)) return normalizeOpenCodeMath(value);

  const protectedMarkdown: string[] = [];
  const protect = (match: string) => {
    const token = `\uE000WHIP_CODE_${protectedMarkdown.length}\uE001`;
    protectedMarkdown.push(match);
    return token;
  };
  const withProtectedCode = value
    .replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, protect)
    .replace(/(`+)(?!`)([^\n]*?)\1/g, protect);

  const markdown = convertHtml(withProtectedCode).replace(
    /\uE000WHIP_CODE_(\d+)\uE001/g,
    (_match, index: string) => protectedMarkdown[Number(index)] ?? '',
  );
  return normalizeOpenCodeMath(markdown);
}
