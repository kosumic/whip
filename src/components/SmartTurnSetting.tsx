import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NativeVoiceChat } from 'react-native-whip-ssh/src/voiceChat';
import { createVoiceChatModel } from '../services/voiceChatModel';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';

/** Model setup owns no microphone, recognizer, or system call. */
export function SmartTurnSetting() {
  const { t } = useTranslation();
  const core = useRef<NativeVoiceChat | null>(null);
  const [loading, setLoading] = useState(true);
  const [installed, setInstalled] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string>();
  const pending = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    pending.current = (async () => {
      try {
        const model = await createVoiceChatModel();
        if (!mounted.current) { model.dispose(); return; }
        core.current = model;
        await model.prepare(false);
        if (mounted.current) setInstalled(model.view().smartTurn);
      } catch (failure) {
        if (mounted.current) setError(String(failure instanceof Error ? failure.message : failure));
      } finally { if (mounted.current) setLoading(false); }
    })();
    return () => {
      mounted.current = false;
      const model = core.current;
      core.current = null;
      model?.close();
      void pending.current.finally(() => model?.dispose());
    };
  }, []);
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => setProgress(Math.min(100, Math.floor((core.current?.view().progress ?? 0) * 100))), 250);
    return () => clearInterval(timer);
  }, [downloading]);
  const download = () => {
    const model = core.current;
    if (!model || downloading) return;
    setDownloading(true);
    setError(undefined);
    pending.current = (async () => {
      try {
        await model.prepare(true);
        if (mounted.current) setInstalled(model.view().smartTurn);
      } catch (failure) {
        if (mounted.current) setError(String(failure instanceof Error ? failure.message : failure));
      } finally { if (mounted.current) setDownloading(false); }
    })();
  };
  return <View className="gap-2 border-t border-border px-3.5 py-3.5">
    <Text className="text-[15px] font-semibold">{t('voiceChat.smartTurn')}</Text>
    <Text className="text-xs leading-[17px] text-muted-foreground">{t('voiceChat.smartTurnDescription')}</Text>
    {installed ? <Text className="text-xs text-muted-foreground">{t('voiceChat.smartTurnInstalled')}</Text>
      : <GlassButton variant="secondary" size="content" className="px-4 py-3" disabled={loading || downloading} onPress={download}>
        <Text className="flex-shrink text-center">{downloading ? t('voiceChat.smartTurnProgress', { progress }) : t('voiceChat.download')}</Text>
      </GlassButton>}
    {error && <Text accessibilityRole="alert" className="text-xs text-destructive">{error}</Text>}
  </View>;
}
