import { createContext } from 'react';
import { DEFAULT_VOICE_CONVERSATION_SETTINGS, type VoiceConversationSettings } from './voiceConversationSettings';

export const VoiceConversationSettingsContext = createContext<{
  settings: VoiceConversationSettings;
  onChange: (settings: VoiceConversationSettings) => void;
}>({ settings: DEFAULT_VOICE_CONVERSATION_SETTINGS, onChange: () => {} });
