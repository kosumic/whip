import { Directory, Paths } from 'expo-file-system';

/** Shared with Settings so an explicit model download is reused by calls. */
export function voiceChatModelRoot(): string {
  return decodeURIComponent(new Directory(Paths.cache, 'voice-chat').uri.replace(/^file:\/\//, ''));
}

export async function createVoiceChatModel() {
  const { NativeVoiceChat } = await import('react-native-whip-ssh/src/voiceChat');
  return new NativeVoiceChat(voiceChatModelRoot());
}
