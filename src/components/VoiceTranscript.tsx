import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import type { VoiceTranscriptMessage } from '../services/voiceConversation';
import { Text } from './ui/text';

const COLORS = { text: '#ffffff', upcoming: '#777777', bubble: '#282828', accent: '#c797fa' };
const FOLLOW_MARGIN = 56;
const WORDS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*|[^\s]/gu;

/** Three text runs keep streaming updates cheap, even for long replies. */
export function spokenTextParts(message: VoiceTranscriptMessage): [string, string, string] {
  let cursor = Math.max(0, Math.min(message.text.length, message.spokenUtf16));
  // Interpolated native offsets can fall between an emoji's UTF-16 surrogates.
  if (cursor > 0 && (message.text.codePointAt(cursor - 1) ?? 0) > 0xffff) cursor--;
  if (!message.active || cursor === 0) return [message.text.slice(0, cursor), '', message.text.slice(cursor)];
  for (const match of message.text.matchAll(WORDS)) {
    const start = match.index;
    if (start + match[0].length > cursor) return [message.text.slice(0, start), match[0], message.text.slice(start + match[0].length)];
  }
  return [message.text, '', ''];
}

export function VoiceTranscript({ messages, reducedMotion }: { messages: readonly VoiceTranscriptMessage[]; reducedMotion: boolean }) {
  const { t } = useTranslation();
  const scroll = useRef<ScrollViewInstance>(null);
  const positions = useRef(new Map<string, { y: number; lines?: readonly { text: string; y: number }[] }>());
  const height = useRef(0);
  const offset = useRef(0);
  const following = useRef(true);
  const dragging = useRef(false);
  const [detached, setDetached] = useState(false);
  const active = [...messages].reverse().find(message => message.active);
  const latest = active ?? messages.at(-1);
  const follow = () => {
    if (!following.current) return;
    const position = latest && positions.current.get(latest.id);
    if (position && active) {
      let end = 0;
      const line = position.lines?.find(candidate => {
        const start = active.text.indexOf(candidate.text, end);
        end = (start < 0 ? end : start) + candidate.text.length;
        return end > active.spokenUtf16;
      });
      const y = position.y + (line?.y ?? 0);
      if (y < offset.current || y > offset.current + height.current * 0.6) {
        scroll.current?.scrollTo({ y: Math.max(0, y - height.current * 0.35), animated: !reducedMotion });
      }
    } else scroll.current?.scrollToEnd({ animated: !reducedMotion });
  };
  useEffect(() => {
    const ids = new Set(messages.map(message => message.id));
    for (const id of positions.current.keys()) if (!ids.has(id)) positions.current.delete(id);
    follow();
  });
  return <View style={styles.container}>
    <ScrollView ref={scroll} style={styles.container} contentContainerStyle={styles.content}
      onLayout={event => { height.current = event.nativeEvent.layout.height; follow(); }}
      onContentSizeChange={follow}
      onScrollBeginDrag={() => { dragging.current = true; following.current = false; setDetached(true); }}
      onScrollEndDrag={() => { dragging.current = false; }}
      onScroll={event => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        offset.current = contentOffset.y;
        if (!dragging.current && contentSize.height - contentOffset.y - layoutMeasurement.height < FOLLOW_MARGIN) {
          following.current = true; setDetached(false);
        }
      }} scrollEventThrottle={100}>
      {messages.map(message => {
        const [heard, current, upcoming] = spokenTextParts(message);
        return <View key={message.id} style={message.role === 'user' ? styles.user : styles.assistant}
          onLayout={event => { positions.current.set(message.id, { ...positions.current.get(message.id), y: event.nativeEvent.layout.y }); follow(); }}>
          {message.role === 'user' ? <Text selectable style={styles.userText}>{message.text}</Text>
            : <Text selectable accessibilityLabel={message.text} style={styles.assistantText}
              onTextLayout={event => { positions.current.set(message.id, { y: positions.current.get(message.id)?.y ?? 0, lines: event.nativeEvent.lines }); follow(); }}>
              <Text style={styles.heard}>{heard}</Text><Text style={styles.current}>{current}</Text><Text style={styles.upcoming}>{upcoming}</Text>
            </Text>}
        </View>;
      })}
    </ScrollView>
    {detached && <Pressable accessibilityRole="button" accessibilityLabel={t('voiceChat.latest')} style={styles.latest}
      onPress={() => { following.current = true; setDetached(false); follow(); }}><ChevronDown color={COLORS.accent} size={20} /></Pressable>}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0 },
  content: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 36, gap: 28 },
  user: { alignSelf: 'flex-end', maxWidth: '88%', backgroundColor: COLORS.bubble, borderRadius: 20, paddingHorizontal: 18, paddingVertical: 12 },
  assistant: { alignSelf: 'stretch' },
  userText: { color: COLORS.text, fontSize: 18, lineHeight: 28 },
  assistantText: { color: COLORS.upcoming, fontSize: 22, lineHeight: 34 },
  heard: { color: COLORS.text },
  current: { color: COLORS.text, fontWeight: '600' },
  upcoming: { color: COLORS.upcoming },
  latest: { position: 'absolute', bottom: 12, alignSelf: 'center', backgroundColor: COLORS.bubble, borderRadius: 22, padding: 12 },
});
