import { ChatSearchQuery, SearchText } from './SearchText';
import { memo, startTransition, useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  FlashList,
  type FlashListRef,
  type ViewToken,
} from '@shopify/flash-list';
import ArrowDown from 'lucide-react-native/icons/arrow-down';
import Check from 'lucide-react-native/icons/check';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import CircleHelp from 'lucide-react-native/icons/circle-question-mark';
import CircleX from 'lucide-react-native/icons/circle-x';
import Copy from 'lucide-react-native/icons/copy';
import Volume2 from 'lucide-react-native/icons/volume-2';
import VolumeX from 'lucide-react-native/icons/volume-x';
import {
  ActivityIndicator,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import type { HostRuntimeConnection } from 'react-native-whip-ssh';
import type { ChatSearchInitialTarget } from 'react-native-whip-ssh/src/chatSearch';
import { useCopyFeedback } from '../hooks/useCopyFeedback';
import type { ChatReadAloudControl } from '../hooks/useChatReadAloud';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useDecorativeProgress } from '../hooks/useDecorativeProgress';
import { AnimationVisibilityContext } from '../lib/animationVisibility';
import { useChatSearch } from '../hooks/useChatSearch';
import { useChatActivity, type ChatActivity, type ChatToolActivity } from '../hooks/useChatActivity';
import { useScrollActivity } from '../hooks/useScrollActivity';
import { ChatSearchBar, chatSearchBarHeight } from './ChatSearchBar';
import { FLOATING_WARNING_BANNER_HEIGHT, FloatingWarningBanner, FloatingWarningOffsetContext } from './FloatingWarningBanner';

import type {
  AgentChatState,
  TranscriptMessage,
  TranscriptPart,
  TranscriptQuestion,
  TranscriptTurn,
} from '../agentChat';
import { isQuestionTool, isRunningTool as isRunning } from '../lib/agentChatBlocks';
import { resolveChatRow, type ChatBlock, type ChatRow, type ChatRowStore } from '../lib/nativeChatRows';
import { useNativeChatRows } from '../hooks/useNativeChatRows';
import { TranscriptMarkdownImages } from '../hooks/useTranscriptMarkdownImages';
import { nativeTranscriptLookup } from '../lib/nativeAgentTranscript';
import { CHAT_WORKING_LABEL, CHAT_WORKING_SHIMMER_PERIOD_MS, workingShimmerOpacity } from '../lib/chatWorkingAnimation';
import type { ChatViewportState } from '../lib/chatViewportState';
import { chatAgentDisplayName, type ChatAgent } from '../lib/agentChatSession';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from '../services/operationalDiagnostics';
import { recordAgentChatDiagnostic } from '../services/agentChatDiagnostics';
import { reportBackgroundFailure } from '../services/backgroundOperations';
import { hapticPress } from '../services/interactionFeedback';
import { APP_GLASS_BORDER_CLASS_NAME, appGlassBackgroundClassName } from '../lib/appGlass';
import { insetContentPadding, LATEST_BUTTON_CLASS_NAME, LATEST_BUTTON_ICON_SIZE, type VisualContentInsets } from '../lib/floatingChrome';
import { scrollOffsetFromDrag, scrollThumbGeometry } from '../lib/terminalScroll';
import { transcriptFileLinkTarget, type TranscriptFileLinkTarget } from '../lib/transcriptLinks';
import { cn } from '../lib/utils';
import { latestButtonStyle, useTheme } from '../theme';
import type { AgentStatus } from '../types';
import { useReducedMotion } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { MarkdownText } from './MarkdownText';
import { ChatSpeechText } from './ChatSpeechText';
import type { SpeechCaptionSource } from '../services/speechCaptions';
import { SelectableChatText } from './SelectableChatText';
import { ChatComposerSelection } from './ChatComposerSelection';
import { textValue } from '../lib/toolOutput';
import { ChatToolCard, ToolInputDetails, ToolMetadata, ToolOutputBlock, toolPresentation } from './ChatToolCard';
import { formatFullTime, MetadataLine } from './TranscriptMetadata';
import { OverlayScrollbar, type OverlayScrollbarDragEvent } from './OverlayScrollbar';
import { Button } from './ui/button';
import { Text } from './ui/text';
import { ChatPromptImage } from './ChatPromptImage';
import { ChatFileDiff as ToolFileDiffBlock } from './ChatFileDiff';
import type { RemoteFileClient } from '../services/remoteFileTransfer';

interface Props {
  imageClient?: RemoteFileClient;
  searchRuntime?: Pick<HostRuntimeConnection, 'agentTranscriptSearch' | 'agentChatRows'>;
  searchKey?: string;
  savedSearchNamespace?: string;
  initialSearchTarget?: ChatSearchInitialTarget;
  state: AgentChatState;
  /** Run foreground work such as animations, image fetches, and speech highlighting. */
  active?: boolean;
  /** Prepare rows, layout, and scroll position while the layer remains hidden. */
  prewarm?: boolean;
  /** Present the selected conversation and its local controls independently of transport. */
  visible?: boolean;
  agent: ChatAgent;
  agentStatus: AgentStatus;
  contentInsets: VisualContentInsets;
  animatedBottomInset?: SharedValue<number>;
  latestButtonBottom: number;
  searchOpen?: boolean;
  onCloseSearch?: () => void;
  onOpenFile: (target: TranscriptFileLinkTarget) => void;
  onOpenWebLink?: (url: string) => void;
  /** Called once per activation, after the initial or saved viewport is ready. */
  onInitialViewportReady?: () => void;
  savedViewport?: ChatViewportState;
  onSaveViewport?: (state: ChatViewportState) => void;
  readAloud?: ChatReadAloudControl;
}

const CHAT_CONTENT_TOP_GAP = 16;
const CHAT_CONTENT_BOTTOM_GAP = 24;
const CHAT_FOLLOW_END_THRESHOLD = 72;
const nearEnd = (offset: number, maximumOffset: number) =>
  maximumOffset - offset < CHAT_FOLLOW_END_THRESHOLD;
const CHAT_INITIAL_END_THRESHOLD = 2;
const CHAT_SCROLL_OFFSET_EPSILON = 1;
const CHAT_CONTEXT_PREVIEW_LENGTH = 256;
const CHAT_CONTEXT_HEIGHT = 44;
const CHAT_CONTEXT_GAP = 8;
const CHAT_ACTIVITY_TINT_OPACITY = 0.6;
const CHAT_WORKING_TICK_MS = 1_000;
const CHAT_WORKING_LETTERS = Array.from(CHAT_WORKING_LABEL);
const CHAT_WORKING_TEXT_CLASS = 'text-[12px] font-medium leading-4 text-foreground';
const CHAT_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  startRenderingFromBottom: true,
} as const;
const CHAT_VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 0,
  minimumViewTime: 0,
} as const;

interface ChatScrollGeometry {
  contentHeight: number;
  offset: number;
  viewportHeight: number;
}

interface ChatScrollbarDragSnapshot {
  lastOffset: number;
  maxOffset: number;
  startOffset: number;
}

interface InitialViewportReadiness {
  atEnd: boolean;
  contentSizeKnown: boolean;
  itemsLoaded: boolean;
  measuredLatestBlockId: string | null;
  ready: boolean;
  viewableLatestBlockId: string | null;
  viewportLaidOut: boolean;
  positionConfirmed: boolean;
}

type SavedChatViewport = Pick<ChatViewportState, 'offset' | 'followEnd' | 'anchor'>;

function chatContextPreview(text: string): string {
  const prefix = text.slice(0, CHAT_CONTEXT_PREVIEW_LENGTH)
    .replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
    .replace(/[\uD800-\uDBFF]$/u, '');
  return text.length > CHAT_CONTEXT_PREVIEW_LENGTH ? `${prefix}…` : prefix;
}

function reasoningContextPreview(text: string): string {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    let line = lines[index].trim();
    if (!line || line.startsWith('<!--')) continue;
    line = line.replace(/^#+/u, '').trim();
    if (line.startsWith('**')) {
      const end = line.indexOf('**', 2);
      if (end < 0) continue;
      line = line.slice(2, end) + line.slice(end + 2);
    }
    const preview = chatContextPreview(line);
    if (preview) return preview;
  }
  return '';
}

const promptPreviews = new WeakMap<TranscriptMessage, string>();
function promptContextPreview(message: TranscriptMessage): string {
  const cached = promptPreviews.get(message);
  if (cached !== undefined) return cached;
  let text = '';
  for (const part of message.parts) {
    const value = part.type === 'text' ? part.text : part.type === 'image' ? '[Image]' : '';
    if (value) text += `${text ? ' ' : ''}${value.slice(0, CHAT_CONTEXT_PREVIEW_LENGTH + 1 - text.length)}`;
    if (text.length > CHAT_CONTEXT_PREVIEW_LENGTH) break;
  }
  const preview = chatContextPreview(text);
  promptPreviews.set(message, preview);
  return preview;
}

/** Select against the natural viewport edge so showing the header cannot change its owner. */
function usePinnedPrompt(store: ChatRowStore, state: AgentChatState, list: RefObject<FlashListRef<ChatRow> | null>, top: number) {
  const { messages, userRevision } = nativeTranscriptLookup(state);
  const userRows = store.userRows;
  const prompts = useMemo(() => userRows.filter(row => {
    const message = row.type === 'user' ? messages.get(row.messageId) : undefined;
    return message && promptContextPreview(message);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- The shared message index mutates in place; only user edits invalidate prompt previews.
  }), [userRows, messages, userRevision]);
  const [promptId, setPromptId] = useState<string | null>(null);
  const currentId = useRef<string | null>(null);
  const update = useCallback((offset: number) => {
    const edge = offset + top - (list.current?.getFirstItemOffset?.() ?? 0);
    let low = 0;
    let high = prompts.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const layout = list.current?.getLayout?.(store.indexOf(prompts[mid].id));
      if (!layout) return;
      if (layout.y <= edge) low = mid + 1;
      else high = mid;
    }
    const candidate = prompts[low - 1];
    const layout = candidate && list.current?.getLayout?.(store.indexOf(candidate.id));
    // A partially visible prompt supplies its own context, including long prompts.
    const nextId = layout && layout.y + layout.height <= edge ? candidate.id : null;
    if (currentId.current === nextId) return;
    currentId.current = nextId;
    setPromptId(nextId);
  }, [list, prompts, store, top]);
  const index = promptId ? store.indexOf(promptId) : -1;
  const row = store.rows[index];
  const block = row && resolveChatRow(row, state);
  const preview = block?.type === 'user' ? promptContextPreview(block.message) : '';
  return { prompt: preview && row ? { id: row.id, index, preview } : undefined, update };
}

function currentActivity(blocks: ChatRow[], state: AgentChatState, turn?: TranscriptTurn) {
  let summary: ChatActivity | undefined;
  let progress: ChatActivity | undefined;
  let tool: ChatToolActivity | undefined;
  let question: ChatToolActivity | undefined;
  let promptId: string | undefined;
  let beforeLatestPrompt = false;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const row = blocks[index];
    if (row.turnId !== turn?.id) break;
    const block = resolveChatRow(row, state);
    if (!block) continue;
    if (block.type === 'user') {
      promptId ??= block.id;
      beforeLatestPrompt = true;
    }
    if (block.type !== 'part') continue;
    const part = block.part;
    if (part.type === 'tool' && isRunning(part)) {
      const presentation = toolPresentation(part);
      const detail = chatContextPreview(presentation.subtitle ?? '');
      const candidate = { id: block.id, activity: { title: presentation.title, detail } };
      if (isQuestionTool(part)) question ??= { ...candidate, activity: { title: 'Question requested', detail } };
      tool ??= candidate;
    }
    // Codex retains its useful status through tool calls. Some rollouts omit
    // reasoning summaries entirely, but still record assistant progress text.
    if (!beforeLatestPrompt && !summary && part.type === 'reasoning') {
      const preview = reasoningContextPreview(part.text);
      if (preview) summary = { title: preview, detail: '' };
    }
    if (!beforeLatestPrompt && !progress && part.type === 'text') {
      const preview = chatContextPreview(block.streaming ? part.text.slice(-CHAT_CONTEXT_PREVIEW_LENGTH) : part.text);
      if (preview) progress = { title: preview, detail: '' };
    }
  }
  return { summary: summary ?? progress, tool: question ?? tool, promptId };
}

function WorkingLetter({ letter, index, progress, reduceMotion }: {
  letter: string;
  index: number;
  progress: SharedValue<number>;
  reduceMotion: boolean;
}) {
  const style = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 1 : workingShimmerOpacity(progress.value, index),
  }), [index, reduceMotion]);
  return <Animated.View style={style}><Text className={CHAT_WORKING_TEXT_CLASS}>{letter}</Text></Animated.View>;
}

function ChatWorkingStatus({ startedAt, active }: { startedAt?: number; active: boolean }) {
  const { colors } = useTheme();
  const visible = useContext(AnimationVisibilityContext);
  const running = active && visible;
  const reduceMotion = useReducedMotion();
  const [fallbackStartedAt] = useState(Date.now);
  const [now, setNow] = useState(fallbackStartedAt);
  const progress = useDecorativeProgress(running && !reduceMotion, CHAT_WORKING_SHIMMER_PERIOD_MS, false);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CHAT_WORKING_TICK_MS);
    return () => clearInterval(timer);
  }, [running]);
  const start = startedAt ?? fallbackStartedAt;
  const duration = formatDuration(start, Math.max(start, now));
  const label = `${CHAT_WORKING_LABEL} (${duration})`;
  return (
    <View testID="chat-inline-working" className="min-h-11 flex-row items-center gap-2">
      <ActivityIndicator animating={running && !reduceMotion} hidesWhenStopped={false} size={13} color={colors.textTertiary} />
      <View testID="chat-working-status" accessible accessibilityLabel={label} className="flex-row items-center">
        {CHAT_WORKING_LETTERS.map((letter, index) => (
          <WorkingLetter key={index} letter={letter} index={index} progress={progress} reduceMotion={reduceMotion} />
        ))}
        <Text className="text-[12px] font-medium leading-4 text-muted-foreground">{` (${duration})`}</Text>
      </View>
    </View>
  );
}

function ChatActivityStrip({ activity, onPress }: {
  activity: ChatActivity;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const glass = useAppGlassEnabled();
  const visible = useContext(AnimationVisibilityContext);
  const reduceMotion = useReducedMotion();
  return (
    <GlassSurface
      testID="chat-pinned-activity"
      tintOpacity={CHAT_ACTIVITY_TINT_OPACITY}
      className={cn('absolute left-4 right-4 z-20 rounded-xl', glass && APP_GLASS_BORDER_CLASS_NAME)}
      fallbackClassName="border border-border bg-background"
      style={{ bottom: CHAT_CONTEXT_GAP, height: CHAT_CONTEXT_HEIGHT }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Current activity: ${activity.title}${activity.detail ? `, ${activity.detail}` : ''}`}
        accessibilityHint="Jump to the latest output"
        className="min-h-11 flex-row items-center gap-2 px-3"
        onPress={hapticPress(onPress)}
      >
        <ActivityIndicator animating={visible && !reduceMotion} hidesWhenStopped={false} size={13} color={colors.textTertiary} />
        <Text numberOfLines={1} className="min-w-0 flex-1 text-[12px] leading-5 text-foreground">
          {activity.title}{activity.detail ? ` · ${activity.detail}` : ''}
        </Text>
        <ArrowDown size={16} color={colors.textSecondary} />
      </Pressable>
    </GlassSurface>
  );
}

enum ChatScrollInteractionKind {
  AwaitingMomentum = 'awaiting-momentum',
  Dragging = 'dragging',
  Idle = 'idle',
  UserMomentum = 'user-momentum',
}

interface ChatScrollInteraction {
  kind: ChatScrollInteractionKind;
  lastOffset: number;
}

/** A real list item keeps Android's scroll range honest at floating-chrome boundaries. */
function ChatBoundarySpacer({ height }: { height: number }) {
  const style = useMemo(() => ({ height }), [height]);
  return (
    <View
      accessibilityElementsHidden
      collapsable={false}
      pointerEvents="none"
      style={style}
    />
  );
}

interface BlockExpansion {
  expanded: boolean;
  onToggle: () => void;
}

const chatListStyles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: 16,
  },
});

function TranscriptNoticeCard({
  error = false,
  className,
  ...props
}: React.ComponentProps<typeof View> & { error?: boolean }) {
  const glass = useAppGlassEnabled();
  return (
    <GlassSurface
      {...props}
      className={cn(
        'w-full gap-2 rounded-md px-3 py-2.5',
        glass && APP_GLASS_BORDER_CLASS_NAME,
        className,
      )}
      fallbackClassName={error ? 'bg-destructive/10' : 'bg-muted'}
    />
  );
}

function CopyQuestionOption({ option }: { option: TranscriptQuestion['options'][number] }) {
  const { colors } = useTheme();
  const { copied, copyText } = useCopyFeedback();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy option ${option.label}`}
      accessibilityHint="Copies the option label to your clipboard"
      className="min-h-11 flex-row items-center gap-3 rounded-md border border-border px-3 py-2"
      onPress={() => copyText(option.label)}
    >
      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-[13px] font-medium leading-[18px] text-foreground"><SearchText text={option.label} /></Text>
        {option.description && <Text className="text-[12px] leading-[18px] text-muted-foreground"><SearchText text={option.description} /></Text>}
      </View>
      {copied ? <Check size={15} color={colors.done} /> : <Copy size={15} color={colors.textTertiary} />}
    </Pressable>
  );
}

function TranscriptQuestions({ questions }: { questions: readonly TranscriptQuestion[] }) {
  return questions.map((question, index) => (
    <View key={`${index}:${question.question}`} className="gap-2">
      {question.header && <Text className="text-[12px] font-medium text-foreground"><SearchText text={question.header} /></Text>}
      <Text selectable className="text-[12px] leading-[18px] text-muted-foreground"><SearchText text={question.question} /></Text>
      {question.multiple && <Text className="text-[12px] text-muted-foreground">Choose one or more.</Text>}
      {question.options.map((option, optionIndex) => <CopyQuestionOption key={`${optionIndex}:${option.label}`} option={option} />)}
    </View>
  ));
}

function AssistantPart({
  part,
  directory,
  onLinkPress,
  streaming = false,
  expanded,
  onToggle,
  active,
  speechSource,
}: BlockExpansion & {
  active: boolean;
  directory?: string;
  part: TranscriptPart;
  onLinkPress: (url: string) => void;
  streaming?: boolean;
  speechSource?: SpeechCaptionSource;
}) {
  const { colors } = useTheme();
  if (part.type === 'text') {
    if (!part.text.trim()) return null;
    return <View className="min-w-0 w-full"><ChatSpeechText content={part.text} source={speechSource} streaming={streaming} onLinkPress={({ url }) => onLinkPress(url)} /></View>;
  }
  if (part.type === 'reasoning') {
    if (!part.text.trim()) return null;
    return (
      <View className="w-full border-l border-border pl-3 py-0.5">
        <Text className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Thinking</Text>
        <MarkdownText content={part.text} streaming={streaming} variant="transcript" onLinkPress={({ url }) => onLinkPress(url)} />
      </View>
    );
  }
  if (part.type === 'tool' && isQuestionTool(part)) {
    return (
      <TranscriptNoticeCard testID="agent-question-notice">
        <Text className="text-[13px] font-medium text-foreground">Question requested</Text>
        {part.state.questions?.length
          ? <TranscriptQuestions questions={part.state.questions} />
          : <Text selectable className="text-[12px] leading-[18px] text-muted-foreground">
              <SearchText text={textValue(part.state.input.question_summary) || 'The agent requested user input.'} />
            </Text>}
        {part.state.output && <ToolOutputBlock text={part.state.output} bordered />}
        {part.state.error && <ToolOutputBlock text={part.state.error} error />}
        <ToolMetadata item={part} />
        <ToolInputDetails item={part} />
      </TranscriptNoticeCard>
    );
  }
  if (part.type === 'tool') return <ChatToolCard item={part} directory={directory} expanded={expanded} onToggle={onToggle} active={active} onLinkPress={onLinkPress} />;
  if (part.type === 'plan') {
    return <View className="w-full py-1"><Text className="mb-2 text-[13px] font-medium leading-5 text-foreground">Plan</Text><MarkdownText content={part.text} variant="transcript" onLinkPress={({ url }) => onLinkPress(url)} /></View>;
  }
  if (part.type === 'notice') {
    return (
      <TranscriptNoticeCard error={part.level === 'error'} className="flex-row">
        {part.level === 'error' && <CircleAlert size={15} color={colors.error} />}
        <View className="min-w-0 flex-1 gap-2">
          <Text selectable className="text-[12px] leading-[18px] text-muted-foreground"><SearchText text={part.text} /></Text>
          {part.questions && <TranscriptQuestions questions={part.questions} />}
        </View>
      </TranscriptNoticeCard>
    );
  }
  return null;
}

function formatTime(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  try { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return undefined; }
}

function formatDuration(start: number | undefined, end: number | undefined): string | undefined {
  if (start === undefined || end === undefined || end < start) return undefined;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const TOKEN_FIELDS = [
  ['input', 'Input'], ['cacheRead', 'Cache reads'], ['cacheWrite', 'Cache writes'],
  ['output', 'Output'], ['reasoning', 'Reasoning'], ['total', 'Total'],
] as const;

const TURN_OUTCOME_LABELS = { completed: 'Completed', interrupted: 'Interrupted', failed: 'Failed' } as const;

const tokenNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const cachePercentNumber = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const CACHE_STATUS_PRESENTATION = {
  hit: { Icon: CircleCheck, label: 'Cache hit' },
  miss: { Icon: CircleX, label: 'Cache miss' },
  unknown: { Icon: CircleHelp, label: 'Cache unknown' },
} as const;

function cacheUsagePresentation(usage: NonNullable<TranscriptTurn['details']>['usage']) {
  const input = usage?.input;
  const read = usage?.cacheRead;
  const ratio = input !== undefined && Number.isFinite(input) && input > 0
    && read !== undefined && Number.isFinite(read) && read >= 0 && read <= input
    ? read / input : undefined;
  const status = ratio === undefined ? 'unknown' : ratio > 0 ? 'hit' : 'miss';
  const presentation = CACHE_STATUS_PRESENTATION[status];
  const percent = status === 'hit' && ratio !== undefined
    ? ratio < 0.001 ? `<${cachePercentNumber.format(0.001)}` : cachePercentNumber.format(ratio)
    : undefined;
  return { ...presentation, status, percent, label: percent ? `${presentation.label} · ${percent}` : presentation.label };
}

function UserPrompt({ message, imageClient, directory, active, visible }: {
  message: TranscriptMessage;
  imageClient?: RemoteFileClient;
  directory?: string;
  active: boolean;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const { copied, copyText } = useCopyFeedback();
  const parts = message.parts.filter(part => part.type === 'text' || part.type === 'image');
  const text = parts.map(part => part.type === 'image' ? part.source : part.type === 'text' ? part.text : '').join('\n');
  const copyPrompt = () => copyText(text);
  if (!text) return null;
  const meta = formatTime(message.createdAt);
  return (
    <View className="ml-9 items-end">
      <View className="min-h-11 max-w-[86%] gap-2 rounded-xl bg-purple-950 px-3 py-2.5">
        {parts.map(part => part.type === 'image'
          ? <ChatPromptImage key={part.id} source={part.source} client={imageClient} directory={directory} active={active} visible={visible} />
          : part.type === 'text' && part.text.trim()
            ? <SelectableChatText key={part.id} text={part.text} color="#faf5ff" />
            : null)}
      </View>
      <View className="mt-1 flex-row items-center gap-1 self-stretch px-1">
        {meta && <Text numberOfLines={1} className="min-w-0 flex-1 text-right text-[9px] text-muted-foreground">{meta}</Text>}
        <Button accessibilityLabel="Copy prompt" className="ml-auto size-6 shrink-0 rounded-full px-0" variant="ghost" onPress={copyPrompt}>{copied ? <Check size={11} color={colors.done} /> : <Copy size={11} color={colors.textTertiary} />}</Button>
      </View>
    </View>
  );
}

function assistantCopyText(turn: TranscriptTurn): string {
  return turn.assistants.flatMap(message => message.parts).flatMap(part => {
    if (part.type === 'text') return [part.text];
    return [];
  }).join('\n\n');
}

function TurnMeta({ turn, expanded, onToggle, readAloud }: BlockExpansion & {
  turn: TranscriptTurn;
  readAloud?: ChatReadAloudControl;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { copied, copyText } = useCopyFeedback();
  const duration = formatDuration(turn.startedAt, turn.completedAt);
  const details = turn.details;
  const usage = details?.usage;
  const cache = cacheUsagePresentation(usage);
  const CacheIcon = cache.Icon;
  const outcome = details?.outcome ?? (turn.status === 'interrupted' ? 'interrupted' : undefined);
  const outcomeLabel = outcome ? TURN_OUTCOME_LABELS[outcome] : turn.status === 'error' ? 'Error' : undefined;
  const values = [
    duration,
    details?.model ?? details?.provider,
    usage?.total === undefined ? undefined : `${tokenNumber.format(usage.total)} tokens`,
    outcomeLabel,
  ].filter(Boolean);
  const copy = assistantCopyText(turn);
  const reading = readAloud?.readingTurnId === turn.id;
  const readDisabled = !reading && !readAloud?.canRead(turn);
  const hasDetails = Boolean(details?.model || details?.provider || usage || outcomeLabel || turn.startedAt !== undefined || turn.completedAt !== undefined);
  if (!values.length && !copy && !hasDetails) return null;
  return (
    <View className="mt-2 gap-2">
      <View className="min-h-7 flex-row items-center gap-2">
        {hasDetails && <Pressable accessibilityRole="button" accessibilityLabel="Turn details" accessibilityState={{ expanded }}
          accessibilityHint={cache.label}
          className="min-h-11 min-w-0 flex-1 flex-row items-center gap-1" onPress={onToggle}>
          <Text className="min-w-0 flex-1 text-[10px] text-muted-foreground">{values.join(' · ') || 'Details'}</Text>
          <View accessible accessibilityLabel={cache.label} className="shrink-0 flex-row items-center gap-1">
            <CacheIcon size={12} color={cache.status === 'hit' ? colors.done : colors.textTertiary} />
            {cache.percent && <Text numberOfLines={1} className="shrink-0 text-[10px] text-muted-foreground">{cache.percent}</Text>}
          </View>
          {expanded ? <ChevronDown size={12} color={colors.textTertiary} /> : <ChevronRight size={12} color={colors.textTertiary} />}
        </Pressable>}
        {copy.length > 0 && (
          <Button
            accessibilityLabel="Copy response"
            className="ml-auto size-7 rounded-full px-0"
            variant="ghost"
            onPress={() => copyText(copy)}
          >
            {copied ? <Check size={13} color={colors.done} /> : <Copy size={13} color={colors.textTertiary} />}
          </Button>
        )}
        {copy.trim().length > 0 && readAloud && (
          <Button
            testID={`chat-response-read-aloud-${turn.id}`}
            accessibilityLabel={t(reading ? 'terminal.readAloud.stop' : 'terminal.readAloud.start')}
            accessibilityState={{ selected: reading, disabled: readDisabled }}
            disabled={readDisabled}
            className="size-7 rounded-full px-0"
            variant="ghost"
            onPress={hapticPress(() => readAloud.toggle(turn))}
          >
            {reading ? <VolumeX size={13} color={colors.primary} /> : <Volume2 size={13} color={colors.textTertiary} />}
          </Button>
        )}
      </View>
      {expanded && hasDetails && <View className="gap-1.5 border-l border-border py-1 pl-3">
        <MetadataLine label="Model" value={details?.model} />
        <MetadataLine label="Provider" value={details?.provider} />
        <MetadataLine label="Cache" value={cache.label} />
        <MetadataLine label={outcome ? 'Outcome' : 'Status'} value={outcomeLabel} />
        <MetadataLine label="Started" value={turn.startedAt === undefined ? undefined : formatFullTime(turn.startedAt)} />
        <MetadataLine label="Finished" value={turn.completedAt === undefined ? undefined : formatFullTime(turn.completedAt)} />
        {turn.assistants.flatMap((message, index) => message.parts.length > 0 && message.completedAt !== undefined
          ? [<MetadataLine key={message.id} label={`Response ${index + 1}`} value={formatFullTime(message.completedAt)} />] : [])}
        {usage && <View className="mt-1 gap-1.5">
          {TOKEN_FIELDS.map(([key, label]) => <MetadataLine key={key} label={label} value={usage[key]?.toLocaleString()} />)}
          {(usage.cacheRead !== undefined || usage.cacheWrite !== undefined || usage.reasoning !== undefined) &&
            <Text className="text-[10px] text-muted-foreground">Input includes cache tokens. Output includes reasoning tokens.</Text>}
        </View>}
      </View>}
    </View>
  );
}

function ChangedFiles({ turn, expanded, onToggle }: BlockExpansion & { turn: TranscriptTurn }) {
  const { colors } = useTheme();
  if (!turn.diffs.length) return null;
  const additions = turn.diffs.reduce((total, diff) => total + diff.additions, 0);
  const deletions = turn.diffs.reduce((total, diff) => total + diff.deletions, 0);
  return (
    <View className="mt-2 border-t border-border pt-2">
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} className="min-h-11 flex-row items-center" onPress={onToggle}>
        <Text className="text-[11px] font-medium text-foreground">Changed {turn.diffs.length} file{turn.diffs.length === 1 ? '' : 's'}</Text>
        <Text className="ml-2 font-mono text-[10px]" style={{ color: colors.done }}>+{additions}</Text>
        <Text className="ml-1 font-mono text-[10px]" style={{ color: colors.error }}>−{deletions}</Text>
        {expanded
          ? <ChevronDown className="ml-auto" size={14} color={colors.textTertiary} />
          : <ChevronRight className="ml-auto" size={14} color={colors.textTertiary} />}
      </Pressable>
    </View>
  );
}

const TranscriptBlockView = memo(function TranscriptBlockRow({
  block, active, expanded, searchSelected, searchQuery, onToggle, onLinkPress, imageClient, directory, onAddToComposer, readAloud, visible,
}: {
  block: ChatBlock;
  active: boolean;
  expanded: boolean;
  searchSelected?: boolean;
  searchQuery: string;
  onToggle: (id: string) => void;
  onLinkPress: (url: string) => void;
  imageClient?: RemoteFileClient;
  directory?: string;
  onAddToComposer?: (text: string) => void;
  readAloud?: ChatReadAloudControl;
  visible: boolean;
}) {
  const { colors } = useTheme();
  const toggle = () => onToggle(block.id);
  const markdownImages = useMemo(() => ({ client: imageClient, directory, active, visible }), [imageClient, directory, active, visible]);
  const content = () => {
    switch (block.type) {
      case 'user': return <UserPrompt message={block.message} imageClient={imageClient} directory={directory} active={active} visible={visible} />;
      case 'part': return <View className="gap-1">
        {block.message?.createdAt !== undefined && <Text className="text-[9px] text-muted-foreground">Assistant · {new Date(block.message.createdAt).toLocaleTimeString()}</Text>}
        <AssistantPart part={block.part} directory={directory} streaming={active && block.streaming} expanded={expanded} onToggle={toggle} active={active} onLinkPress={onLinkPress}
          speechSource={active && visible && readAloud?.target ? { bindingToken: readAloud.target.bindingToken, hostId: readAloud.target.hostId, paneId: readAloud.target.paneId, messageId: block.messageId, partId: block.part.id } : undefined} />
      </View>;
      case 'error': return <TranscriptNoticeCard error className="flex-row"><CircleAlert size={15} color={colors.error} /><Text selectable className="min-w-0 flex-1 text-[12px] leading-[18px] text-muted-foreground"><SearchText text={block.error} /></Text></TranscriptNoticeCard>;
      case 'changes': return <ChangedFiles turn={block.turn} expanded={expanded} onToggle={toggle} />;
      case 'diff': return <ToolFileDiffBlock file={block.file} directory={directory} expanded={expanded} onToggle={toggle} />;
      case 'meta': return <TurnMeta turn={block.turn} expanded={expanded} onToggle={toggle} readAloud={readAloud} />;
    }
  };
  return (
    <View className={cn(
      'w-full',
      block.spacing === 'turn' && 'mt-7',
      block.spacing === 'part' && 'mt-3',
      searchSelected && 'rounded-md bg-primary/10',
    )} style={block.type === 'meta' ? { minHeight: 1 } : undefined}>
      <ChatComposerSelection.Provider value={onAddToComposer}>
        <TranscriptMarkdownImages.Provider value={markdownImages}>
          <ChatSearchQuery.Provider value={searchQuery}>{content()}</ChatSearchQuery.Provider>
        </TranscriptMarkdownImages.Provider>
      </ChatComposerSelection.Provider>
    </View>
  );
});

export function AgentChatView({
  imageClient,
  searchRuntime,
  searchKey,
  savedSearchNamespace,
  initialSearchTarget,
  state,
  active = true,
  prewarm = false,
  visible = active,
  agent,
  agentStatus,
  contentInsets,
  animatedBottomInset,
  latestButtonBottom,
  searchOpen: searchRequested = false,
  onCloseSearch,
  onOpenFile,
  onOpenWebLink = openExternalUrl,
  onInitialViewportReady,
  savedViewport,
  onSaveViewport,
  readAloud,
}: Props) {
  const { colors } = useTheme();
  const addToComposer = useContext(ChatComposerSelection);
  const floatingWarningOffset = useContext(FloatingWarningOffsetContext);
  const selectionOwner = useRef({ visible, sessionId: state.sessionId });
  selectionOwner.current = { visible, sessionId: state.sessionId };
  const addSelectionToComposer = useCallback((text: string) => {
    if (selectionOwner.current.visible && selectionOwner.current.sessionId === state.sessionId) {
      addToComposer?.(text);
    }
  }, [addToComposer, state.sessionId]);
  const searchSession = useRef(state.sessionId);
  const searchOpen = visible && searchRequested && searchSession.current === state.sessionId;
  const appGlassEnabled = useAppGlassEnabled();
  const [followEnd, setFollowEndState] = useState(
    savedViewport?.followEnd ?? true,
  );
  const [viewportReady, setViewportReady] = useState(false);
  const { scrolling, beginScroll, endScroll, resetScroll } = useScrollActivity();
  // These refs belong to this binding/generation, and survive warm reuse.
  const savedViewportRef = useRef<SavedChatViewport | null>(
    savedViewport ?? null,
  );
  const saveViewportCallback = useRef(onSaveViewport);
  saveViewportCallback.current = onSaveViewport;
  const activeRef = useRef(active);
  const visibleRef = useRef(visible);
  const continuouslyVisible = visible && visibleRef.current;
  const [scrollGeometry, setScrollGeometry] = useState<ChatScrollGeometry>({
    contentHeight: 0,
    offset: 0,
    viewportHeight: 0,
  });
  const turns = state.transcript.turns;
  const agentWorking = agentStatus === 'working';
  const requestedSource = useMemo(() => searchRuntime && searchKey
    ? { type: 'live' as const, runtime: searchRuntime, key: searchKey }
    : savedSearchNamespace
      ? { type: 'saved' as const, namespace: savedSearchNamespace, agent, sessionId: state.sessionId }
      : undefined, [searchRuntime, searchKey, savedSearchNamespace, agent, state.sessionId]);
  const sourceIdentity = JSON.stringify([state.sessionId, agent, searchKey, savedSearchNamespace]);
  const retainedSource = useRef<{ identity: string; source: NonNullable<typeof requestedSource> } | undefined>(undefined);
  if (requestedSource) retainedSource.current = { identity: sourceIdentity, source: requestedSource };
  else if (retainedSource.current?.identity !== sourceIdentity) retainedSource.current = undefined;
  // A host disconnect can temporarily remove its JS client. This viewport's
  // native owner still has the canonical manager and its last usable history.
  const searchSource = retainedSource.current?.source;
  const search = useChatSearch(searchSource, state.transcript, searchOpen, initialSearchTarget);
  const pendingSearch = useRef<string | null>(null);
  const lastSearchReveal = useRef('');
  const [expandedBlocks, setExpandedBlocks] = useState<ReadonlySet<string>>(
    () => savedViewport?.expandedBlocks ?? new Set(),
  );
  const expandedBlocksRef = useRef(expandedBlocks);
  expandedBlocksRef.current = expandedBlocks;
  const toggleBlock = useCallback((id: string) => {
    setExpandedBlocks(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const rowStore = useNativeChatRows(searchSource, state, agentWorking, expandedBlocks);
  const blocks = rowStore.rows;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const latestBlockId = blocks.at(-1)?.id ?? null;
  const list = useRef<FlashListRef<ChatRow>>(null);
  const followEndRef = useRef(savedViewport?.followEnd ?? true);
  const latestBlockIdRef = useRef(latestBlockId);
  latestBlockIdRef.current = latestBlockId;
  const scrollGeometryRef = useRef(scrollGeometry);
  const scrollInteractionRef = useRef<ChatScrollInteraction>({
    kind: ChatScrollInteractionKind.Idle,
    lastOffset: 0,
  });
  const scrollbarDragRef = useRef<ChatScrollbarDragSnapshot | null>(null);
  const initialViewportRef = useRef<InitialViewportReadiness>({
    atEnd: false,
    contentSizeKnown: false,
    itemsLoaded: false,
    measuredLatestBlockId: null,
    ready: false,
    viewableLatestBlockId: null,
    viewportLaidOut: false,
    positionConfirmed: false,
  });
  const initialViewportReadyCallbackRef = useRef(onInitialViewportReady);
  initialViewportReadyCallbackRef.current = onInitialViewportReady;
  const [preparation, setPreparation] = useState(() => ({
    identity: sourceIdentity, source: searchSource, store: rowStore,
    resetVersion: rowStore.resetVersion, generation: 0,
  }));
  const previousTranscriptRevisionRef = useRef(state.revision);
  const transcriptRestarted = state.revision !== undefined
    && previousTranscriptRevisionRef.current !== undefined
    && state.revision < previousTranscriptRevisionRef.current;
  const preparationChanged = preparation.identity !== sourceIdentity
    || preparation.source !== searchSource || preparation.store !== rowStore
    || preparation.resetVersion !== rowStore.resetVersion || transcriptRestarted;
  const projectionCurrent = state.revision === undefined || rowStore.transcriptRevision <= state.revision;
  const suspendedAtEndRef = useRef(false);
  const activationStartedRef = useRef(performance.now());
  const activationPathRef = useRef('cold-mount');
  const lastInitialViewportDiagnosticRef = useRef('');
  const agentName = chatAgentDisplayName(agent);
  const anchorIndex = savedViewport?.anchor && !savedViewport.followEnd
    ? rowStore.indexOf(savedViewport.anchor.blockId) : -1;
  const initialScrollIndex = anchorIndex < 0 ? undefined : anchorIndex;

  const saveViewport = useCallback(() => {
    if (initialViewportRef.current.ready && visibleRef.current) {
      const geometry = scrollGeometryRef.current;
      const index = list.current?.getFirstVisibleIndex?.();
      const block = index === undefined ? undefined : blocksRef.current[index];
      const layout =
        index === undefined ? undefined : list.current?.getLayout?.(index);
      savedViewportRef.current = {
        offset: geometry.offset,
        followEnd:
          followEndRef.current ||
          nearEnd(geometry.offset, Math.max(0, geometry.contentHeight - geometry.viewportHeight)),
        anchor:
          block && layout
            ? {
                blockId: block.id,
                offset:
                  geometry.offset -
                  layout.y -
                  (list.current?.getFirstItemOffset?.() ?? 0),
              }
            : undefined,
      };
    }
    if (savedViewportRef.current)
      saveViewportCallback.current?.({
        ...savedViewportRef.current,
        expandedBlocks: expandedBlocksRef.current,
      });
  }, []);

  useEffect(() => {
    if (searchSession.current === state.sessionId) return;
    searchSession.current = state.sessionId;
    if (visible && searchRequested) onCloseSearch?.();
  }, [state.sessionId, visible, searchRequested, onCloseSearch]);

  useLayoutEffect(() => {
    if (!searchOpen) return;
    followEndRef.current = false;
    setFollowEndState(false);
  }, [searchOpen]);

  useLayoutEffect(() => {
    const match = search.match;
    if (!match || !visible) {
      pendingSearch.current = null;
      lastSearchReveal.current = '';
      return;
    }
    const key = JSON.stringify([search.query, match.documentId, String(match.offset), search.navigationRevision]);
    if (lastSearchReveal.current === key) return;
    lastSearchReveal.current = key;
    pendingSearch.current = match.documentId;
    followEndRef.current = false;
    setFollowEndState(false);
    setExpandedBlocks(current => new Set([...current, ...match.reveal]));
  }, [search.match, search.query, search.navigationRevision, visible]);

  const searchBarHeight = searchOpen ? chatSearchBarHeight(search.query) : 0;
  const contextTop = contentInsets.top + searchBarHeight;
  const showTranscriptNotice = visible && (state.status !== 'live' || Boolean(rowStore.error));
  const transcriptNotice = rowStore.error || state.error || (state.status === 'loading'
    ? `Reading the local ${agentName} history…`
    : 'Live updates are temporarily unavailable.');
  const floatingNoticeTop = Math.max(contentInsets.top, floatingWarningOffset) + searchBarHeight;
  const pinnedPromptTop = floatingNoticeTop + (showTranscriptNotice ? FLOATING_WARNING_BANNER_HEIGHT + CHAT_CONTEXT_GAP : 0);
  const { prompt: pinnedPrompt, update: updatePinnedPrompt } = usePinnedPrompt(rowStore, state, list, contextTop);
  const latestTurn = turns.at(-1);
  const workActive = state.status === 'live'
    && (agentWorking || latestTurn?.status === 'working')
    && latestTurn?.status !== 'error' && latestTurn?.status !== 'interrupted';
  const candidates = useMemo(() => workActive
      ? currentActivity(blocks, state, latestTurn)
      : undefined, [workActive, latestTurn, blocks, state]);
  // Floating controls follow native frames independently of the list's React
  // spacing, including the final frame before keyboardDidHide reaches JS.
  const floatingChromeStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -(animatedBottomInset?.value ?? contentInsets.bottom) }],
  }));

  useLayoutEffect(() => {
    updatePinnedPrompt(scrollGeometryRef.current.offset);
  }, [updatePinnedPrompt]);

  const revealSearchMatch = () => {
    if (pendingSearch.current && visible && initialViewportRef.current.ready) {
      const index = rowStore.indexOf(pendingSearch.current);
      if (index < 0) return;
      pendingSearch.current = null;
      const scroll = list.current?.scrollToIndex({
        index, animated: false, viewOffset: contentInsets.top + searchBarHeight,
      });
      if (scroll) reportBackgroundFailure(scroll, 'chat-search-reveal');
    }
  };

  useLayoutEffect(() => () => saveViewport(), [saveViewport]);
  const contentPadding = insetContentPadding(contentInsets, {
    top: CHAT_CONTENT_TOP_GAP + searchBarHeight,
    bottom: CHAT_CONTENT_BOTTOM_GAP,
  });
  const previousPaddingRef = useRef(contentPadding);
  const viewportWidthRef = useRef<number | undefined>(undefined);
  const maxOffset = Math.max(0, scrollGeometry.contentHeight - scrollGeometry.viewportHeight);
  const awayFromLatest = !followEnd && !nearEnd(scrollGeometry.offset, maxOffset);
  const activity = useChatActivity(active && workActive && awayFromLatest,
    JSON.stringify([state.sessionId, latestTurn?.id, candidates?.promptId]), candidates?.summary, candidates?.tool);
  const scrollThumb = scrollThumbGeometry(
    scrollGeometry.offset,
    maxOffset,
    scrollGeometry.viewportHeight,
  );

  const updateScrollGeometry = (next: ChatScrollGeometry) => {
    const previous = scrollGeometryRef.current;
    scrollGeometryRef.current = next;
    updatePinnedPrompt(next.offset);
    const update = () => setScrollGeometry(current => (
      current.contentHeight === next.contentHeight
      && current.offset === next.offset
      && current.viewportHeight === next.viewportHeight
        ? current
        : next
    ));
    // Keep native position/checkpoints current immediately. Floating chrome can
    // follow at transition priority so list cells render first during a fling.
    if (previous.contentHeight === next.contentHeight && previous.viewportHeight === next.viewportHeight) {
      startTransition(update);
    } else update();
  };

  const setFollowEnd = (enabled: boolean) => {
    if (followEndRef.current === enabled) return;
    followEndRef.current = enabled;
    setFollowEndState(enabled);
  };

  const updateFollowFromUserScroll = (
    previousOffset: number,
    nextOffset: number,
    maximumOffset: number,
  ) => {
    if (nextOffset < previousOffset - CHAT_SCROLL_OFFSET_EPSILON) {
      setFollowEnd(false);
      return;
    }
    if (
      nextOffset > previousOffset + CHAT_SCROLL_OFFSET_EPSILON
      && nearEnd(nextOffset, maximumOffset)
    ) setFollowEnd(true);
  };

  const scrollToLatest = (animated: boolean) => {
    const current = scrollGeometryRef.current;
    scrollInteractionRef.current = {
      kind: ChatScrollInteractionKind.Idle,
      lastOffset: current.offset,
    };
    list.current?.scrollToEnd({ animated });
  };

  const restoredOffset = (
    saved: SavedChatViewport | null,
    maximumOffset: number,
  ) => {
    const index = saved?.anchor
      ? rowStore.indexOf(saved.anchor.blockId)
      : -1;
    const layout = index < 0 ? undefined : list.current?.getLayout?.(index);
    const offset =
      saved?.anchor && layout
        ? layout.y +
          (list.current?.getFirstItemOffset?.() ?? 0) +
          saved.anchor.offset
        : (saved?.offset ?? 0);
    return Math.max(0, Math.min(offset, maximumOffset));
  };

  const initialViewportConditionsSatisfied = () => {
    const readiness = initialViewportRef.current;
    const currentLatestBlockId = latestBlockIdRef.current;
    const saved = savedViewportRef.current;
    const geometry = scrollGeometryRef.current;
    const restoringOffset = saved && !saved.followEnd;
    const targetOffset = restoredOffset(
      saved,
      Math.max(0, geometry.contentHeight - geometry.viewportHeight),
    );
    return rowStore.ready && readiness.viewportLaidOut
      && readiness.itemsLoaded
      && readiness.contentSizeKnown
      && readiness.positionConfirmed
      && (restoringOffset
        ? Math.abs(geometry.offset - targetOffset) <= CHAT_INITIAL_END_THRESHOLD
        : readiness.measuredLatestBlockId === currentLatestBlockId && readiness.atEnd && (
          currentLatestBlockId === null
          || readiness.viewableLatestBlockId === currentLatestBlockId
        )
      );
  };

  const recordInitialViewportReadiness = (source: string) => {
    const readiness = initialViewportRef.current;
    const currentLatestBlockId = latestBlockIdRef.current;
    const geometry = scrollGeometryRef.current;
    const details = {
      atEnd: readiness.atEnd,
      conditionsSatisfied: initialViewportConditionsSatisfied(),
      contentHeight: Math.round(geometry.contentHeight),
      contentSizeKnown: readiness.contentSizeKnown,
      itemsLoaded: readiness.itemsLoaded,
      latestBlockId: currentLatestBlockId,
      measuredLatestBlockMatches:
        readiness.measuredLatestBlockId === currentLatestBlockId,
      ready: readiness.ready,
      source,
      viewableLatestBlockMatches:
        currentLatestBlockId === null ||
        readiness.viewableLatestBlockId === currentLatestBlockId,
      viewportHeight: Math.round(geometry.viewportHeight),
      viewportLaidOut: readiness.viewportLaidOut,
    };
    const fingerprint = JSON.stringify(details);
    if (lastInitialViewportDiagnosticRef.current === fingerprint) return;
    lastInitialViewportDiagnosticRef.current = fingerprint;
    recordAgentChatDiagnostic('viewport-readiness-changed', details);
  };

  const scheduleInitialViewportReady = (source: string) => {
    const readiness = initialViewportRef.current;
    if ((!visible && !prewarm) || readiness.ready) return;
    recordInitialViewportReadiness(source);
    if (!initialViewportConditionsSatisfied()) return;
    readiness.ready = true;
    if (!active && prewarm) {
      const geometry = scrollGeometryRef.current;
      suspendedAtEndRef.current = readiness.atEnd;
      savedViewportRef.current = {
        ...savedViewportRef.current,
        offset: geometry.offset, followEnd: followEndRef.current,
      };
    }
    // Initial/returning viewports have already aligned to the remapped saved anchor.
    setViewportReady(true);
    recordInitialViewportReadiness('ready');
    recordAgentChatDiagnostic('viewport-ready', {
      latestBlockId: latestBlockIdRef.current,
      source,
      turnCount: turns.length,
    });
    initialViewportReadyCallbackRef.current?.();
  };

  const updateInitialEndPosition = (
    offset: number,
    contentHeight: number,
    viewportHeight: number,
  ) => {
    const maximumOffset = Math.max(0, contentHeight - viewportHeight);
    initialViewportRef.current.atEnd =
      initialViewportRef.current.positionConfirmed &&
      viewportHeight > 0 &&
      Math.abs(maximumOffset - offset) <= CHAT_INITIAL_END_THRESHOLD;
    scheduleInitialViewportReady('scroll-extent');
  };

  const confirmListPosition = () => {
    const geometry = scrollGeometryRef.current;
    const offset = list.current?.getAbsoluteLastScrollOffset();
    if (offset === undefined) return;
    updateScrollGeometry({ ...geometry, offset });
    initialViewportRef.current.positionConfirmed = true;
    updateInitialEndPosition(offset, geometry.contentHeight, geometry.viewportHeight);
  };

  const updateScrollExtent = ({
    contentHeight,
    viewportHeight,
  }: Pick<ChatScrollGeometry, 'contentHeight' | 'viewportHeight'>) => {
    const current = scrollGeometryRef.current;
    updateScrollGeometry({
      contentHeight,
      offset: current.offset,
      viewportHeight,
    });
    const interaction = scrollInteractionRef.current;
    if (interaction.kind !== ChatScrollInteractionKind.Idle) {
      scrollInteractionRef.current = {
        ...interaction,
        lastOffset: current.offset,
      };
    }
    updateInitialEndPosition(current.offset, contentHeight, viewportHeight);
    if (visible && initialViewportRef.current.ready && followEndRef.current
      && current.viewportHeight > 0 && viewportHeight !== current.viewportHeight) {
      list.current?.scrollToEnd({ animated: false });
    }
  };

  const alignLoadedInitialViewport = () => {
    const readiness = initialViewportRef.current;
    const geometry = scrollGeometryRef.current;
    const maximumOffset = Math.max(
      0,
      geometry.contentHeight - geometry.viewportHeight,
    );
    if (
      (!visible && !prewarm) || readiness.ready ||
      !readiness.itemsLoaded ||
      !readiness.contentSizeKnown ||
      geometry.viewportHeight <= 0
    )
      return;
    const saved = savedViewportRef.current;
    const targetOffset =
      saved && !saved.followEnd
        ? restoredOffset(saved, maximumOffset)
        : maximumOffset;
    if (readiness.positionConfirmed && Math.abs(geometry.offset - targetOffset) <= CHAT_INITIAL_END_THRESHOLD) {
      scheduleInitialViewportReady('retained-position');
      return;
    }
    scrollInteractionRef.current = {
      kind: ChatScrollInteractionKind.Idle,
      lastOffset: geometry.offset,
    };
    // A scroll request is not a position report. Keep Chat hidden until confirmed.
    list.current?.scrollToOffset({ offset: targetOffset, animated: false });
  };

  const invalidateViewport = (reason: string, remeasure = false) => {
    const readiness = initialViewportRef.current;
    recordAgentChatDiagnostic('viewport-invalidated', {
      reason, wasReady: readiness.ready, generation: preparation.generation, sessionId: state.sessionId,
    });
    readiness.ready = false;
    readiness.positionConfirmed = false;
    readiness.atEnd = false;
    if (remeasure) {
      readiness.contentSizeKnown = false;
      readiness.measuredLatestBlockId = null;
      readiness.viewableLatestBlockId = null;
    }
    setViewportReady(false);
  };

  const remeasureViewport = (reason: string) => {
    invalidateViewport(reason, true);
    initialViewportRef.current.itemsLoaded = false;
    // A remounted list guarantees fresh measurement/load/viewability callbacks,
    // even when reflow or inset changes leave its total content height unchanged.
    setPreparation(current => ({ ...current, generation: current.generation + 1 }));
  };

  const updateViewportPreparation = useEffectEvent(() => {
    previousTranscriptRevisionRef.current = state.revision;
    if (!preparationChanged) return;
    const identityChanged = preparation.identity !== sourceIdentity;
    const reason = identityChanged ? 'identity-changed'
      : transcriptRestarted ? 'transcript-restarted' : 'row-source-reset';
    invalidateViewport(reason, true);
    initialViewportRef.current.itemsLoaded = false;
    if (identityChanged || (savedViewportRef.current?.anchor
      && rowStore.ready && rowStore.indexOf(savedViewportRef.current.anchor.blockId) < 0)) {
      savedViewportRef.current = null;
      setFollowEnd(true);
    }
    activationPathRef.current = reason;
    setPreparation({
      identity: sourceIdentity, source: searchSource, store: rowStore,
      resetVersion: rowStore.resetVersion, generation: preparation.generation + 1,
    });
  });
  useLayoutEffect(() => {
    updateViewportPreparation();
  }, [sourceIdentity, searchSource, rowStore, rowStore.resetVersion, state.revision]);

  const updateViewportPadding = useEffectEvent(() => {
    const previous = previousPaddingRef.current;
    previousPaddingRef.current = contentPadding;
    if (previous.top === contentPadding.top && previous.bottom === contentPadding.bottom) return;
    // Retained chats share changing composer/chrome clearance. FlashList lays
    // out their spacers without discarding already measured conversation rows.
    // Only a cold viewport still needs a fresh load/position confirmation.
    if (!initialViewportRef.current.ready && !continuouslyVisible && (!active || activeRef.current !== active)) {
      remeasureViewport('content-insets-changed');
    }
  });
  useLayoutEffect(() => {
    updateViewportPadding();
  }, [contentPadding.top, contentPadding.bottom]);

  const retainedPositionSafe = () => {
    const saved = savedViewportRef.current;
    const geometry = scrollGeometryRef.current;
    if (!saved || !initialViewportRef.current.positionConfirmed) return false;
    const maximumOffset = Math.max(0, geometry.contentHeight - geometry.viewportHeight);
    if (saved.followEnd) return suspendedAtEndRef.current
      && (Math.abs(geometry.offset - saved.offset) <= CHAT_INITIAL_END_THRESHOLD
        || Math.abs(geometry.offset - maximumOffset) <= CHAT_INITIAL_END_THRESHOLD);
    return (!saved.anchor || rowStore.indexOf(saved.anchor.blockId) >= 0)
      && Math.abs(geometry.offset - restoredOffset(saved, maximumOffset)) <= CHAT_INITIAL_END_THRESHOLD;
  };

  const updateViewportActivity = useEffectEvent(() => {
    if (activeRef.current === active) return;
    const readiness = initialViewportRef.current;
    if (!active && readiness.ready) {
      saveViewport();
      suspendedAtEndRef.current = readiness.atEnd;
    }
    activeRef.current = active;
    resetScroll();
    scrollInteractionRef.current = {
      kind: ChatScrollInteractionKind.Idle,
      lastOffset: scrollGeometryRef.current.offset,
    };
    scrollbarDragRef.current = null;
    recordAgentChatDiagnostic('viewport-activity-changed', {
      active, ready: readiness.ready, generation: preparation.generation,
      rowRevision: rowStore.revision, rowResetVersion: rowStore.resetVersion, sessionId: state.sessionId,
    });
    if (active) {
      activationStartedRef.current = performance.now();
      setFollowEnd(savedViewportRef.current?.followEnd ?? true);
      if (readiness.ready && !preparationChanged && (continuouslyVisible || retainedPositionSafe())) {
        activationPathRef.current = 'retained-reactivation';
        recordAgentChatDiagnostic('viewport-retained-reactivated', {
          ready: true, generation: preparation.generation,
          followEnd: followEndRef.current, rowRevision: rowStore.revision, sessionId: state.sessionId,
        });
        // Keep existing rows visible while catching up; normal content-size
        // callbacks continue following later asynchronous row projections.
        if (followEndRef.current && !readiness.atEnd) list.current?.scrollToEnd({ animated: false });
        initialViewportReadyCallbackRef.current?.();
        return;
      }
      activationPathRef.current = 'retained-preparation';
      if (readiness.ready) invalidateViewport('unsafe-retained-position');
      alignLoadedInitialViewport();
      scheduleInitialViewportReady('reactivated');
    }
  });

  useLayoutEffect(() => {
    updateViewportActivity();
  }, [active]);

  const prepareHiddenViewport = useEffectEvent(() => {
    if (!prewarm || visible) return;
    alignLoadedInitialViewport();
    scheduleInitialViewportReady('priority-prewarm');
  });
  useLayoutEffect(() => {
    prepareHiddenViewport();
  }, [prewarm, visible]);

  useLayoutEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    recordAgentChatDiagnostic('viewport-props-changed', {
      agent,
      latestBlockId,
      sessionId: state.sessionId,
      state: state.status,
      stateRevision: state.revision,
      turnCount: turns.length,
    });
  }, [
    agent,
    latestBlockId,
    state.revision,
    state.sessionId,
    state.status,
    turns.length,
  ]);

  useEffect(() => {
    recordAgentChatDiagnostic('viewport-mounted', {
      agent,
      sessionId: state.sessionId,
    });
    return () => {
      recordAgentChatDiagnostic('viewport-unmounted', {
        agent,
        sessionId: state.sessionId,
      });
    };
  }, [agent, state.sessionId]);

  const trackScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const nextMaxOffset = Math.max(
      0,
      contentSize.height - layoutMeasurement.height,
    );
    const offset = Math.max(0, Math.min(nextMaxOffset, contentOffset.y));
    updateScrollGeometry({
      contentHeight: contentSize.height,
      offset,
      viewportHeight: layoutMeasurement.height,
    });
    initialViewportRef.current.positionConfirmed = true;
    updateInitialEndPosition(
      offset,
      contentSize.height,
      layoutMeasurement.height,
    );
    if (!visible) return;
    const interaction = scrollInteractionRef.current;
    if (
      interaction.kind !== ChatScrollInteractionKind.Dragging &&
      interaction.kind !== ChatScrollInteractionKind.UserMomentum
    )
      return;
    updateFollowFromUserScroll(interaction.lastOffset, offset, nextMaxOffset);
    scrollInteractionRef.current = { ...interaction, lastOffset: offset };
  };
  const beginUserScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    beginScroll();
    pendingSearch.current = null;
    recordAgentChatDiagnostic('viewport-drag-start', {
      active,
      offset: event.nativeEvent.contentOffset.y,
      stateRevision: state.revision,
    });
    trackScroll(event);
    const maximumOffset = Math.max(
      0,
      event.nativeEvent.contentSize.height - event.nativeEvent.layoutMeasurement.height,
    );
    const offset = Math.max(0, Math.min(maximumOffset, event.nativeEvent.contentOffset.y));
    scrollInteractionRef.current = { kind: ChatScrollInteractionKind.Dragging, lastOffset: offset };
  };
  const endUserScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    trackScroll(event);
    scrollInteractionRef.current = {
      kind: ChatScrollInteractionKind.AwaitingMomentum,
      lastOffset: scrollGeometryRef.current.offset,
    };
    endScroll();
  };
  const beginMomentumScroll = () => {
    const interaction = scrollInteractionRef.current;
    if (interaction.kind !== ChatScrollInteractionKind.AwaitingMomentum) return;
    beginScroll();
    scrollInteractionRef.current = { ...interaction, kind: ChatScrollInteractionKind.UserMomentum };
  };
  const endMomentumScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    trackScroll(event);
    scrollInteractionRef.current = {
      kind: ChatScrollInteractionKind.Idle,
      lastOffset: scrollGeometryRef.current.offset,
    };
    endScroll();
  };
  const beginScrollbarDrag = ({
    trackHeight,
    thumbHeight,
  }: Omit<OverlayScrollbarDragEvent, 'dy'>) => {
    const current = scrollGeometryRef.current;
    const currentMaxOffset = Math.max(0, current.contentHeight - current.viewportHeight);
    if (currentMaxOffset <= 0 || trackHeight <= thumbHeight) {
      scrollbarDragRef.current = null;
      return;
    }
    beginScroll();
    scrollInteractionRef.current = {
      kind: ChatScrollInteractionKind.Idle,
      lastOffset: current.offset,
    };
    setFollowEnd(false);
    scrollbarDragRef.current = {
      lastOffset: current.offset,
      maxOffset: currentMaxOffset,
      startOffset: current.offset,
    };
  };
  const dragScrollbar = ({
    dy,
    trackHeight,
    thumbHeight,
  }: OverlayScrollbarDragEvent) => {
    const drag = scrollbarDragRef.current;
    if (!drag) return;
    const desiredOffset = scrollOffsetFromDrag({
      startOffset: drag.startOffset,
      dragDistance: dy,
      maxOffset: drag.maxOffset,
      trackHeight,
      thumbHeight,
    });
    if (desiredOffset === drag.lastOffset) return;
    const previousOffset = drag.lastOffset;
    drag.lastOffset = desiredOffset;
    const current = scrollGeometryRef.current;
    updateScrollGeometry({ ...current, offset: desiredOffset });
    const currentMaxOffset = Math.max(0, current.contentHeight - current.viewportHeight);
    updateFollowFromUserScroll(previousOffset, desiredOffset, currentMaxOffset);
    list.current?.scrollToOffset({ offset: desiredOffset, animated: false });
  };
  const adjustScrollbar = (direction: 'up' | 'down') => {
    const current = scrollGeometryRef.current;
    const currentMaxOffset = Math.max(
      0,
      current.contentHeight - current.viewportHeight,
    );
    const desiredOffset = Math.max(
      0,
      Math.min(
        currentMaxOffset,
        current.offset +
          (direction === 'down'
            ? current.viewportHeight
            : -current.viewportHeight),
      ),
    );
    if (desiredOffset === current.offset) return;
    updateScrollGeometry({ ...current, offset: desiredOffset });
    updateFollowFromUserScroll(current.offset, desiredOffset, currentMaxOffset);
    scrollInteractionRef.current = {
      kind: ChatScrollInteractionKind.Idle,
      lastOffset: desiredOffset,
    };
    list.current?.scrollToOffset({ offset: desiredOffset, animated: false });
  };
  const trackViewableBlocks = ({
    viewableItems,
  }: {
    viewableItems: ViewToken<ChatRow>[];
  }) => {
    updatePinnedPrompt(scrollGeometryRef.current.offset);
    const currentLatestBlockId = latestBlockIdRef.current;
    initialViewportRef.current.viewableLatestBlockId =
      currentLatestBlockId !== null &&
      viewableItems.some(
        token => token.isViewable && token.item.id === currentLatestBlockId,
      )
        ? currentLatestBlockId
        : null;
    scheduleInitialViewportReady('viewable-items');
  };
  const openTranscriptLink = useCallback(
    (url: string) => {
      const file = transcriptFileLinkTarget(
        url,
        state.transcript.info?.directory,
      );
      if (file) {
        onOpenFile(file);
        return;
      }
      if (/^https?:/i.test(url)) onOpenWebLink(url);
      else if (/^(?:mailto:|tel:)/i.test(url)) openExternalUrl(url);
    },
    [onOpenFile, onOpenWebLink, state.transcript.info?.directory],
  );

  const viewportVisible = visible && !preparationChanged && projectionCurrent
    && (Boolean(rowStore.error) || (viewportReady && (continuouslyVisible || !active || activeRef.current || retainedPositionSafe())));

  useEffect(() => {
    if (!viewportVisible) return;
    recordAgentChatDiagnostic('viewport-visible', {
      path: activationPathRef.current, generation: preparation.generation,
      elapsedMs: performance.now() - activationStartedRef.current, sessionId: state.sessionId,
    });
    const frame = requestAnimationFrame(() => recordAgentChatDiagnostic('viewport-visible-frame', {
      path: activationPathRef.current, generation: preparation.generation,
      elapsedMs: performance.now() - activationStartedRef.current, sessionId: state.sessionId,
    }));
    return () => cancelAnimationFrame(frame);
  }, [viewportVisible, preparation.generation, state.sessionId]);

  return (
    <View
      // Readiness/activity opacity changes must not flatten and reparent this layer.
      collapsable={false}
      testID="agent-chat-root"
      pointerEvents={viewportVisible ? 'auto' : 'none'}
      className={cn('flex-1', appGlassBackgroundClassName(appGlassEnabled))}
      style={{ opacity: viewportVisible ? 1 : 0 }}
    >
      <View
        testID="agent-chat-viewport"
        className="relative flex-1"
        onTouchStart={event => {
          recordAgentChatDiagnostic('viewport-touch-start', {
            active,
            target: event.nativeEvent.target,
            stateRevision: state.revision,
          });
        }}
        onLayout={event => {
          const { width, height } = event.nativeEvent.layout;
          const previousWidth = viewportWidthRef.current;
          viewportWidthRef.current = width;
          const widthChanged = previousWidth !== undefined && width !== previousWidth;
          const heightChanged = scrollGeometryRef.current.viewportHeight > 0
            && height !== scrollGeometryRef.current.viewportHeight;
          if (widthChanged) {
            if (activeRef.current) saveViewport();
            remeasureViewport('viewport-width-changed');
          } else if (heightChanged && !(continuouslyVisible && initialViewportRef.current.ready)) {
            if (activeRef.current) saveViewport();
            invalidateViewport('viewport-height-changed');
          }
          initialViewportRef.current.viewportLaidOut = true;
          const current = scrollGeometryRef.current;
          updateScrollExtent({
            contentHeight: current.contentHeight,
            viewportHeight: height,
          });
          alignLoadedInitialViewport();
          if (heightChanged && !widthChanged) confirmListPosition();
        }}
      >
        {projectionCurrent && (rowStore.ready || rowStore.error) && <FlashList
          key={preparation.generation}
          ref={list}
          onCommitLayoutEffect={() => {
            updatePinnedPrompt(scrollGeometryRef.current.offset);
            revealSearchMatch();
          }}
          initialScrollIndex={initialScrollIndex}
          drawDistance={scrollGeometry.viewportHeight || undefined}
          data={blocks}
          keyExtractor={block => block.id}
          extraData={state}
          getItemType={block => block.type === 'part' ? block.partKind : block.type}
          renderItem={({ item }) => {
            const block = resolveChatRow(item, state);
            return block ? (
            <TranscriptBlockView
              key={item.id}
              block={block}
              active={active}
              visible={viewportVisible}
              expanded={expandedBlocks.has(item.id)}
              searchSelected={search.match?.documentId === item.id}
              searchQuery={searchOpen && search.ready ? search.query.trim() : ''}
              onToggle={toggleBlock}
              onLinkPress={openTranscriptLink}
              imageClient={imageClient}
              directory={state.transcript.info?.directory}
              onAddToComposer={visible && addToComposer ? addSelectionToComposer : undefined}
              readAloud={visible ? readAloud : undefined}
            />
          ) : null;
          }}
          contentContainerStyle={chatListStyles.content}
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={
            CHAT_MAINTAIN_VISIBLE_CONTENT_POSITION
          }
          scrollIndicatorInsets={contentInsets}
          showsVerticalScrollIndicator={false}
          viewabilityConfig={CHAT_VIEWABILITY_CONFIG}
          ListHeaderComponent={
            <ChatBoundarySpacer height={contentPadding.top} />
          }
          ListFooterComponent={
            <>
              {workActive && <ChatWorkingStatus
                key={`${state.sessionId}:${latestTurn?.id ?? 'starting'}`}
                startedAt={latestTurn?.startedAt}
                active={active && !awayFromLatest}
              />}
              <ChatBoundarySpacer height={contentPadding.bottom} />
            </>
          }
          ListEmptyComponent={
            rowStore.ready && state.status === 'live' && !agentWorking ? (
              <View className="flex-1 items-center justify-center px-8 py-20">
                <Text className="text-center text-[14px] font-semibold text-foreground">
                  No conversation yet
                </Text>
                <Text className="mt-1 max-w-[280px] text-center text-[12px] leading-[18px] text-muted-foreground">
                  Open the composer from the controls below to send a message.
                </Text>
              </View>
            ) : null
          }
          onContentSizeChange={(_width, height) => {
            const contentSizeWasKnown =
              initialViewportRef.current.contentSizeKnown;
            initialViewportRef.current.contentSizeKnown = true;
            initialViewportRef.current.measuredLatestBlockId =
              latestBlockIdRef.current;
            const current = scrollGeometryRef.current;
            updateScrollExtent({
              contentHeight: height,
              viewportHeight: current.viewportHeight,
            });
            alignLoadedInitialViewport();
            if (
              contentSizeWasKnown &&
              visible && initialViewportRef.current.ready &&
              Math.abs(height - current.contentHeight) > CHAT_SCROLL_OFFSET_EPSILON &&
              followEndRef.current
            )
              list.current?.scrollToEnd({ animated: false });
          }}
          onLayout={event => {
            const current = scrollGeometryRef.current;
            updateScrollExtent({
              contentHeight: current.contentHeight,
              viewportHeight: event.nativeEvent.layout.height,
            });
            alignLoadedInitialViewport();
          }}
          onEndReached={confirmListPosition}
          onEndReachedThreshold={0}
          onLoad={() => {
            initialViewportRef.current.itemsLoaded = true;
            if (!initialViewportRef.current.positionConfirmed) confirmListPosition();
            recordInitialViewportReadiness('items-loaded');
            alignLoadedInitialViewport();
          }}
          onScroll={trackScroll}
          onScrollBeginDrag={beginUserScroll}
          onScrollEndDrag={endUserScroll}
          onMomentumScrollBegin={beginMomentumScroll}
          onMomentumScrollEnd={endMomentumScroll}
          onViewableItemsChanged={trackViewableBlocks}
          scrollEventThrottle={16}
        />}
        {showTranscriptNotice && (
          <FloatingWarningBanner
            testID="chat-transcript-notice"
            top={floatingNoticeTop}
            message={transcriptNotice}
            icon={state.status === 'loading'
              ? <ActivityIndicator animating={active} size="small" color={colors.warning} />
              : <CircleAlert size={15} color={colors.warning} />}
          />
        )}
        {visible && !searchOpen && pinnedPrompt && (
          <Pressable
            testID="chat-pinned-prompt"
            accessibilityRole="button"
            accessibilityLabel={`Jump to prompt: ${pinnedPrompt.preview}`}
            accessibilityHint="Scrolls to the original message"
            className="absolute left-4 right-4 z-20 flex-row items-center gap-2 rounded-xl bg-purple-950 px-3"
            style={{ top: pinnedPromptTop, height: CHAT_CONTEXT_HEIGHT }}
            onPress={hapticPress(() => {
              pendingSearch.current = null;
              setFollowEnd(false);
              scrollInteractionRef.current = {
                kind: ChatScrollInteractionKind.Idle,
                lastOffset: scrollGeometryRef.current.offset,
              };
              const scroll = list.current?.scrollToIndex({
                index: pinnedPrompt.index, animated: false, viewOffset: contextTop,
              });
              if (scroll) reportBackgroundFailure(scroll, 'chat-prompt-reveal');
            })}
          >
            <Text numberOfLines={1} className="min-w-0 flex-1 text-[13px] leading-5 text-purple-50">{pinnedPrompt.preview}</Text>
            <ChevronUp size={16} color="#faf5ff" />
          </Pressable>
        )}
        {searchOpen && <ChatSearchBar search={search} top={contentInsets.top} onClose={() => {
          pendingSearch.current = null;
          onCloseSearch?.();
          Keyboard.dismiss();
        }} />}
        <Animated.View
          testID="chat-floating-chrome"
          pointerEvents="box-none"
          className="absolute inset-0"
          style={floatingChromeStyle}
        >
          {activity && (
            <ChatActivityStrip
              activity={activity}
              onPress={() => {
                pendingSearch.current = null;
                setFollowEnd(true);
                scrollToLatest(true);
              }}
            />
          )}
          {awayFromLatest && !scrolling && !activity && (
            <Button
              accessibilityLabel="Jump to latest"
              className={LATEST_BUTTON_CLASS_NAME}
              style={[
                { bottom: latestButtonBottom - contentInsets.bottom },
                latestButtonStyle(colors),
              ]}
              variant="secondary"
              size="icon"
              onPress={() => {
                setFollowEnd(true);
                scrollToLatest(true);
              }}
            >
              <ArrowDown size={LATEST_BUTTON_ICON_SIZE} color={colors.text} />
            </Button>
          )}
        </Animated.View>
        {scrollThumb && (
          <OverlayScrollbar
            accessibilityLabel="Conversation scroll position"
            glass={appGlassEnabled}
            heightPercent={scrollThumb.heightPercent}
            insets={contentInsets}
            topPercent={scrollThumb.topPercent}
            onAccessibilityAdjust={adjustScrollbar}
            onDrag={dragScrollbar}
            onDragEnd={() => {
              scrollbarDragRef.current = null;
              endScroll();
            }}
            onDragStart={beginScrollbarDrag}
          />
        )}
      </View>
    </View>
  );
}

function openExternalUrl(url: string): void {
  Linking.openURL(url).catch(error => {
    recordOperationalDiagnostic('warn', 'Application', 'external-link-open-failed', {
      operation: 'Linking.openURL',
      ...operationalErrorDetails(error),
    });
  });
}
