import { useSpeechCaption, type SpeechCaptionSource } from '../services/speechCaptions';
import { MarkdownText } from './MarkdownText';

export function ChatSpeechText({ content, source, streaming, onLinkPress }: {
  content: string;
  source?: SpeechCaptionSource;
  streaming: boolean;
  onLinkPress: (link: { url: string }) => void;
}) {
  const caption = useSpeechCaption(source);
  return <MarkdownText content={content} speechCaption={caption ?? undefined}
    streaming={streaming} variant="transcript" onLinkPress={onLinkPress} />;
}
