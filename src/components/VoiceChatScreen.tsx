import { useContext, useEffect, useImperativeHandle, useRef, useState, type ComponentProps, type Ref } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View, type ViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import Mic from 'lucide-react-native/icons/mic';
import MicOff from 'lucide-react-native/icons/mic-off';
import MessageSquare from 'lucide-react-native/icons/message-square';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import SkipForward from 'lucide-react-native/icons/skip-forward';
import X from 'lucide-react-native/icons/x';
import Volume2 from 'lucide-react-native/icons/volume-2';
import Plus from 'lucide-react-native/icons/plus';
import AudioLines from 'lucide-react-native/icons/audio-lines';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { VoiceConversation, type VoiceChatTarget, type VoiceConversationView } from '../services/voiceConversation';
import { Button } from './ui/button';
import { Text } from './ui/text';
import { GlassPortal } from './GlassSurface';
import { VoiceOrb } from './VoiceOrb';
import { VoiceVadSensitivityContext } from '../lib/voiceVadSensitivity';
import { useReducedMotion } from './app-ui';

const ORB_SIZE = 256;
const FLOATING_ORB_SIZE = 108;
const PRESENTATION_DURATION_MS = 380;
const ORB_SIZE_RATIO = FLOATING_ORB_SIZE / ORB_SIZE;
const VOICE_COLORS = { canvas: '#000000', text: '#ffffff', muted: '#a3a3a3', control: '#282828', accent: '#c797fa' };
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
  floatingStyle: ComponentProps<typeof Animated.View>['style'];
  onMinimize: () => void;
  onExpand: () => void;
  onClose: () => void;
  onCompose?: () => void;
  onAttach?: () => void;
}

export interface VoiceChatHandle { submitted: (text: string) => void }

/** Owns the call independently of its full-screen or floating presentation. */
export function VoiceChatScreen({ ref, target, send, visible, expanded, floatingStyle, onMinimize, onExpand, onClose, onCompose, onAttach }: VoiceChatScreenProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const startedAt = useRef(Date.now()).current;
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
  const [view, setView] = useState(INITIAL);
  const conversation = useRef<VoiceConversation | null>(null);
  useImperativeHandle(ref, () => ({ submitted: text => conversation.current?.submitted(text) }), []);
  const callbacks = useRef({ send, onClose, vadSensitivity });
  callbacks.current = { send, onClose, vadSensitivity };
  const { agent, bindingToken, hostId, label, paneId } = target;
  const latestTarget = useRef(target);
  latestTarget.current = target;
  useEffect(() => {
    let mounted = true;
    const session = new VoiceConversation(latestTarget.current, text => callbacks.current.send(text), next => { if (mounted) setView(next); });
    conversation.current = session;
    session.setVadSensitivity(callbacks.current.vadSensitivity);
    void session.start();
    return () => { mounted = false; void session.close(); conversation.current = null; };
  }, [agent, hostId, label, paneId]);
  useEffect(() => { conversation.current?.setTranscriptBinding(bindingToken); }, [bindingToken]);
  useEffect(() => { conversation.current?.setVadSensitivity(vadSensitivity); }, [vadSensitivity]);
  useEffect(() => { if (view.phase === 'closed') callbacks.current.onClose(); }, [view.phase]);
  const close = () => { void conversation.current?.close(); callbacks.current.onClose(); };
  const interactive = ['listening', 'muted', 'waiting', 'speaking'].includes(view.phase);
  const compose = () => minimize(onCompose);
  return <>
    {visible && <GlassPortal name={`voice-chat-${hostId}-${paneId}`}>
      <Animated.View pointerEvents={expanded ? 'none' : 'box-none'} style={[styles.floating, floatingStyle, { opacity: expanded ? 0 : 1 }]}>
        <View ref={compactOrb} collapsable={false} onLayout={measureOrbs} style={styles.floatingTarget}>
          {!expanded && <Pressable accessibilityRole="button" accessibilityLabel={t('voiceChat.reopen')} accessibilityHint={t(STATUS[view.phase])} onPress={onExpand} style={styles.floatingTarget}>
            <VoiceOrb view={view} size={FLOATING_ORB_SIZE} startedAt={startedAt} />
          </Pressable>}
        </View>
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
      <View style={styles.orbSpace}>
        <Pressable ref={fullOrb} onLayout={measureOrbs} accessibilityRole="button" accessibilityLabel={view.phase === 'speaking' ? t('voiceChat.skip') : t('voiceChat.finish')} disabled={view.phase !== 'listening' && view.phase !== 'speaking'} onPress={() => { if (view.phase === 'speaking') void conversation.current?.skip(); else conversation.current?.finish(); }} style={styles.orbTarget}>
          <Animated.View style={orbMotion}>{expanded && <VoiceOrb view={view} size={ORB_SIZE} startedAt={startedAt} />}</Animated.View>
        </Pressable>
      </View>
      <Animated.View className="items-center gap-3 px-8 pb-5" style={[styles.status, chromeMotion]}>
        <Text accessibilityLiveRegion="polite" className="text-center text-xs" style={styles.statusText}>{t(STATUS[view.phase])}</Text>
        {(view.phase === 'starting' || view.phase === 'preparing') && <ActivityIndicator color={VOICE_COLORS.accent} />}
        {view.error && <Text accessibilityRole="alert" className="text-center text-sm leading-5" style={styles.statusText}>{view.error}</Text>}
      </Animated.View>
      <Animated.View className="flex-row items-center gap-2 px-6" style={chromeMotion}>
        <View style={styles.composer}>
          {onAttach && <Button accessibilityLabel={t('terminal.attach')} variant="ghost" className="size-11 rounded-full p-0" onPress={() => minimize(onAttach)}><Plus size={20} color={VOICE_COLORS.muted} /></Button>}
          <Pressable accessibilityRole="button" accessibilityLabel={t('voiceChat.compose', { agent: target.label })} onPress={compose} style={styles.composeTarget}><Text numberOfLines={1} style={styles.composeText}>{t('voiceChat.compose', { agent: target.label })}</Text></Pressable>
          <AudioLines size={19} color={VOICE_COLORS.accent} style={styles.composerWave} />
        </View>
        <Button accessibilityLabel={view.muted ? t('voiceChat.unmute') : t('voiceChat.mute')} accessibilityState={{ selected: view.muted }} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} disabled={!interactive} onPress={() => conversation.current?.toggleMuted()}>{view.muted ? <MicOff size={20} color={VOICE_COLORS.text} /> : <Mic size={20} color={VOICE_COLORS.text} />}</Button>
        {view.phase === 'speaking' && <Button accessibilityLabel={t('voiceChat.skip')} variant="ghost" className="size-11 rounded-full p-0" style={styles.control} onPress={() => { void conversation.current?.skip(); }}><SkipForward size={20} color={VOICE_COLORS.text} /></Button>}
        <Button accessibilityLabel={t('voiceChat.end')} variant="ghost" className="size-11 rounded-full p-0" style={styles.hangup} onPress={close}><X size={22} color={VOICE_COLORS.canvas} /></Button>
      </Animated.View>
    </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  backdrop: { backgroundColor: VOICE_COLORS.canvas },
  control: { backgroundColor: VOICE_COLORS.control },
  hangup: { backgroundColor: VOICE_COLORS.text },
  agentLabel: { flex: 1, marginHorizontal: 12, color: VOICE_COLORS.muted, fontSize: 12 },
  status: { minHeight: 48 },
  statusText: { color: VOICE_COLORS.muted },
  composer: { flex: 1, height: 44, borderRadius: 24, backgroundColor: VOICE_COLORS.control, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  composeTarget: { flex: 1, justifyContent: 'center', minHeight: 44, paddingLeft: 10 },
  composeText: { color: VOICE_COLORS.muted, fontSize: 14 },
  composerWave: { marginHorizontal: 12 },
  orbSpace: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: ORB_SIZE + 32, paddingTop: ORB_SIZE / 3 },
  orbTarget: { width: ORB_SIZE, height: ORB_SIZE, alignItems: 'center', justifyContent: 'center' },
  orb: { overflow: 'hidden' },
  floating: { position: 'absolute', left: 20, right: 20, alignItems: 'center' },
  floatingTarget: { width: FLOATING_ORB_SIZE, height: FLOATING_ORB_SIZE, alignItems: 'center', justifyContent: 'center' },
});
