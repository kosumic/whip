import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import WebView from 'react-native-webview';
import type { VoiceConversationView } from '../services/voiceConversation';
import { recordDiagnostic } from '../services/diagnosticFormatting';
import { useReducedMotion } from './app-ui';
import { VOICE_ORB_HTML } from './voiceOrbScene';

const SOURCE = { html: VOICE_ORB_HTML };
const ORIGIN = ['about:blank'];

export function VoiceOrb({ view, size }: { view: VoiceConversationView; size: number }) {
  const reducedMotion = useReducedMotion();
  const web = useRef<WebView>(null);
  const activity = Math.max(view.muted ? 0 : view.level, view.phase === 'speaking' ? view.playbackLevel ?? 0 : 0);
  const scale = useSharedValue(1);
  useEffect(() => {
    const target = 0.92 + Math.min(Math.sqrt(activity) * 2, 1) * 0.18;
    scale.value = reducedMotion ? 1 : withTiming(target, { duration: target > scale.value ? 80 : 240 });
  }, [activity, reducedMotion, scale]);
  const motion = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const state = useRef({ level: activity, speaking: view.phase === 'speaking', reducedMotion });
  state.current = { level: activity, speaking: view.phase === 'speaking', reducedMotion };
  const update = useCallback(() => web.current?.injectJavaScript(`window.setVoiceState?.(${JSON.stringify(state.current)});true;`), []);
  useEffect(update, [update, activity, view.phase, reducedMotion]);
  return <Animated.View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.orb, { width: size, height: size, borderRadius: size / 2, opacity: view.phase === 'error' ? 0.65 : 1 }, motion]}>
    <WebView ref={web} source={SOURCE} originWhitelist={ORIGIN} style={styles.scene}
      scrollEnabled={false} bounces={false} javaScriptEnabled domStorageEnabled={false}
      allowsInlineMediaPlayback mediaPlaybackRequiresUserAction
      onLoadEnd={update} onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
      onMessage={event => recordDiagnostic('warn', 'VoiceChat', 'orb-renderer', { error: event.nativeEvent.data })} />
  </Animated.View>;
}

const styles = StyleSheet.create({
  orb: { overflow: 'hidden', backgroundColor: '#b575f5' },
  scene: { flex: 1, backgroundColor: 'transparent' },
});
