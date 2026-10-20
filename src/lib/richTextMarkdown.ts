import { convertRichTextHtml } from 'react-native-whip-ssh';

const HTML_TAG_PATTERN = /<\/?([a-z][a-z0-9]*)\b/gi;
const HTML_TAG_NAMES = new Set([
  'a', 'article', 'aside', 'b', 'blockquote', 'body', 'br', 'code', 'del',
  'details', 'div', 'em', 'embed', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html',
  'i', 'iframe', 'img', 'kbd', 'li', 'main', 'noscript', 'object', 'ol',
  'p', 'pre', 's', 'script', 'section', 'small', 'span', 'strong', 'style',
  'summary', 'table', 'tbody', 'td', 'template', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul',
]);

function containsSupportedHtmlTag(value: string): boolean {
  return value.includes('<!--') || Array.from(value.matchAll(HTML_TAG_PATTERN)).some(
    match => HTML_TAG_NAMES.has(match[1].toLowerCase()),
  );
}

function convertHtml(value: string): string {
  const { content, fragmentPrefix, protectedFragments } = convertRichTextHtml(value);
  // Escaped brackets in generated links/images are Markdown, not math syntax.
  let output = normalizeOpenCodeMath(content);
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
