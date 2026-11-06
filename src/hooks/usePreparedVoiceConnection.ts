import { useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { VoiceConversationSettingsContext } from '../lib/voiceConversationSettingsContext';
import { setVoiceConnectionPreparation } from '../services/voiceConnectionPreparation';

export function usePreparedVoiceConnection(eligible: boolean): void {
  const { settings } = useContext(VoiceConversationSettingsContext);
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  const enabled = settings.keepVoiceClientWarm === true && eligible && active;
  useEffect(() => {
    setVoiceConnectionPreparation(enabled);
    return () => setVoiceConnectionPreparation(false);
  }, [enabled]);
}
