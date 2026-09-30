import { isJsonToolOutput, MAX_JSON_TOOL_OUTPUT_LENGTH, parseJsonToolOutput } from '../src/lib/toolOutput';

test('retains parsed values and distinguishes JSON null from invalid output', () => {
  expect(parseJsonToolOutput('null')).toEqual({ value: null });
  expect(parseJsonToolOutput('{"results":[{"title":"Article"}]}')).toEqual({ value: { results: [{ title: 'Article' }] } });
  expect(parseJsonToolOutput('{"results":')).toBeNull();
});

test.each([
  '{"nested":{"items":[1,true,null,"value"]}}',
  ' \n[{}, [], "escaped \\"quote\\"", -1.5e3]\n ',
  '"a JSON string"',
  '9007199254740993',
  'false',
  'null',
])('detects valid JSON: %s', text => {
  expect(isJsonToolOutput(text)).toBe(true);
});

test.each([
  '', ' \n ', 'command output', '{"streaming":', '{"trailing":true,}',
  'Output:\n{"value":1}', '{"value":1}\n{"value":2}',
])('keeps non-JSON and incomplete output as text: %s', text => {
  expect(isJsonToolOutput(text)).toBe(false);
});

test('bounds parsing and highlighting work for large tool output', () => {
  const text = JSON.stringify('x'.repeat(MAX_JSON_TOOL_OUTPUT_LENGTH - 2));
  expect(isJsonToolOutput(text)).toBe(true);
  expect(isJsonToolOutput(`${text} `)).toBe(false);
});
