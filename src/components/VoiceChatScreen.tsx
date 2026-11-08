import { useContext, useEffect, useImperativeHandle, useRef, useState, type ComponentProps, type ReactNode, type Ref } from 'react';
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
import type { RealtimeVoiceChatTarget, VoiceConversationView } from '../services/voiceConversation';
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
const ORB_SIZE_RATIO = COMPACT_ORB_SIZE / ORB_SIZE;
const CONTROL_SIZE = 44;
const SCREEN_TOP_GAP = 12;
const SCREEN_BOTTOM_GAP = 28;
const PRESENTATION_DURATION_MS = 380;
const VOICE_COLORS = { canvas: '#000000', text: '#ffffff', muted: '#a3a3a3', control: '#303030', border: '#4b4b4b', accent: '#c797fa' };
const INITIAL: VoiceConversationView = { phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null };
const STATUS = {
  starting: 'voiceChat.starting',
  reconnecting: 'voiceChat.reconnecting',
  setup: 'voiceChat.setup', preparing: 'voiceChat.preparing', listening: 'voiceChat.listening',
  finishing: 'voiceChat.finishing', waiting: 'voiceChat.waiting', speaking: 'voiceChat.speaking',
  muted: 'voiceChat.muted', closed: 'voiceChat.closed', error: 'voiceChat.error',
} as const;

const RECOVERY_REASON = {
  lifetime: 'voiceChat.recoveryLifetime', drain_deadline: 'voiceChat.recoveryDrain', connection_lost: 'voiceChat.recoveryConnection',
} as const;

interface VoiceChatScreenProps {
  children?: ReactNode;
  ref?: Ref<VoiceChatHandle>;
  target: RealtimeVoiceChatTarget;
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
export function VoiceChatScreen({ ref, target, send, visible, expanded, dockStyle, compactComposer = true, onComposerHeightChange, onMinimize, onExpand, onClose, onCompose, onAttach, children }: VoiceChatScreenProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [startedAt, setStartedAt] = useState(Date.now);
  const [view, setView] = useState(INITIAL);
  const [headerHeight, setHeaderHeight] = useState(CONTROL_SIZE);
  const [footerHeight, setFooterHeight] = useState(0);
  const messages = view.messages ?? [];
  const hasTranscript = messages.length > 0;
  const estimatedCost = view.provider === 'openai' && typeof view.estimatedUsd === 'number' && Number.isFinite(view.estimatedUsd) && view.estimatedUsd >= 0 ? formatUsd(view.estimatedUsd) : null;
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
    { scale: ORB_SIZE_RATIO + (1 - ORB_SIZE_RATIO) * presentation.value },
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
  const { agent, bindingToken, hostId, paneId, tabId, terminal } = target;
  const isGlobal = 'global' in target && target.global;
  const latestTarget = useRef(target);
  latestTarget.current = target;
  useEffect(() => {
    const currentTarget = latestTarget.current;
    const scope = 'global' in currentTarget ? { kind: 'Global' as const } : currentTarget.terminal ? { kind: 'Terminal' as const, target: currentTarget } : { kind: 'Agent' as const, target: currentTarget };
    const session = voiceSessionManager.start(scope, callbacks.current.send, callbacks.current.settings);
    conversation.current = session;
    setStartedAt(session.startedAt);
    session.setVadSensitivity(callbacks.current.vadSensitivity);
    const unsubscribe = session.subscribe(setView);
    return () => { unsubscribe(); conversation.current = null; };
  }, [isGlobal, agent, hostId, paneId, tabId, terminal?.runtimeId, terminal?.runtimeIncarnation, terminal?.connectionGeneration, terminal?.terminalId, terminal?.paneId]);
  useEffect(() => { conversation.current?.setTranscriptBinding(bindingToken); }, [bindingToken]);
  useEffect(() => { conversation.current?.setVadSensitivity(vadSensitivity); }, [vadSensitivity]);
  useEffect(() => { if (view.phase === 'closed') callbacks.current.onClose(); }, [view.phase]);
  const close = () => {
    if (conversation.current) { void voiceSessionManager.hangup(conversation.current); }
    callbacks.current.onClose();
  };
  const interactive = ['listening', 'muted', 'waiting', 'speaking'].includes(view.phase);
  const status = t((terminal || isGlobal) && view.phase === 'waiting' ? 'voiceChat.terminalWaiting' : STATUS[view.phase]);
  const compose = () => { if (isGlobal) onCompose?.(); else minimize(onCompose); };
  const composer = <VoiceComposer label={isGlobal ? t('globalCall.message') : t('voiceChat.compose', { agent: target.label })}
    muted={view.muted} interactive={interactive} onCompose={compose}
    onAttach={onAttach ? () => minimize(onAttach) : undefined}
    onToggleMuted={() => conversation.current?.toggleMuted()} onClose={close} />;
  return <>
    {visible && <GlassPortal name={isGlobal ? 'global-voice-chat' : `voice-chat-${hostId}-${paneId}`}>
      <Animated.View pointerEvents={expanded ? 'none' : 'box-none'} accessibilityElementsHidden={expanded} importantForAccessibility={expanded ? 'no-hide-descendants' : 'auto'}
        style={[styles.dock, dockStyle, { opacity: expanded ? 0 : 1 }]}>
        <View pointerEvents="box-none" style={styles.compactOrbRow}>
          <View ref={compactOrb} collapsable={false} onLayout={measureOrbs} style={styles.compactTarget}>
            {!expanded && <Pressable accessibilityRole="button" accessibilityLabel={t('voiceChat.reopen')} accessibilityHint={status} onPress={onExpand} style={styles.compactTarget}>
              <VoiceOrb view={view} size={COMPACT_ORB_SIZE} startedAt={startedAt} />
            </Pressable>}
          </View>
        </View>
        {compactComposer && <View onLayout={event => onComposerHeightChange?.(Math.round(event.nativeEvent.layout.height))} style={styles.compactComposer}>{!expanded && composer}</View>}
      </Animated.View>
    </GlassPortal>}
    <Modal visible={visible && expanded} animationType="none" transparent statusBarTranslucent navigationBarTranslucent presentationStyle="overFullScreen" onShow={measureOrbs} onRequestClose={() => minimize()}>
    <View style={[styles.screen, { paddingTop: insets.top + SCREEN_TOP_GAP, paddingBottom: insets.bottom + SCREEN_BOTTOM_GAP }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop, chromeMotion]} />
      {hasTranscript && <Animated.View style={[StyleSheet.absoluteFill, chromeMotion]}>
        <VoiceTranscript messages={messages} reducedMotion={reducedMotion}
          contentInsets={{ top: insets.top + SCREEN_TOP_GAP + headerHeight, bottom: insets.bottom + SCREEN_BOTTOM_GAP + footerHeight }} />
      </Animated.View>}
      <Animated.View pointerEvents="box-none" className="flex-row items-center justify-between px-6" style={chromeMotion}
        onLayout={event => setHeaderHeight(event.nativeEvent.layout.height)}>
        <Button accessibilityLabel={t('voiceChat.minimize')} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} onPress={() => minimize()}><ChevronDown size={20} color={VOICE_COLORS.text} /></Button>
        <Text pointerEvents="none" style={styles.agentLabel}>{isGlobal ? t('globalCall.title') : terminal ? t('voiceChat.terminalScope', { terminal: target.label }) : target.label}</Text>
        <View className="flex-row gap-2">
          <Button accessibilityLabel={t('voiceChat.transcript')} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} onPress={() => minimize()}><MessageSquare size={18} color={VOICE_COLORS.text} /></Button>
          <Button accessibilityLabel={t('voiceChat.speaker')} accessibilityState={{ selected: view.speaker }} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} disabled={!interactive} onPress={() => conversation.current?.toggleSpeaker()}><Volume2 size={19} color={view.speaker ? VOICE_COLORS.accent : VOICE_COLORS.text} /></Button>
        </View>
      </Animated.View>
      <View pointerEvents="box-none" style={hasTranscript ? [styles.transcriptControls, { bottom: insets.bottom + SCREEN_BOTTOM_GAP }] : styles.controls}
        onLayout={event => setFooterHeight(event.nativeEvent.layout.height)}>
        <View pointerEvents="box-none" style={hasTranscript ? styles.transcriptOrbSpace : styles.orbSpace}>
          <Pressable ref={fullOrb} onLayout={measureOrbs} accessibilityRole="button" accessibilityLabel={view.phase === 'speaking' ? t('voiceChat.skip') : t('voiceChat.finish')} disabled={view.phase !== 'speaking' && (view.phase !== 'listening' || view.provider === 'openai')} onPress={() => { if (view.phase === 'speaking') void conversation.current?.skip(); else conversation.current?.finish(); }} style={{ width: ORB_SIZE, height: ORB_SIZE }}>
            <Animated.View style={orbMotion}>{expanded && <VoiceOrb view={view} size={ORB_SIZE} startedAt={startedAt} />}</Animated.View>
          </Pressable>
        </View>
        <Animated.View pointerEvents="none" className="items-center gap-3 px-8 pb-5" style={[styles.status, chromeMotion]}>
          <Text accessibilityLiveRegion="polite" className="text-center text-xs" style={styles.statusText}>{status}</Text>
          {view.phase === 'reconnecting' && view.continuity?.lastReason && <Text className="text-center text-xs" style={styles.statusText}>{t(RECOVERY_REASON[view.continuity.lastReason])}</Text>}
          {view.continuity && view.continuity.sessions > 1 && <Text className="text-center text-xs" style={styles.statusText}>{t('voiceChat.freshSessions', { count: view.continuity.sessions })}</Text>}
          {estimatedCost !== null && <Text accessibilityHint={t('voiceProvider.costHint')} className="text-center text-xs" style={styles.statusText}>{t(view.costIncomplete ? 'voiceUsage.partialEstimate' : 'voiceProvider.costEstimate', { cost: estimatedCost })}</Text>}
          {view.liveSeconds != null && <Text className="text-center text-xs" style={styles.statusText}>{t('voiceUsage.liveDuration', { seconds: Math.ceil(view.liveSeconds) })}</Text>}
          {!hasTranscript && view.backendText && <Text selectable numberOfLines={4} className="text-center text-sm" style={styles.statusText}>{view.backendText}</Text>}
          {(view.phase === 'starting' || view.phase === 'preparing') && <ActivityIndicator color={VOICE_COLORS.accent} />}
          {view.error && <Text accessibilityRole="alert" className="text-center text-sm leading-5" style={styles.statusText}>{view.error}</Text>}
        </Animated.View>
        <Animated.View pointerEvents="box-none" style={chromeMotion}>
          {expanded && composer}
        </Animated.View>
      </View>
      {children}
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
    <Button accessibilityLabel={muted ? t('voiceChat.unmute') : t('voiceChat.mute')} accessibilityState={{ selected: muted }} variant="ghost" size="icon" className="rounded-full p-0" style={styles.control} disabled={!interactive} onPress={onToggleMuted}>{muted ? <Mic size={22} color={VOICE_COLORS.text} /> : <MicOff size={22} color={VOICE_COLORS.text} />}</Button>
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
  controls: { flex: 1 },
  transcriptControls: { position: 'absolute', left: 0, right: 0 },
  transcriptOrbSpace: { alignItems: 'center', justifyContent: 'center', height: ORB_SIZE + 20 },
  dock: { position: 'absolute', left: 0, right: 0 },
  compactOrbRow: { height: COMPACT_ORB_SIZE + 64, alignItems: 'center', justifyContent: 'center' },
  compactTarget: { width: COMPACT_ORB_SIZE, height: COMPACT_ORB_SIZE, alignItems: 'center', justifyContent: 'center' },
  compactComposer: { height: CONTROL_SIZE + 16, paddingBottom: 16 },
});
