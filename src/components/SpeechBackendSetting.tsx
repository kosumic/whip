import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { deviceLanguage } from '../i18n';
import { getSpeechPlayback, speechBackendCommand, systemSpeechVoices, type SpeechVoice, type SpeechBackendAction, type SpeechBackendStatus } from '../services/speechPlayback';
import { formatRemoteFileSize } from '../lib/remoteFiles';
import { hapticPress } from '../services/interactionFeedback';
import { bestEffortCleanup, reportBackgroundFailure } from '../services/backgroundOperations';
import { GlassButton } from './GlassControls';
import { SpeechVoicePicker } from './SpeechVoicePicker';
import { Input } from './ui/input';
import { Text } from './ui/text';

async function stopPreviewPlayback(owner: string) {
  await getSpeechPlayback().stopAnnouncement(owner);
}

const PREVIEW_TEXT_SAVE_DELAY_MS = 500;

export function SpeechBackendSetting() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SpeechBackendStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const [systemVoices, setSystemVoices] = useState<SpeechVoice[]>();
  const [voicesLoading, setVoicesLoading] = useState(false);
  const voicesLoadingRef = useRef(false);
  const [voicesError, setVoicesError] = useState<string>();
  const [previewing, setPreviewing] = useState(false);
  const previewOwner = useRef(`voice-preview-${Date.now()}`);
  const previewSequence = useRef(0);
  const [previewText, setPreviewText] = useState('');
  const previewTextRef = useRef('');
  const previewTextInitialized = useRef(false);
  const previewTextEdited = useRef(false);
  const [previewTextReady, setPreviewTextReady] = useState(false);
  const [previewTextError, setPreviewTextError] = useState<string>();
  const previewTextTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const savePreviewText = useCallback(() => {
    if (previewTextTimer.current) clearTimeout(previewTextTimer.current);
    previewTextTimer.current = undefined;
    if (!previewTextEdited.current) return;
    const text = previewTextRef.current;
    const generation = request.current;
    const save = async () => {
      try {
        const value = await speechBackendCommand(`preview-text:${JSON.stringify(text)}`);
        if (mounted.current && previewTextRef.current === text) {
          setPreviewTextError(undefined);
          if (request.current === generation) setStatus(value);
        }
      } catch (failure) {
        if (mounted.current && previewTextRef.current === text) {
          setPreviewTextError(failure instanceof Error ? failure.message : String(failure));
        }
        throw failure;
      }
    };
    reportBackgroundFailure(save(), 'speech-preview-text-save');
  }, []);

  const loadSystemVoices = useCallback(async () => {
    if (voicesLoadingRef.current) return;
    voicesLoadingRef.current = true;
    setVoicesLoading(true);
    setVoicesError(undefined);
    try {
      const voices = await systemSpeechVoices();
      if (mounted.current) setSystemVoices(voices);
    } catch (failure) {
      if (mounted.current) setVoicesError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      voicesLoadingRef.current = false;
      if (mounted.current) setVoicesLoading(false);
    }
  }, []);

  const stopPreview = useCallback(() => {
    previewSequence.current += 1;
    bestEffortCleanup(stopPreviewPlayback(previewOwner.current), 'voice-preview-stop');
    setPreviewing(false);
  }, []);

  const changePreviewText = (text: string) => {
    previewTextEdited.current = true;
    previewTextRef.current = text;
    setPreviewText(text);
    if (previewing) stopPreview();
    if (previewTextTimer.current) clearTimeout(previewTextTimer.current);
    previewTextTimer.current = setTimeout(savePreviewText, PREVIEW_TEXT_SAVE_DELAY_MS);
  };

  const run = useCallback(async (action: SpeechBackendAction) => {
    const id = ++request.current;
    if (action !== 'status') { stopPreview(); setBusy(true); }
    try {
      const value = await speechBackendCommand(action);
      if (mounted.current && request.current === id) {
        setStatus(value);
        setError(undefined);
      }
    } catch (failure) {
      if (mounted.current && request.current === id) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mounted.current && request.current === id) setBusy(false);
    }
  }, [stopPreview]);
  useEffect(() => {
    mounted.current = true;
    void run('status');
    void loadSystemVoices();
    const owner = previewOwner.current;
    return () => {
      mounted.current = false; request.current += 1;
      savePreviewText();
      bestEffortCleanup(stopPreviewPlayback(owner), 'voice-preview-unmount');
    };
  }, [loadSystemVoices, run, savePreviewText]);
  useEffect(() => {
    if ((!status?.downloading && !status?.voiceDownload) || busy) return;
    const timer = setTimeout(() => { void run('status'); }, 500);
    return () => clearTimeout(timer);
  }, [status, busy, run]);

  const downloadSize = status ? formatRemoteFileSize(status.totalBytes) : '…';
  const progress = status ? Math.min(100, Math.floor(status.downloadedBytes * 100 / status.totalBytes)) : 0;
  const phononVoices = [{ id: 'default', name: t('speech.defaultVoice'), language: 'en', installed: true }, ...(status?.voices ?? [])];
  const installedSystemVoices = [{ id: '', name: t('speech.systemDefault'), language: '' }, ...(systemVoices ?? [])];
  const voiceBusy = busy || !!status?.voiceDownload;
  const previewLanguage = status?.backend === 'phonon' ? 'en-US' : systemVoices?.find(voice => voice.id === status?.systemVoice)?.language ?? '';
  const defaultPreviewText = t('speech.previewText', { lng: status?.backend === 'phonon' ? 'en' : previewLanguage || deviceLanguage() });
  useEffect(() => {
    if (!status || previewTextInitialized.current) return;
    previewTextInitialized.current = true;
    const text = status.previewText ?? defaultPreviewText;
    previewTextRef.current = text;
    setPreviewText(text);
    setPreviewTextReady(true);
  }, [status, defaultPreviewText]);

  const preview = async () => {
    if (previewing) { stopPreview(); return; }
    if (!previewTextRef.current.trim()) return;
    savePreviewText();
    const sequence = ++previewSequence.current;
    setPreviewing(true);
    try {
      const result = await getSpeechPlayback().speakPreview(previewOwner.current, previewTextRef.current, previewLanguage);
      if (result === 'busy' && mounted.current && previewSequence.current === sequence) setError(t('speech.previewBusy'));
    } catch (failure) {
      if (mounted.current && previewSequence.current === sequence) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (mounted.current && previewSequence.current === sequence) setPreviewing(false); }
  };
  return <View className="pb-3.5">
    <View className="px-3.5 pt-3.5 pb-2">
      <Text className="text-[15px] font-semibold">{t('speech.backend')}</Text>
      <Text className="mt-1 text-xs leading-[17px] text-muted-foreground">{t('speech.localCopy')}</Text>
    </View>
    <View className="flex-row items-stretch gap-2 px-3.5">
      <GlassButton variant={status?.backend === 'system' ? 'secondary' : 'ghost'} size="content" role="radio"
        className="min-h-12 flex-1 px-3 py-3" disabled={busy}
        accessibilityState={{ selected: status?.backend === 'system' }}
        onPress={hapticPress(() => { void run('system'); })}>
        <Text className="text-center text-sm font-medium">{t('speech.system')}</Text>
      </GlassButton>
      <GlassButton variant={status?.backend === 'phonon' ? 'secondary' : 'ghost'} size="content" role="radio"
        className="min-h-12 flex-1 px-3 py-3"
        accessibilityState={{ selected: status?.backend === 'phonon' }}
        disabled={busy || !status?.supported || !status.installed}
        onPress={hapticPress(() => { void run('phonon'); })}>
        <Text className="text-center text-sm font-medium">{t('speech.phonon')}</Text>
      </GlassButton>
    </View>
    <View className="mx-3.5 my-3 border-l-2 border-border pl-2">
      {status?.backend === 'system' ? <SpeechVoicePicker title={t('speech.systemVoice')} selected={status.systemVoice}
        voices={installedSystemVoices} disabled={busy} loading={voicesLoading} error={voicesError}
        onOpen={() => { if (!systemVoices) void loadSystemVoices(); }}
        onSelect={id => { void run(`system-voice:${id}`); }} /> : null}
      {status?.backend === 'phonon' ? <SpeechVoicePicker title={t('speech.phononVoice')} selected={status.voice}
        voices={phononVoices} disabled={voiceBusy || !status.installed} onSelect={id => { void run(`voice:${id}`); }}
        onRemove={id => { void run(`remove-voice:${id}`); }} /> : null}
    </View>
    <View className="gap-2 border-t border-border px-3.5 pt-3.5">
      <Text className="text-[15px] font-semibold">{t('speech.previewTextLabel')}</Text>
      <Input value={previewText} onChangeText={changePreviewText} onBlur={savePreviewText}
        accessibilityLabel={t('speech.previewTextLabel')} editable={previewTextReady}
        className="h-28" multiline textAlignVertical="top" maxLength={status?.maxTextUnits} />
      <GlassButton variant="secondary" disabled={busy || !status || !!status.voiceDownload || !previewTextReady || !previewText.trim()}
        onPress={hapticPress(() => { void preview(); })}>
        <Text>{t(previewing ? 'speech.stopPreview' : 'speech.preview')}</Text>
      </GlassButton>
      {status?.voiceDownload ? <>
        <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">{t('speech.voiceProgress', {
          name: status.voices.find(voice => voice.id === status.voiceDownload?.id)?.name,
          progress: Math.floor(status.voiceDownload.downloadedBytes * 100 / status.voiceDownload.totalBytes),
        })}</Text>
        <GlassButton variant="secondary" disabled={busy} onPress={hapticPress(() => { void run('cancel'); })}><Text>{t('common.cancel')}</Text></GlassButton>
      </> : null}
      {status?.supported ? <>
        <Text className="text-xs text-muted-foreground">{status.installed
          ? t('speech.installed', { size: downloadSize })
          : status.downloading ? t('speech.progress', { progress, size: downloadSize })
            : t('speech.downloadSize', { size: downloadSize })}</Text>
        {!status.installed ? <Text className="text-xs text-muted-foreground">{t('speech.storage', { size: formatRemoteFileSize(status.requiredStorageBytes) })}</Text> : null}
        {status.downloading ? <GlassButton variant="secondary" disabled={busy} onPress={hapticPress(() => { void run('cancel'); })}><Text>{t('common.cancel')}</Text></GlassButton>
          : !status.installed ? <GlassButton variant="secondary" disabled={busy} onPress={hapticPress(() => { void run('download'); })}><Text>{t(status.downloadedBytes > 0 ? 'speech.resume' : 'speech.download')}</Text></GlassButton> : null}
        {!status.downloading && (status.installed || status.downloadedBytes > 0) ? <GlassButton variant="ghost" disabled={busy} onPress={hapticPress(() => { void run('delete'); })}><Text className="text-destructive">{t('speech.remove')}</Text></GlassButton> : null}
      </> : status ? <Text className="text-xs text-muted-foreground">{t('speech.unsupported')}</Text> : null}
      {previewTextError || error || status?.error || status?.fallback ? <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">{previewTextError ?? error ?? status?.error ?? status?.fallback}</Text> : null}
    </View>
  </View>;
}
