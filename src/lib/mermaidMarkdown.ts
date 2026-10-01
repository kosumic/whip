export type MermaidMarkdownPart =
  | { type: 'markdown'; content: string; start: number }
  | { type: 'mermaid'; content: string; source: string; start: number };

/** Extract complete top-level Mermaid fences, leaving examples and streaming code intact. */
export function splitMermaidMarkdown(markdown: string): MermaidMarkdownPart[] {
  const parts: MermaidMarkdownPart[] = [];
  const lines = markdown.match(/(?:[^\n]*\n|[^\n]+$)/g) || [];
  let fence: { marker: string; length: number; start: number; bodyStart: number; mermaid: boolean } | null = null;
  let offset = 0;
  let textStart = 0;

  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(line);
    if (match) {
      const [, marker, info] = match;
      if (fence) {
        if (marker.startsWith(fence.marker) && marker.length >= fence.length && !info.trim()) {
          if (fence.mermaid) {
            if (fence.start > textStart) {
              parts.push({ type: 'markdown', content: markdown.slice(textStart, fence.start), start: textStart });
            }
            parts.push({
              type: 'mermaid',
              content: markdown.slice(fence.bodyStart, offset).replace(/\r?\n$/, ''),
              source: markdown.slice(fence.start, offset + line.length),
              start: fence.start,
            });
            textStart = offset + line.length;
          }
          fence = null;
        }
      } else if (!marker.startsWith('`') || !info.includes('`')) {
        fence = {
          marker: marker[0], length: marker.length, start: offset, bodyStart: offset + line.length,
          mermaid: info.trim().toLowerCase() === 'mermaid',
        };
      }
    }
    offset += line.length;
  }
  if (textStart < markdown.length || parts.length === 0) {
    parts.push({ type: 'markdown', content: markdown.slice(textStart), start: textStart });
  }
  return parts;
}
