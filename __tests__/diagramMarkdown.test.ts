import { splitDiagramMarkdown } from '../src/lib/diagramMarkdown';

test('extracts multiple diagrams with backtick and tilde fences without losing prose', () => {
  const first = '```mermaid\nflowchart LR\nA --> B\n```\n';
  const second = '  ~~~~ MERMAID\r\nsequenceDiagram\r\nA->>B: Hi\r\n  ~~~~~\r\n';
  const markdown = `Before\n${first}Between\n${second}After`;
  const parts = splitDiagramMarkdown(markdown);
  expect(parts.map(part => part.type)).toEqual(['markdown', 'mermaid', 'markdown', 'mermaid', 'markdown']);
  expect(parts.filter(part => part.type === 'mermaid').map(part => part.content)).toEqual([
    'flowchart LR\nA --> B', 'sequenceDiagram\r\nA->>B: Hi',
  ]);
  expect(parts.map(part => part.type === 'mermaid' ? part.source : part.content).join('')).toBe(markdown);
  expect(parts.map(part => part.start)).toEqual([0, 7, 7 + first.length, 15 + first.length, 15 + first.length + second.length]);
});

test('extracts SVG and Mermaid together, preserving XML and source offsets', () => {
  const svg = '  ~~~~ SVG\r\n<svg viewBox="0 0 100 50"><text>&lt;b&gt;</text></svg>\r\n  ~~~~~\r\n';
  const mermaid = '```mermaid\nflowchart LR\nA --> B\n```';
  const markdown = `Before\n${svg}Between\n${mermaid}`;
  const parts = splitDiagramMarkdown(markdown);
  expect(parts.map(part => part.type)).toEqual(['markdown', 'svg', 'markdown', 'mermaid']);
  expect(parts[1]).toEqual({
    type: 'svg', content: '<svg viewBox="0 0 100 50"><text>&lt;b&gt;</text></svg>', source: svg, start: 7,
  });
  expect(parts.map(part => part.type === 'markdown' ? part.content : part.source).join('')).toBe(markdown);
  expect(parts.map(part => part.start)).toEqual([0, 7, 7 + svg.length, 15 + svg.length]);
});

test.each([
  '',
  'plain text mentioning mermaid',
  '```mermaid\nflowchart LR\nA --> B',
  '```mermaid\nflowchart LR\n~~~',
  '~~~~mermaid\nflowchart LR\n~~~',
  '```mermaid\nflowchart LR\n``` still code',
  '````markdown\n```mermaid\nflowchart LR\n```\n````',
  '```js\nconst diagram = `mermaid`;\n```',
  '    ```mermaid\n    flowchart LR\n    ```',
  '```svg\n<svg />',
  '~~~~svg\n<svg />\n~~~',
  '```svg\n<svg />\n``` still code',
  '````markdown\n```svg\n<svg />\n```\n````',
  '    ```svg\n    <svg />\n    ```',
  '```xml\n<svg />\n```',
])('preserves prose, incomplete fences, and fenced examples: %s', markdown => {
  expect(splitDiagramMarkdown(markdown)).toEqual([{ type: 'markdown', content: markdown, start: 0 }]);
});
