// Bound synchronous parsing and highlighting on the chat UI thread.
export const MAX_JSON_TOOL_OUTPUT_LENGTH = 64 * 1024;
const SMALL_JSON_MAX_LENGTH = 1000;
const SMALL_JSON_MAX_LINES = 20;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function isSmallJsonToolOutput(value: JsonValue): boolean {
  try {
    // Reject large values before allocating an indented copy.
    if (JSON.stringify(value).length > SMALL_JSON_MAX_LENGTH) return false;
    const formatted = JSON.stringify(value, null, 2);
    return formatted.length <= SMALL_JSON_MAX_LENGTH && formatted.split('\n').length <= SMALL_JSON_MAX_LINES;
  } catch {
    // Deeply nested output can exceed the serializer's stack limit.
    return false;
  }
}

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
