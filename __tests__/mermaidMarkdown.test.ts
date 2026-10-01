import { splitMermaidMarkdown } from '../src/lib/mermaidMarkdown';

test('extracts multiple diagrams with backtick and tilde fences without losing prose', () => {
  const first = '```mermaid\nflowchart LR\nA --> B\n```\n';
  const second = '  ~~~~ MERMAID\r\nsequenceDiagram\r\nA->>B: Hi\r\n  ~~~~~\r\n';
  const markdown = `Before\n${first}Between\n${second}After`;
  const parts = splitMermaidMarkdown(markdown);
  expect(parts.map(part => part.type)).toEqual(['markdown', 'mermaid', 'markdown', 'mermaid', 'markdown']);
  expect(parts.filter(part => part.type === 'mermaid').map(part => part.content)).toEqual([
    'flowchart LR\nA --> B', 'sequenceDiagram\r\nA->>B: Hi',
  ]);
  expect(parts.map(part => part.type === 'mermaid' ? part.source : part.content).join('')).toBe(markdown);
  expect(parts.map(part => part.start)).toEqual([0, 7, 7 + first.length, 15 + first.length, 15 + first.length + second.length]);
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
])('preserves prose, incomplete fences, and fenced examples: %s', markdown => {
  expect(splitMermaidMarkdown(markdown)).toEqual([{ type: 'markdown', content: markdown, start: 0 }]);
});
