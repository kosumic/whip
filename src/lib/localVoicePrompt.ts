// Transport correlation stays in Rust. Presentation shows the user's words.
const LOCAL_VOICE_MARKER = /^\[Whip local voice [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}; tracking metadata\]\r?\n/i;
export function localVoicePromptText(text: string): string {
  return text.replace(LOCAL_VOICE_MARKER, '');
}
