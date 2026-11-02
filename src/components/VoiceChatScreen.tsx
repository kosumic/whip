import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import Mic from 'lucide-react-native/icons/mic';
import MicOff from 'lucide-react-native/icons/mic-off';
import MessageSquare from 'lucide-react-native/icons/message-square';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import SkipForward from 'lucide-react-native/icons/skip-forward';
import X from 'lucide-react-native/icons/x';
import Volume2 from 'lucide-react-native/icons/volume-2';
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';
import Animated, { cancelAnimation, useAnimatedProps, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import type { ChatSpeechTarget } from '../services/chatSpeech';
import { VoiceConversation, type VoiceConversationView } from '../services/voiceConversation';
import { useReducedMotion } from './app-ui';
import { useTheme } from '../theme';
import { Button } from './ui/button';
import { Text } from './ui/text';
import { GlassPortal } from './GlassSurface';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const ORB_SIZE = 264;
const FLOATING_ORB_SIZE = 64;
const INITIAL: VoiceConversationView = { phase: 'starting', muted: false, smartTurn: false, speaker: false, text: '', level: 0, progress: 0, error: null, transcript: null };
const STATUS = {
  starting: 'voiceChat.starting',
  setup: 'voiceChat.setup', preparing: 'voiceChat.preparing', listening: 'voiceChat.listening',
  finishing: 'voiceChat.finishing', waiting: 'voiceChat.waiting', speaking: 'voiceChat.speaking',
  muted: 'voiceChat.muted', closed: 'voiceChat.closed', error: 'voiceChat.error',
} as const;

function VoiceOrb({ view, size = ORB_SIZE }: { view: VoiceConversationView; size?: number }) {
  const reducedMotion = useReducedMotion();
  const time = useSharedValue(0);
  const level = useSharedValue(0);
  const phase = view.phase;
  const muted = view.muted;
  useEffect(() => {
    if (!reducedMotion && phase !== 'error' && phase !== 'muted') time.value = withRepeat(withTiming(Math.PI * 2, { duration: phase === 'speaking' ? 2600 : 5200 }), -1, true);
    else cancelAnimation(time);
    return () => cancelAnimation(time);
  }, [reducedMotion, time, phase]);
  useEffect(() => { level.value = reducedMotion ? 0 : withTiming(Math.min(view.level * 6, 1), { duration: 120 }); }, [level, reducedMotion, view.level]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: 1 + level.value * 0.06 }], opacity: muted || phase === 'error' ? 0.45 : 1 }));
  const wave = useAnimatedProps(() => {
    const y = 150 + Math.sin(time.value) * 20;
    const height = 38 + Math.cos(time.value * 2) * 26 + level.value * 30;
    return { d: `M -40 ${y + 50} C 48 ${y + height} 120 ${y - height} 304 ${y - 50} L 304 304 L -40 304 Z` };
  });
  return <Animated.View pointerEvents="none" style={[styles.orb, { width: size, height: size, borderRadius: size / 2 }, style]}>
    <Svg width={size} height={size} viewBox="0 0 264 264">
      <Defs>
        <RadialGradient id="voiceBase" cx="35%" cy="20%" r="90%"><Stop offset="0" stopColor="#b96df5" /><Stop offset="0.6" stopColor="#a848ec" /><Stop offset="1" stopColor="#dfb8ff" /></RadialGradient>
        <LinearGradient id="voiceWave" x1="0" y1="0" x2="0.4" y2="1"><Stop offset="0" stopColor="#faf2ff" stopOpacity="0.88" /><Stop offset="1" stopColor="#d6a2fa" stopOpacity="0.5" /></LinearGradient>
      </Defs>
      <Circle cx="132" cy="132" r="132" fill="url(#voiceBase)" />
      <AnimatedPath animatedProps={wave} fill="url(#voiceWave)" />
    </Svg>
  </Animated.View>;
}

interface VoiceChatScreenProps {
  target: ChatSpeechTarget;
  send: (text: string) => boolean;
  visible: boolean;
  expanded: boolean;
  floatingStyle: ComponentProps<typeof Animated.View>['style'];
  onMinimize: () => void;
  onExpand: () => void;
  onClose: () => void;
}

/** Owns the call independently of its full-screen or floating presentation. */
export function VoiceChatScreen({ target, send, visible, expanded, floatingStyle, onMinimize, onExpand, onClose }: VoiceChatScreenProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [view, setView] = useState(INITIAL);
  const conversation = useRef<VoiceConversation | null>(null);
  const callbacks = useRef({ send, onClose });
  callbacks.current = { send, onClose };
  const { agent, bindingToken, hostId, label, paneId } = target;
  useEffect(() => {
    let mounted = true;
    const session = new VoiceConversation({ agent, bindingToken, hostId, label, paneId }, text => callbacks.current.send(text), next => { if (mounted) setView(next); });
    conversation.current = session;
    void session.start();
    return () => { mounted = false; void session.close(); conversation.current = null; };
  }, [agent, bindingToken, hostId, label, paneId]);
  useEffect(() => { if (view.phase === 'closed') callbacks.current.onClose(); }, [view.phase]);
  const close = () => { void conversation.current?.close(); callbacks.current.onClose(); };
  const interactive = ['listening', 'muted', 'waiting', 'speaking'].includes(view.phase);
  return <>
    {visible && !expanded && <GlassPortal name={`voice-chat-${bindingToken}`}>
      <Animated.View style={[styles.floating, floatingStyle]}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('voiceChat.reopen')} accessibilityHint={t(STATUS[view.phase])} onPress={onExpand} style={styles.floatingTarget}>
          <VoiceOrb view={view} size={FLOATING_ORB_SIZE} />
        </Pressable>
      </Animated.View>
    </GlassPortal>}
    <Modal visible={visible && expanded} animationType="fade" presentationStyle="fullScreen" onRequestClose={onMinimize}>
    <View style={[styles.screen, { backgroundColor: colors.canvas, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 16 }]}>
      <View className="flex-row items-center justify-between px-6">
        <View className="flex-row items-center gap-2">
          <Button accessibilityLabel={t('voiceChat.minimize')} variant="ghost" className="size-12 rounded-full p-0" onPress={onMinimize}><ChevronDown size={22} color={colors.text} /></Button>
          <View><Text className="text-lg font-medium">{target.label}</Text><Text className="text-xs text-muted-foreground">{t('voiceChat.title')}</Text></View>
        </View>
        <Button accessibilityLabel={t('voiceChat.transcript')} variant="ghost" className="size-12 rounded-full p-0" onPress={onMinimize}><MessageSquare size={22} color={colors.text} /></Button>
      </View>
      <View style={styles.orbSpace}>
        <Pressable accessibilityRole="button" accessibilityLabel={view.phase === 'speaking' ? t('voiceChat.skip') : t('voiceChat.finish')} disabled={view.phase !== 'listening' && view.phase !== 'speaking'} onPress={() => { if (view.phase === 'speaking') void conversation.current?.skip(); else conversation.current?.finish(); }} style={styles.orbTarget}>
          <VoiceOrb view={view} />
        </Pressable>
      </View>
      <View className="items-center gap-3 px-8 pb-8">
        <Text accessibilityLiveRegion="polite" className="text-center text-base font-medium">{t(STATUS[view.phase])}</Text>
        {view.text.length > 0 && <Text numberOfLines={3} className="text-center text-base text-muted-foreground">{view.text}</Text>}
        {!view.smartTurn && (view.phase === 'muted' || (view.phase === 'listening' && !view.text)) &&
          <Button variant="ghost" className="rounded-full px-4" onPress={() => conversation.current?.install()}><Text className="text-sm text-muted-foreground">{t('voiceChat.download')}</Text></Button>}
        {view.phase === 'starting' && <ActivityIndicator color={colors.primary} />}
        {view.phase === 'preparing' && <View className="flex-row items-center gap-3"><ActivityIndicator color={colors.primary} /><Text className="text-sm text-muted-foreground">{view.progress > 0 ? `${Math.round(view.progress * 100)}%` : t('voiceChat.preparingDescription')}</Text></View>}
        {view.error && <Text accessibilityRole="alert" className="text-center text-sm leading-5 text-muted-foreground">{view.error}</Text>}
        {view.phase === 'listening' && !view.text && <Text className="text-center text-sm text-muted-foreground">{t('voiceChat.listeningDescription')}</Text>}
      </View>
      <View className="flex-row items-center justify-center gap-6 px-6">
        <Button accessibilityLabel={t('voiceChat.speaker')} accessibilityState={{ selected: view.speaker }} variant="secondary" className="size-14 rounded-full p-0" disabled={!interactive} onPress={() => conversation.current?.toggleSpeaker()}><Volume2 size={23} color={view.speaker ? colors.primary : colors.text} /></Button>
        <Button accessibilityLabel={view.muted ? t('voiceChat.unmute') : t('voiceChat.mute')} accessibilityState={{ selected: view.muted }} variant="secondary" className="size-16 rounded-full p-0" disabled={!interactive} onPress={() => conversation.current?.toggleMuted()}>{view.muted ? <MicOff size={25} color={colors.text} /> : <Mic size={25} color={colors.text} />}</Button>
        {view.phase === 'speaking' && <Button accessibilityLabel={t('voiceChat.skip')} variant="secondary" className="size-16 rounded-full p-0" onPress={() => { void conversation.current?.skip(); }}><SkipForward size={25} color={colors.text} /></Button>}
        <Button accessibilityLabel={t('voiceChat.end')} className="size-16 rounded-full p-0" onPress={close}><X size={26} color={colors.onPrimary} /></Button>
      </View>
    </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  orbSpace: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: ORB_SIZE + 32 },
  orbTarget: { width: ORB_SIZE, height: ORB_SIZE, alignItems: 'center', justifyContent: 'center' },
  orb: { overflow: 'hidden' },
  floating: { position: 'absolute', right: 20 },
  floatingTarget: { width: FLOATING_ORB_SIZE, height: FLOATING_ORB_SIZE, alignItems: 'center', justifyContent: 'center' },
});
