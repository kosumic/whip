import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import Volume2 from 'lucide-react-native/icons/volume-2';
import Check from 'lucide-react-native/icons/check';
import { useSectionExpansion } from '../hooks/useSectionExpansion';
import { useOpenAiVoiceCredentialStatus } from '../hooks/useOpenAiVoiceCredentialStatus';
import { CollapsibleSectionCard, SECTION_TITLE_CLASS_NAME } from './CollapsibleSectionCard';
import { useTranslation } from 'react-i18next';
import { deviceLanguage } from '../i18n';
import { getSpeechPlayback, onSpeechBackendChange, speechBackendCommand, systemSpeechVoices, type SpeechVoice, type SpeechBackendAction, type SpeechBackendStatus } from '../services/speechPlayback';
import { formatRemoteFileSize } from '../lib/remoteFiles';
import { hapticPress } from '../services/interactionFeedback';
import { bestEffortCleanup, reportBackgroundFailure } from '../services/backgroundOperations';
import { GlassButton } from './GlassControls';
import { SpeechVoicePicker } from './SpeechVoicePicker';
import { OpenAiVoiceKeySetting } from './OpenAiVoiceKeySetting';
import { OpenAiIcon } from './OpenAiIcon';
import { VoiceConversationSetting, type VoiceConversationSettingHandle } from './VoiceConversationSetting';
import { VoiceConversationProviderSetting } from './VoiceConversationProviderSetting';
import { Input } from './ui/input';
import { Text } from './ui/text';
import { Icon } from './ui/icon';

async function stopPreviewPlayback(owner: string) {
  await getSpeechPlayback().stopAnnouncement(owner);
}

const PREVIEW_TEXT_SAVE_DELAY_MS = 500;
const SPEECH_BACKENDS = ['system', 'phonon', 'openai'] as const;

export function VoiceSettings({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const { expanded: voiceExpanded, toggleExpanded: toggleVoice } = useSectionExpansion('voice', true);
  const { expanded: openaiExpanded, toggleExpanded: toggleOpenai } = useSectionExpansion('openai', true);
  const conversationSetting = useRef<VoiceConversationSettingHandle>(null);
  const [status, setStatus] = useState<SpeechBackendStatus>();
  const [setupBackend, setSetupBackend] = useState<SpeechBackendStatus['backend']>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const [systemVoices, setSystemVoices] = useState<SpeechVoice[]>();
  const [voicesLoading, setVoicesLoading] = useState(false);
  const voicesLoadingRef = useRef(false);
  const [voicesError, setVoicesError] = useState<string>();
  const [previewing, setPreviewing] = useState(false);
  const credential = useOpenAiVoiceCredentialStatus();
  const phononReady = !!status?.supported && status.installed;
  const displayedBackend = setupBackend ?? status?.backend;
  // The open setup tab is presentation state; Rust persists the usable backend.
  // A pending/failed credential check must not overwrite a saved selection.
  const backendToActivate = setupBackend === 'phonon' && !phononReady ? 'system'
    : setupBackend === 'openai' && !credential.ready ? (credential.missing ? 'system' : undefined)
      : setupBackend;
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

  const stopPreviews = useCallback(() => {
    stopPreview();
    return conversationSetting.current?.stopPreview();
  }, [stopPreview]);

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
      if ((action === 'phonon' || action === 'openai') && mounted.current && request.current === id) {
        try {
          const fallback = await speechBackendCommand('system');
          if (mounted.current && request.current === id) setStatus(fallback);
        } catch (fallbackFailure) {
          if (mounted.current && request.current === id) setError(fallbackFailure instanceof Error ? fallbackFailure.message : String(fallbackFailure));
          return;
        }
      }
      if (mounted.current && request.current === id) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (mounted.current && request.current === id) setBusy(false);
    }
  }, [stopPreview]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = onSpeechBackendChange(value => { if (mounted.current) setStatus(value); });
    void run('status');
    void loadSystemVoices();
    const owner = previewOwner.current;
    return () => {
      mounted.current = false; request.current += 1;
      unsubscribe();
      savePreviewText();
      bestEffortCleanup(stopPreviewPlayback(owner), 'voice-preview-unmount');
    };
  }, [loadSystemVoices, run, savePreviewText]);
  useEffect(() => {
    if (backendToActivate) void run(backendToActivate);
  }, [backendToActivate, run]);
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
  const previewLanguage = status?.backend === 'phonon' ? 'en-US' : status?.backend === 'openai' ? '' : systemVoices?.find(voice => voice.id === status?.systemVoice)?.language ?? '';
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
  const previewControls = <View className="gap-2 border-t border-border px-3.5 pt-3.5">
    <Text className="text-[15px] font-semibold">{t('speech.previewTextLabel')}</Text>
    <Input value={previewText} onChangeText={changePreviewText} onBlur={savePreviewText}
      accessibilityLabel={t('speech.previewTextLabel')} editable={previewTextReady}
      className="h-28" multiline textAlignVertical="top" maxLength={status?.maxTextUnits} />
    <GlassButton variant="secondary" disabled={busy || !status || !!status.voiceDownload || !previewTextReady || !previewText.trim() ||
      (status.backend === 'openai' && !previewing && !credential.ready)}
      onPress={hapticPress(() => { void preview(); })}>
      <Text>{t(previewing ? 'speech.stopPreview' : 'speech.preview')}</Text>
    </GlassButton>
  </View>;
  const feedback = <>
      {previewTextError || error || status?.error || status?.fallback ? <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">{previewTextError ?? error ?? status?.error ?? status?.fallback}</Text> : null}
  </>;
  return <>
    <CollapsibleSectionCard title={t('settings.voice')} icon={Volume2}
      expanded={voiceExpanded} onToggle={() => { stopPreview(); toggleVoice(); }} contentClassName="pb-3.5">
      <VoiceConversationProviderSetting />
      {children}
      <View className="border-t border-border px-3.5 pt-3">
        <Text className="text-sm font-medium">{t('speech.backend')}</Text>
      </View>
      <View className="flex-row flex-wrap items-stretch gap-2 px-3.5 pt-3">
        {SPEECH_BACKENDS.map(backend => {
          const disabled = busy || !status || (backend === 'openai' && !credential.ready);
          return <GlassButton key={backend}
            variant={displayedBackend === backend ? 'secondary' : 'ghost'} size="content" role="radio"
            className="min-h-12 flex-1 px-3 py-3"
            accessibilityState={{ selected: displayedBackend === backend, disabled }}
            disabled={disabled}
            onPress={hapticPress(() => {
              if (disabled) return;
              if (setupBackend === backend && backendToActivate) void run(backendToActivate);
              else setSetupBackend(backend);
            })}>
            <Text className="text-center text-sm font-medium">{t(`speech.${backend}`)}</Text>
          </GlassButton>;
        })}
      </View>
      {status && displayedBackend !== status.backend && <Text accessibilityLiveRegion="polite" className="px-3.5 pt-3 text-xs text-muted-foreground">
        {t('speech.activeBackend', { backend: t(`speech.${status.backend}`) })}
      </Text>}
      {displayedBackend === 'openai' && !credential.ready && <Text accessibilityLiveRegion="polite" className="px-3.5 pt-3 text-xs text-muted-foreground">
        {t('speech.openai')}: {t(credential.reason)} {t('openai.configure')}
      </Text>}
      {displayedBackend === 'phonon' && <Text className="px-3.5 pt-3 text-xs leading-[17px] text-muted-foreground">{t('speech.localCopy')}</Text>}
      {displayedBackend === 'phonon' && status?.supported && !status.installed && <Text className="px-3.5 pt-3 text-xs text-muted-foreground">
        {t('speech.phonon')}: {t('providers.downloadRequired')}
      </Text>}
      <View className="mx-3.5 my-3 border-l-2 border-border pl-2">
        {status && displayedBackend === 'system' ? <SpeechVoicePicker title={t('speech.systemVoice')} selected={status.systemVoice}
          voices={installedSystemVoices} disabled={busy} loading={voicesLoading} error={voicesError}
          onOpen={() => { if (!systemVoices) void loadSystemVoices(); }}
          onSelect={id => { void run(`system-voice:${id}`); }} /> : null}
        {status && displayedBackend === 'phonon' ? <SpeechVoicePicker title={t('speech.phononVoice')} selected={status.voice}
          voices={phononVoices} disabled={voiceBusy || !phononReady} onSelect={id => { void run(`voice:${id}`); }}
          onRemove={id => { void run(`remove-voice:${id}`); }} /> : null}
        {status && displayedBackend === 'openai' ? <View className="gap-2">
          <SpeechVoicePicker title={t('speech.openaiVoice')} selected={status.openaiVoice}
            voices={status.openaiVoices.map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), language: '', networkRequired: true }))}
            disabled={busy} onSelect={id => { void run(`openai-voice:${id}`); }} />
          <Text className="text-xs leading-[17px] text-muted-foreground">{t('speech.openaiCopy')}</Text>
        </View> : null}
      </View>
      {previewControls}
      {displayedBackend === 'phonon' && <View className="gap-2 px-3.5 pt-3.5">
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
      </View>}
      <View className="px-3.5">{feedback}</View>
    </CollapsibleSectionCard>
    <CollapsibleSectionCard title={t('openai.title')} iconContent={<OpenAiIcon />}
      accessibilityLabel={credential.ready ? `${t('openai.title')}, ${t('voiceProvider.keySaved')}` : t('openai.title')}
      titleContent={<View className="flex-row items-center gap-2">
        <Text className={SECTION_TITLE_CLASS_NAME}>{t('openai.title')}</Text>
        {credential.ready && <Icon as={Check} size={18} className="text-success" accessible={false} />}
      </View>}
      expanded={openaiExpanded} onToggle={() => { void stopPreviews(); toggleOpenai(); }} contentClassName="pb-3.5">
      <View className="border-b border-border px-3.5 py-3">
        <OpenAiVoiceKeySetting beforeUpdate={stopPreviews} />
      </View>
      <VoiceConversationSetting ref={conversationSetting} credentialSaved={credential.ready} />
    </CollapsibleSectionCard>
  </>;
}
