// Keep both editors within the Rust tool/profile document limit, including CJK
// and emoji. A UTF-16 maxLength alone cannot enforce a UTF-8 byte limit.
export const MAX_AGENT_INSTRUCTIONS_BYTES = 32 * 1024;

export function limitAgentInstructions(value: string): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > MAX_AGENT_INSTRUCTIONS_BYTES) break;
    bytes += size;
    end += character.length;
  }
  return value.slice(0, end);
}
