import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { hasOpenAiVoiceKey, onOpenAiVoiceCredentialChange, removeOpenAiVoiceKey, saveOpenAiVoiceKey } from '../services/openAiVoiceCredentials';
import { GlassButton } from './GlassControls';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props {
  beforeUpdate?: () => void | Promise<void>;
  onStatusChange?: (saved: boolean | undefined, busy: boolean) => void;
}

/** Both speech and conversation settings edit the same native-only credential. */
export function OpenAiVoiceKeySetting({ beforeUpdate, onStatusChange }: Props) {
  const { t } = useTranslation();
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      const id = ++revision.current;
      void hasOpenAiVoiceKey().then(value => {
        if (mounted.current && revision.current === id) setSaved(value);
      }, () => { if (mounted.current && revision.current === id) setError(true); });
    };
    refresh();
    const unsubscribe = onOpenAiVoiceCredentialChange(refresh, 'after');
    return () => { mounted.current = false; unsubscribe(); };
  }, []);
  useEffect(() => { onStatusChange?.(saved, busy); }, [saved, busy, onStatusChange]);

  const update = async (remove: boolean) => {
    if (busy) return;
    revision.current++;
    setBusy(true); setError(false);
    const draft = key;
    setKey('');
    try {
      await beforeUpdate?.();
      if (remove) await removeOpenAiVoiceKey();
      else await saveOpenAiVoiceKey(draft);
      if (mounted.current) setSaved(!remove);
    } catch {
      // Native exceptions may include arguments; never display or log them.
      if (mounted.current) setError(true);
    } finally { if (mounted.current) setBusy(false); }
  };

  return <View className="gap-2">
    <Text className="text-sm font-medium">{t('voiceProvider.apiKey')}</Text>
    <Text className="text-xs text-muted-foreground">{t('voiceProvider.byok')}</Text>
    <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">{t(saved ? 'voiceProvider.keySaved' : 'voiceProvider.keyNotSaved')}</Text>
    <Input secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none"
      accessibilityLabel={t('voiceProvider.apiKey')} placeholder={t('voiceProvider.keyPlaceholder')}
      editable={!busy} value={key} onChangeText={setKey} />
    <View className="flex-row gap-2">
      <GlassButton disabled={busy || !key.trim()} onPress={() => { void update(false); }}><Text>{t('common.save')}</Text></GlassButton>
      <GlassButton disabled={busy || !saved} onPress={() => { void update(true); }}><Text>{t('voiceProvider.removeKey')}</Text></GlassButton>
    </View>
    {error && <Text accessibilityRole="alert" className="text-xs text-destructive">{t('voiceProvider.credentialError')}</Text>}
  </View>;
}
