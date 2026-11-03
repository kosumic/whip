import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import WebView from 'react-native-webview';
import type { VoiceConversationView } from '../services/voiceConversation';
import { recordDiagnostic } from '../services/diagnosticFormatting';
import { useReducedMotion } from './app-ui';
import { VOICE_ORB_CANVAS_SCALE, VOICE_ORB_HTML } from './voiceOrbScene';

const SOURCE = { html: VOICE_ORB_HTML };
const ORIGIN = ['about:blank'];

export function VoiceOrb({ view, size, startedAt }: { view: VoiceConversationView; size: number; startedAt: number }) {
  const reducedMotion = useReducedMotion();
  const web = useRef<WebView>(null);
  const canvasSize = size * VOICE_ORB_CANVAS_SCALE;
  const speaking = view.phase === 'speaking';
  const activity = speaking ? view.playbackLevel ?? 0 : view.phase === 'listening' && !view.muted ? view.level : 0;
  const ready = !['starting', 'setup', 'preparing'].includes(view.phase);
  const state = useRef({ level: activity, speaking, ready, reducedMotion });
  state.current = { level: activity, speaking, ready, reducedMotion };
  const update = useCallback(() => web.current?.injectJavaScript(`window.setVoiceState?.(${JSON.stringify({ ...state.current, elapsed: (Date.now() - startedAt) / 1000 })});true;`), [startedAt]);
  useEffect(update, [update, activity, speaking, ready, reducedMotion]);
  // Android's cached texture must contain the padded canvas at peak expansion.
  return <View collapsable={false} renderToHardwareTextureAndroid pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.orb, { width: canvasSize, height: canvasSize, opacity: view.phase === 'error' ? 0.65 : 1 }]}>
    <WebView ref={web} source={SOURCE} originWhitelist={ORIGIN} style={styles.scene}
      androidLayerType="hardware" scrollEnabled={false} bounces={false} javaScriptEnabled domStorageEnabled={false}
      allowsInlineMediaPlayback mediaPlaybackRequiresUserAction
      onLoadEnd={update} onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
      onMessage={event => recordDiagnostic('warn', 'VoiceChat', 'orb-renderer', { error: event.nativeEvent.data })} />
  </View>;
}

const styles = StyleSheet.create({
  orb: { backgroundColor: 'transparent' },
  scene: { flex: 1, backgroundColor: 'transparent' },
});
