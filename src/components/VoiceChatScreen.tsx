import { useContext, useEffect, useImperativeHandle, useRef, useState, type ComponentProps, type Ref } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View, type ViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import Mic from 'lucide-react-native/icons/mic';
import MicOff from 'lucide-react-native/icons/mic-off';
import MessageSquare from 'lucide-react-native/icons/message-square';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import X from 'lucide-react-native/icons/x';
import Volume2 from 'lucide-react-native/icons/volume-2';
import Plus from 'lucide-react-native/icons/plus';
import AudioLines from 'lucide-react-native/icons/audio-lines';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { VoiceChatTarget, VoiceConversationView } from '../services/voiceConversation';
import { voiceSessionManager, type VoiceSession } from '../services/voiceSessionManager';
import { VoiceConversationSettingsContext } from '../lib/voiceConversationSettingsContext';
import { Button } from './ui/button';
import { Text } from './ui/text';
import { GlassPortal } from './GlassSurface';
import { VoiceOrb } from './VoiceOrb';
import { VoiceVadSensitivityContext } from '../lib/voiceVadSensitivity';
import { useReducedMotion } from './app-ui';
import { formatUsd } from '../lib/formatUsd';
import { VoiceTranscript } from './VoiceTranscript';

const ORB_SIZE = 208;
const COMPACT_ORB_SIZE = 88;
const TRANSCRIPT_ORB_SIZE = 48;
const CONTROL_SIZE = 44;
const PRESENTATION_DURATION_MS = 380;
const VOICE_COLORS = { canvas: '#000000', text: '#ffffff', muted: '#a3a3a3', control: '#303030', border: '#4b4b4b', accent: '#c797fa' };
const INITIAL: VoiceConversationView = { phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null };
const STATUS = {
  starting: 'voiceChat.starting',
  setup: 'voiceChat.setup', preparing: 'voiceChat.preparing', listening: 'voiceChat.listening',
  finishing: 'voiceChat.finishing', waiting: 'voiceChat.waiting', speaking: 'voiceChat.speaking',
  muted: 'voiceChat.muted', closed: 'voiceChat.closed', error: 'voiceChat.error',
} as const;

interface VoiceChatScreenProps {
  ref?: Ref<VoiceChatHandle>;
  target: VoiceChatTarget;
  send: (text: string) => boolean;
  visible: boolean;
  expanded: boolean;
  dockStyle: ComponentProps<typeof Animated.View>['style'];
  compactComposer?: boolean;
  onComposerHeightChange?: (height: number) => void;
  onMinimize: () => void;
  onExpand: () => void;
  onClose: () => void;
  onCompose?: () => void;
  onAttach?: () => void;
}

export interface VoiceChatHandle { submitted: (text: string) => void }

/** Presents the app-wide call without owning its lifetime. */
export function VoiceChatScreen({ ref, target, send, visible, expanded, dockStyle, compactComposer = true, onComposerHeightChange, onMinimize, onExpand, onClose, onCompose, onAttach }: VoiceChatScreenProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [startedAt, setStartedAt] = useState(Date.now);
  const [view, setView] = useState(INITIAL);
  const messages = view.messages ?? [];
  const hasTranscript = messages.length > 0;
  const orbSize = hasTranscript ? TRANSCRIPT_ORB_SIZE : ORB_SIZE;
  const orbSizeRatio = COMPACT_ORB_SIZE / orbSize;
  const fullOrb = useRef<ViewInstance>(null);
  const compactOrb = useRef<ViewInstance>(null);
  const presentation = useSharedValue(expanded ? 1 : 0);
  const travel = useSharedValue(0);
  const previousExpanded = useRef(expanded);
  const minimizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const transitioning = useRef(false);
  const measureOrbs = () => {
    fullOrb.current?.measureInWindow((_x, fullY, _width, fullHeight) => {
      compactOrb.current?.measureInWindow((_compactX, compactY, _compactWidth, compactHeight) => {
        travel.value = compactY + compactHeight / 2 - fullY - fullHeight / 2;
      });
    });
  };
  useEffect(() => {
    if (expanded && !previousExpanded.current) {
      presentation.value = reducedMotion ? 1 : withTiming(1, { duration: PRESENTATION_DURATION_MS, easing: Easing.inOut(Easing.cubic) });
    } else if (!expanded) presentation.value = 0;
    previousExpanded.current = expanded;
  }, [expanded, presentation, reducedMotion]);
  useEffect(() => () => clearTimeout(minimizeTimer.current), []);
  const chromeMotion = useAnimatedStyle(() => ({ opacity: presentation.value }));
  const orbMotion = useAnimatedStyle(() => ({ transform: [
    { translateY: travel.value * (1 - presentation.value) },
    { scale: orbSizeRatio + (1 - orbSizeRatio) * presentation.value },
  ] }));
  const minimize = (after?: () => void) => {
    if (transitioning.current) return;
    if (!expanded) { after?.(); return; }
    if (reducedMotion) { onMinimize(); after?.(); return; }
    transitioning.current = true;
    measureOrbs();
    presentation.value = withTiming(0, { duration: PRESENTATION_DURATION_MS, easing: Easing.inOut(Easing.cubic) });
    minimizeTimer.current = setTimeout(() => {
      transitioning.current = false;
      onMinimize();
      after?.();
    }, PRESENTATION_DURATION_MS);
  };
  const vadSensitivity = useContext(VoiceVadSensitivityContext);
  const { settings } = useContext(VoiceConversationSettingsContext);
  const conversation = useRef<VoiceSession | null>(null);
  useImperativeHandle(ref, () => ({ submitted: text => conversation.current?.submitted(text) }), []);
  const callbacks = useRef({ send, onClose, vadSensitivity, settings });
  callbacks.current = { send, onClose, vadSensitivity, settings };
  const { agent, bindingToken, hostId, paneId, tabId } = target;
  const latestTarget = useRef(target);
  latestTarget.current = target;
  useEffect(() => {
    const session = voiceSessionManager.start({ kind: 'Agent', target: latestTarget.current }, callbacks.current.send, callbacks.current.settings);
    conversation.current = session;
    setStartedAt(session.startedAt);
    session.setVadSensitivity(callbacks.current.vadSensitivity);
    const unsubscribe = session.subscribe(setView);
    return () => { unsubscribe(); conversation.current = null; };
  }, [agent, hostId, paneId, tabId]);
  useEffect(() => { conversation.current?.setTranscriptBinding(bindingToken); }, [bindingToken]);
  useEffect(() => { conversation.current?.setVadSensitivity(vadSensitivity); }, [vadSensitivity]);
  useEffect(() => { if (view.phase === 'closed') callbacks.current.onClose(); }, [view.phase]);
  const close = () => {
    if (conversation.current) { void voiceSessionManager.hangup(conversation.current); }
    callbacks.current.onClose();
  };
  const interactive = ['listening', 'muted', 'waiting', 'speaking'].includes(view.phase);
  const compose = () => minimize(onCompose);
  const composer = <VoiceComposer label={t('voiceChat.compose', { agent: target.label })}
    muted={view.muted} interactive={interactive} onCompose={compose}
    onAttach={onAttach ? () => minimize(onAttach) : undefined}
    onToggleMuted={() => conversation.current?.toggleMuted()} onClose={close} />;
  return <>
    {visible && <GlassPortal name={`voice-chat-${hostId}-${paneId}`}>
      <Animated.View pointerEvents={expanded ? 'none' : 'box-none'} accessibilityElementsHidden={expanded} importantForAccessibility={expanded ? 'no-hide-descendants' : 'auto'}
        style={[styles.dock, dockStyle, { opacity: expanded ? 0 : 1 }]}>
        <View pointerEvents="box-none" style={styles.compactOrbRow}>
          <View ref={compactOrb} collapsable={false} onLayout={measureOrbs} style={styles.compactTarget}>
            {!expanded && <Pressable accessibilityRole="button" accessibilityLabel={t('voiceChat.reopen')} accessibilityHint={t(STATUS[view.phase])} onPress={onExpand} style={styles.compactTarget}>
              <VoiceOrb view={view} size={COMPACT_ORB_SIZE} startedAt={startedAt} />
            </Pressable>}
          </View>
        </View>
        {compactComposer && <View onLayout={event => onComposerHeightChange?.(Math.round(event.nativeEvent.layout.height))} style={styles.compactComposer}>{!expanded && composer}</View>}
      </Animated.View>
    </GlassPortal>}
    <Modal visible={visible && expanded} animationType="none" transparent statusBarTranslucent navigationBarTranslucent presentationStyle="overFullScreen" onShow={measureOrbs} onRequestClose={() => minimize()}>
    <View style={[styles.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 28 }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop, chromeMotion]} />
      <Animated.View className="flex-row items-center justify-between px-6" style={chromeMotion}>
        <Button accessibilityLabel={t('voiceChat.minimize')} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} onPress={() => minimize()}><ChevronDown size={20} color={VOICE_COLORS.text} /></Button>
        <Text style={styles.agentLabel}>{target.label}</Text>
        <View className="flex-row gap-2">
          <Button accessibilityLabel={t('voiceChat.transcript')} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} onPress={() => minimize()}><MessageSquare size={18} color={VOICE_COLORS.text} /></Button>
          <Button accessibilityLabel={t('voiceChat.speaker')} accessibilityState={{ selected: view.speaker }} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} disabled={!interactive} onPress={() => conversation.current?.toggleSpeaker()}><Volume2 size={19} color={view.speaker ? VOICE_COLORS.accent : VOICE_COLORS.text} /></Button>
        </View>
      </Animated.View>
      {hasTranscript && <Animated.View style={[styles.transcript, chromeMotion]}><VoiceTranscript messages={messages} reducedMotion={reducedMotion} leadCurrentWord={view.provider === 'openai'} /></Animated.View>}
      <View style={hasTranscript ? styles.transcriptOrbSpace : styles.orbSpace}>
        <Pressable ref={fullOrb} onLayout={measureOrbs} accessibilityRole="button" accessibilityLabel={view.phase === 'speaking' ? t('voiceChat.skip') : t('voiceChat.finish')} disabled={view.phase !== 'speaking' && (view.phase !== 'listening' || view.provider === 'openai')} onPress={() => { if (view.phase === 'speaking') void conversation.current?.skip(); else conversation.current?.finish(); }} style={{ width: orbSize, height: orbSize }}>
          <Animated.View style={orbMotion}>{expanded && <VoiceOrb view={view} size={orbSize} startedAt={startedAt} />}</Animated.View>
        </Pressable>
      </View>
      <Animated.View className="items-center gap-3 px-8 pb-5" style={[styles.status, chromeMotion]}>
        <Text accessibilityLiveRegion="polite" className="text-center text-xs" style={styles.statusText}>{t(STATUS[view.phase])}</Text>
        {view.provider === 'openai' && <>
          <Text accessibilityHint={t('voiceProvider.costHint')} className="text-center text-xs" style={styles.statusText}>{typeof view.estimatedUsd === 'number' && Number.isFinite(view.estimatedUsd) && view.estimatedUsd >= 0
            ? t('voiceProvider.costEstimate', { cost: formatUsd(view.estimatedUsd) })
            : t('voiceProvider.costUnknown')}</Text>
        </>}
        {(view.phase === 'starting' || view.phase === 'preparing') && <ActivityIndicator color={VOICE_COLORS.accent} />}
        {view.error && <Text accessibilityRole="alert" className="text-center text-sm leading-5" style={styles.statusText}>{view.error}</Text>}
      </Animated.View>
      <Animated.View style={chromeMotion}>
        {expanded && composer}
      </Animated.View>
    </View>
    </Modal>
  </>;
}

function VoiceComposer({ label, muted, interactive, onCompose, onAttach, onToggleMuted, onClose }: {
  label: string; muted: boolean; interactive: boolean; onCompose: () => void; onAttach?: () => void;
  onToggleMuted: () => void; onClose: () => void;
}) {
  const { t } = useTranslation();
  return <View style={styles.composerRow}>
    <View style={styles.composer}>
      {onAttach && <Button accessibilityLabel={t('terminal.attach')} variant="ghost" size="icon" className="rounded-full p-0" onPress={onAttach}><Plus size={24} color={VOICE_COLORS.text} /></Button>}
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onCompose} style={styles.composeTarget}>
        <Text numberOfLines={1} style={styles.composeText}>{label}</Text>
        <View style={styles.composerActivity}><AudioLines size={16} color={VOICE_COLORS.text} /></View>
      </Pressable>
    </View>
    <Button accessibilityLabel={muted ? t('voiceChat.unmute') : t('voiceChat.mute')} accessibilityState={{ selected: muted }} variant="ghost" size="icon" className="rounded-full p-0" style={styles.control} disabled={!interactive} onPress={onToggleMuted}>{muted ? <MicOff size={22} color={VOICE_COLORS.text} /> : <Mic size={22} color={VOICE_COLORS.text} />}</Button>
    <Button accessibilityLabel={t('voiceChat.end')} variant="ghost" size="icon" className="rounded-full p-0" style={styles.hangup} onPress={onClose}><X size={24} color={VOICE_COLORS.canvas} /></Button>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  backdrop: { backgroundColor: VOICE_COLORS.canvas },
  control: { backgroundColor: VOICE_COLORS.control, borderWidth: 1, borderColor: VOICE_COLORS.border },
  hangup: { backgroundColor: VOICE_COLORS.text },
  agentLabel: { flex: 1, marginHorizontal: 12, color: VOICE_COLORS.muted, fontSize: 12 },
  status: { minHeight: 48 },
  statusText: { color: VOICE_COLORS.muted },
  composerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 24 },
  composer: { flex: 1, height: CONTROL_SIZE, borderRadius: CONTROL_SIZE / 2, borderWidth: 1, borderColor: VOICE_COLORS.border, backgroundColor: VOICE_COLORS.control, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  composeTarget: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: CONTROL_SIZE, paddingLeft: 4, paddingRight: 12, gap: 8 },
  composeText: { flex: 1, color: VOICE_COLORS.muted, fontSize: 18 },
  composerActivity: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: VOICE_COLORS.accent, alignItems: 'center', justifyContent: 'center' },
  orbSpace: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: ORB_SIZE + 32, paddingTop: ORB_SIZE / 3 },
  transcript: { flex: 1, minHeight: 0 },
  transcriptOrbSpace: { alignItems: 'center', justifyContent: 'center', height: TRANSCRIPT_ORB_SIZE + 20 },
  dock: { position: 'absolute', left: 0, right: 0 },
  compactOrbRow: { height: COMPACT_ORB_SIZE + 64, alignItems: 'center', justifyContent: 'center' },
  compactTarget: { width: COMPACT_ORB_SIZE, height: COMPACT_ORB_SIZE, alignItems: 'center', justifyContent: 'center' },
  compactComposer: { height: CONTROL_SIZE + 16, paddingBottom: 16 },
});
