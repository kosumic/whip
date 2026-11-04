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
  const highlighted = caption
    ? chatSpeechHighlight(content, caption.spokenUtf16, caption.text, caption.startUtf16)
    : content;
  return <MarkdownText content={highlighted} speechOriginal={caption && highlighted !== content ? content : undefined}
    streaming={streaming} variant="transcript" onLinkPress={onLinkPress} />;
}
