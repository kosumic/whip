import { useRef } from 'react';
import { chatSpeechHighlight } from 'react-native-whip-ssh';
import { useSpeechCaption, type SpeechCaptionSource } from '../services/speechCaptions';
import { MarkdownText } from './MarkdownText';

export function ChatSpeechText({ content, source, streaming, onLinkPress }: {
  content: string;
  source?: SpeechCaptionSource;
  streaming: boolean;
  onLinkPress: (link: { url: string }) => void;
}) {
  const caption = useSpeechCaption(source);
  const previous = useRef<{ content: string; session: string; messageId: string; partId: string; highlighted: string } | undefined>(undefined);
  const candidate = caption
    ? chatSpeechHighlight(content, caption.spokenUtf16, caption.text, caption.startUtf16)
    : content;
  const session = caption?.sessionToken ?? caption?.id;
  // The cursor can pass the final word before the next chunk arrives. Keep the
  // last valid word instead of dropping all speech styling for that frame.
  if (!caption || (previous.current && !content.startsWith(previous.current.content)) || previous.current?.session !== session
    || previous.current?.messageId !== caption.messageId || previous.current?.partId !== caption.partId) previous.current = undefined;
  if (previous.current && previous.current.content !== content) previous.current = {
    ...previous.current, content, highlighted: previous.current.highlighted + content.slice(previous.current.content.length),
  };
  if (caption && session && candidate !== content) previous.current = { content, session, messageId: caption.messageId, partId: caption.partId, highlighted: candidate };
  const highlighted = caption ? previous.current?.highlighted ?? candidate : content;
  return <MarkdownText content={highlighted} speechOriginal={caption && highlighted !== content ? content : undefined}
    streaming={streaming} variant="transcript" onLinkPress={onLinkPress} />;
}
