import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { clearAgentTranscriptCache, getAgentTranscriptCacheSize } from 'react-native-whip-ssh';
import { formatRemoteFileSize } from '../lib/remoteFiles';
import { operationalErrorDetails, recordOperationalDiagnostic } from '../services/operationalDiagnostics';
import { hapticPress } from '../services/interactionFeedback';
import { ConfirmationPopup } from './ConfirmationPopup';
import { AppAlertPopup, type AppAlertContent } from './AppAlertPopup';
import { GlassButton } from './GlassControls';
import { Text } from './ui/text';

export function ChatCacheSetting() {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AppAlertContent | null>(null);
  const [bytes, setBytes] = useState<number | null>();
  const sizeRequest = useRef(0);
  const refreshSize = useCallback(async () => {
    const request = ++sizeRequest.current;
    try {
      const next = await getAgentTranscriptCacheSize();
      if (request === sizeRequest.current) setBytes(next);
    } catch (error) {
      if (request !== sizeRequest.current) return;
      setBytes(null);
      recordOperationalDiagnostic('warn', 'Application', 'chat-cache-size-failed', operationalErrorDetails(error));
    }
  }, []);
  // CollapsibleSectionCard mounts this control when Herd expands. No timers or
  // foreground listeners: another expansion explicitly refreshes the snapshot.
  useEffect(() => {
    void refreshSize();
    return () => { sizeRequest.current += 1; };
  }, [refreshSize]);
  const clearing = useRef(false);
  const clear = async () => {
    if (clearing.current) return;
    clearing.current = true;
    setBusy(true);
    try {
      await clearAgentTranscriptCache();
      await refreshSize();
      setConfirming(false);
      setResult({ title: t('settings.chatCacheCleared'), message: t('settings.chatCacheClearedCopy') });
    } catch (error) {
      setConfirming(false);
      recordOperationalDiagnostic('warn', 'Application', 'chat-cache-clear-failed', operationalErrorDetails(error));
      setResult({ title: t('settings.chatCacheClearFailed'), message: t('settings.chatCacheClearFailedCopy') });
    } finally {
      clearing.current = false;
      setBusy(false);
    }
  };
  const size = bytes === undefined ? t('settings.chatCacheSizeLoading')
    : bytes === null ? t('settings.chatCacheSizeUnavailable') : formatRemoteFileSize(bytes);
  const label = `${t(busy ? 'settings.clearingChatCache' : 'settings.clearChatCache')} · ${size}`;
  return <View className="border-t border-border px-4 py-4">
    <Text className="mb-3 text-xs leading-[17px] text-muted-foreground">{t('settings.chatCacheCopy')}</Text>
    <GlassButton variant="secondary" disabled={busy} accessibilityLabel={label}
      onPress={hapticPress(() => setConfirming(true))}>
      <Text>{label}</Text>
    </GlassButton>
    <ConfirmationPopup visible={confirming} busy={busy} title={t('settings.clearChatCache')}
      detail={t('settings.chatCacheSize', { size })}
      copy={t('settings.clearChatCacheCopy')} confirmLabel={t(busy ? 'settings.clearingChatCache' : 'settings.clearChatCache')}
      onCancel={() => setConfirming(false)} onConfirm={() => { void clear(); }} />
    <AppAlertPopup visible={result !== null} title={result?.title ?? ''} message={result?.message}
      onClose={() => setResult(null)} />
  </View>;
}
