import { useCallback, useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
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
  const state = useRef({ level: view.level, speaking: view.phase === 'speaking', reducedMotion });
  state.current = { level: view.level, speaking: view.phase === 'speaking', reducedMotion };
  const update = useCallback(() => web.current?.injectJavaScript(`window.setVoiceState?.(${JSON.stringify(state.current)});true;`), []);
  useEffect(update, [update, view.level, view.phase, reducedMotion]);
  return <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.orb, { width: size, height: size, borderRadius: size / 2, opacity: view.phase === 'error' ? 0.65 : 1 }]}>
    <WebView ref={web} source={SOURCE} originWhitelist={ORIGIN} style={styles.scene}
      scrollEnabled={false} bounces={false} javaScriptEnabled domStorageEnabled={false}
      allowsInlineMediaPlayback mediaPlaybackRequiresUserAction
      onLoadEnd={update} onShouldStartLoadWithRequest={request => request.url === 'about:blank'}
      onMessage={event => recordDiagnostic('warn', 'VoiceChat', 'orb-renderer', { error: event.nativeEvent.data })} />
  </View>;
}

const styles = StyleSheet.create({
  orb: { overflow: 'hidden', backgroundColor: '#b575f5' },
  scene: { flex: 1, backgroundColor: 'transparent' },
});
