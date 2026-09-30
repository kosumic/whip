// Bound synchronous parsing and highlighting on the chat UI thread.
export const MAX_JSON_TOOL_OUTPUT_LENGTH = 64 * 1024;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function parseJsonToolOutput(text: string): { value: JsonValue } | null {
  if (text.length > MAX_JSON_TOOL_OUTPUT_LENGTH || !text.trim()) return null;
  try {
    return { value: JSON.parse(text) as JsonValue };
  } catch {
    return null;
  }
}

export function isJsonToolOutput(text: string): boolean {
  return parseJsonToolOutput(text) !== null;
}
