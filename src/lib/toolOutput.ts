// Bound synchronous parsing and highlighting on the chat UI thread.
export const MAX_JSON_TOOL_OUTPUT_LENGTH = 64 * 1024;

export function isJsonToolOutput(text: string): boolean {
  if (text.length > MAX_JSON_TOOL_OUTPUT_LENGTH || !text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
