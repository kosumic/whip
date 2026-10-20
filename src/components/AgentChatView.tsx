import { ChatSearchQuery, SearchText } from './SearchText';
import { memo, useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  FlashList,
  type FlashListRef,
  type ViewToken,
} from '@shopify/flash-list';
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Copy,
  ExternalLink,
  File,
  FileDiff,
  FilePlus,
  Link,
  Search,
  SquareTerminal,
  Volume2,
  VolumeX,
  type LucideIcon,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
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
import { useChatSearch } from '../hooks/useChatSearch';
import { useChatActivity, type ChatActivity, type ChatToolActivity } from '../hooks/useChatActivity';
import { useScrollActivity } from '../hooks/useScrollActivity';
import { ChatSearchBar, chatSearchBarHeight } from './ChatSearchBar';

import type {
  AgentChatState,
  TranscriptMessage,
  TranscriptPart,
  TranscriptQuestion,
  TranscriptToolPart,
  TranscriptTurn,
} from '../agentChat';
import { isQuestionTool, isRunningTool as isRunning } from '../lib/agentChatBlocks';
import { resolveChatRow, type ChatBlock, type ChatRow, type ChatRowStore } from '../lib/nativeChatRows';
import { useNativeChatRows } from '../hooks/useNativeChatRows';
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
import { SelectableChatText } from './SelectableChatText';
import { ChatComposerSelection } from './ChatComposerSelection';
import { NativeCodeBlock } from './NativeCodeBlock';
import { JsonOutputViewer } from './JsonOutputViewer';
import { parseJsonToolOutput } from '../lib/toolOutput';
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
  conversationSearchNamespace?: string;
  initialSearchTarget?: ChatSearchInitialTarget;
  state: AgentChatState;
  /** Selected and requested, including preparation before the viewport is revealed. */
  active?: boolean;
  agent: ChatAgent;
  agentStatus: AgentStatus;
  contentInsets: VisualContentInsets;
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
const SMALL_ICON_HIT_SLOP = 8;
const TOOL_HEADER_PREVIEW_LENGTH = 160;
const CHAT_CONTEXT_PREVIEW_LENGTH = 256;
const CHAT_CONTEXT_HEIGHT = 44;
const CHAT_CONTEXT_GAP = 8;
const CHAT_ACTIVITY_TINT_OPACITY = 0.6;
const CHAT_WORKING_TICK_MS = 1_000;
const CHAT_WORKING_LETTERS = Array.from(CHAT_WORKING_LABEL);
const CHAT_WORKING_TEXT_CLASS = 'text-[12px] font-medium leading-4 text-foreground';
const NIX_EXECUTABLE_PREFIX = /\/nix\/store\/[^/\s"'`]+\/s?bin\//g;
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
  const reduceMotion = useReducedMotion();
  const [fallbackStartedAt] = useState(Date.now);
  const [now, setNow] = useState(fallbackStartedAt);
  const progress = useDecorativeProgress(active && !reduceMotion, CHAT_WORKING_SHIMMER_PERIOD_MS, false);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CHAT_WORKING_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  const start = startedAt ?? fallbackStartedAt;
  const duration = formatDuration(start, Math.max(start, now));
  const label = `${CHAT_WORKING_LABEL} (${duration})`;
  return (
    <View testID="chat-inline-working" className="min-h-11 flex-row items-center gap-2">
      <ActivityIndicator animating={active && !reduceMotion} hidesWhenStopped={false} size={13} color={colors.textTertiary} />
      <View testID="chat-working-status" accessible accessibilityLabel={label} className="flex-row items-center">
        {CHAT_WORKING_LETTERS.map((letter, index) => (
          <WorkingLetter key={index} letter={letter} index={index} progress={progress} reduceMotion={reduceMotion} />
        ))}
        <Text className="text-[12px] font-medium leading-4 text-muted-foreground">{` (${duration})`}</Text>
      </View>
    </View>
  );
}

function ChatActivityStrip({ activity, bottom, onPress }: {
  activity: ChatActivity;
  bottom: number;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const glass = useAppGlassEnabled();
  const reduceMotion = useReducedMotion();
  return (
    <GlassSurface
      testID="chat-pinned-activity"
      tintOpacity={CHAT_ACTIVITY_TINT_OPACITY}
      className={cn('absolute left-4 right-4 z-20 rounded-xl', glass && APP_GLASS_BORDER_CLASS_NAME)}
      fallbackClassName="border border-border bg-background"
      style={{ bottom, height: CHAT_CONTEXT_HEIGHT }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Current activity: ${activity.title}${activity.detail ? `, ${activity.detail}` : ''}`}
        accessibilityHint="Jump to the latest output"
        className="min-h-11 flex-row items-center gap-2 px-3"
        onPress={hapticPress(onPress)}
      >
        <ActivityIndicator animating={!reduceMotion} hidesWhenStopped={false} size={13} color={colors.textTertiary} />
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

type ToolKind = 'command' | 'file' | 'mcp' | 'web' | 'other';

interface ToolPresentation {
  title: string;
  icon?: LucideIcon;
  subtitle?: string;
  args: string[];
  command?: string;
  href?: string;
  kind: ToolKind;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function filename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

function primitiveArgs(
  input: TranscriptToolPart['state']['input'],
  omitted: readonly string[],
): string[] {
  const skip = new Set(omitted);
  return Object.entries(input).flatMap(([key, value]) => {
    if (skip.has(key)) return [];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = String(value).trim();
      return text ? [`${key}=${text}`] : [];
    }
    return [];
  }).slice(0, 2);
}

function toolKind(name: string): ToolKind {
  if (/^(?:patch|edit|write|file|read)$/i.test(name)) return 'file';
  if (/^(?:shell|bash|command|terminal)$/i.test(name)) return 'command';
  if (/web|search|fetch|open_page/i.test(name)) return 'web';
  if (/mcp| · /.test(name)) return 'mcp';
  return 'other';
}

function toolPresentation(item: TranscriptToolPart): ToolPresentation {
  const input = item.state.input;
  const name = item.tool.toLowerCase();
  const kind = toolKind(name);
  const command = textValue(input.command)?.trim();
  const path = textValue(input.path)?.trim();
  const query = textValue(input.query)?.trim();
  const url = textValue(input.url)?.trim();
  const description = textValue(input.description)?.trim();
  if (kind === 'command') {
    return { title: 'Shell', icon: SquareTerminal, subtitle: command || item.state.title, args: [], command, kind };
  }
  if (kind === 'file') {
    const action = /read/.test(name)
      ? { title: 'Read', icon: File }
      : /write/.test(name)
        ? { title: 'Write', icon: FilePlus }
        : /patch|apply/.test(name)
          ? { title: 'Patch', icon: FileDiff }
          : { title: 'Edit' };
    return {
      ...action,
      subtitle: filename(path) || item.state.title,
      args: primitiveArgs(input, ['path', 'old_string', 'new_string', 'content']),
      kind,
    };
  }
  if (kind === 'web') {
    return {
      title: url ? 'Fetch' : 'Web search',
      icon: url ? Link : Search,
      subtitle: url || query || item.state.title,
      args: primitiveArgs(input, ['url', 'query', 'queries']),
      href: url,
      kind,
    };
  }
  if (name === 'task') {
    const agent = textValue(input.agent)?.trim() || 'Agent';
    const background = input.background === true ? ['background'] : [];
    return {
      title: agent.charAt(0).toUpperCase() + agent.slice(1),
      subtitle: description || item.state.title,
      args: background,
      kind,
    };
  }
  return {
    title: `Called ${name === 'tool' ? (kind === 'mcp' ? 'MCP' : 'tool') : name}`,
    subtitle: description || query || url || item.state.title,
    args: primitiveArgs(input, ['description', 'query', 'url', 'path']),
    kind,
  };
}

interface BlockExpansion {
  expanded: boolean;
  onToggle: () => void;
}

function toolHeaderPreview(text: string): string {
  // A native one-line limit still creates spans for the entire supplied string.
  const preview = text.slice(0, TOOL_HEADER_PREVIEW_LENGTH).split(/[\r\n]/, 1)[0].trimEnd()
    .replace(/[\uD800-\uDBFF]$/u, '');
  return preview.length < text.length ? `${preview}…` : preview;
}

function ToolCard({ item, expanded, onToggle, active, onLinkPress }: BlockExpansion & { item: TranscriptToolPart; active: boolean; onLinkPress: (url: string) => void }) {
  const { colors } = useTheme();
  const failed = item.state.status === 'error';
  const presentation = toolPresentation(item);
  const name = item.tool.toLowerCase();
  const files = item.state.files;
  const changes = files.length
    ? {
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
    }
    : null;
  const shellCommand = presentation.kind === 'command' ? presentation.command : undefined;
  const shellOutput = presentation.kind === 'command' ? item.state.output : undefined;
  const markdownOutput = /^(?:list|glob|grep|websearch)$/.test(name) ? item.state.output : undefined;
  const otherOutput = !shellOutput && !markdownOutput ? item.state.output : undefined;
  const writtenContent = name === 'write' ? textValue(item.state.input.content) : undefined;
  const error = item.state.error;
  const diagnostics = item.state.diagnostics
    .filter(diagnostic => diagnostic.severity === 'error')
    .slice(0, 3);
  const hasDetail = Boolean(shellCommand || shellOutput || otherOutput || files.length || markdownOutput || writtenContent || error || item.state.loaded.length || diagnostics.length
    || item.state.inputJson || Object.keys(item.state.input).length || item.timestamp !== undefined
    || item.state.startedAt !== undefined || item.state.completedAt !== undefined || item.state.exitCode !== undefined || item.state.durationMs !== undefined);
  const subtitle = presentation.subtitle
    || (files.length === 1 ? filename(files[0].file) : files.length > 1 ? `${files.length} files` : undefined);
  const displayedSubtitle = subtitle ? toolHeaderPreview(!expanded && presentation.kind === 'command'
    ? subtitle.replace(NIX_EXECUTABLE_PREFIX, '')
    : subtitle) : undefined;
  const displayedTitle = toolHeaderPreview(presentation.title);
  const displayedArgs = presentation.args.map(toolHeaderPreview);
  const TitleIcon = presentation.icon;
  return (
    <View
      className={cn('min-h-11 w-full overflow-hidden rounded-md px-2', failed ? 'bg-destructive/10' : 'bg-primary/10')}
    >
      <Pressable
        testID="agent-tool-toggle"
        accessibilityRole="button"
        accessibilityLabel={TitleIcon
          ? [displayedTitle, !isRunning(item) && displayedSubtitle, ...(!isRunning(item) ? displayedArgs : [])].filter(Boolean).join(', ')
          : undefined}
        accessibilityState={{ expanded }}
        disabled={!hasDetail && !presentation.href}
        className="min-h-11 flex-row items-center py-1"
        onPress={hasDetail ? hapticPress(onToggle) : () => {
          if (presentation.href) onLinkPress(presentation.href);
        }}
      >
        {isRunning(item) && (
          <View className="mr-1.5 size-4 items-center justify-center">
            <ActivityIndicator animating={active} size={13} color={colors.textTertiary} />
          </View>
        )}
        {failed && (
          <View className="mr-1.5 size-4 items-center justify-center">
            <CircleAlert size={14} color={colors.error} />
          </View>
        )}
        <View className="min-w-0 shrink flex-row items-center gap-1.5">
          {TitleIcon
            ? <TitleIcon size={16} color={colors.text} />
            : <Text numberOfLines={1} className="shrink-0 text-[13px] font-medium leading-5 text-foreground">
              <SearchText text={displayedTitle} />
            </Text>}
          {displayedSubtitle && !isRunning(item) && (
            <>
              <Text className="text-[11px] leading-5 text-muted-foreground">·</Text>
              <Text numberOfLines={1} className="min-w-0 shrink text-[13px] leading-5 text-muted-foreground">
                <SearchText text={displayedSubtitle} />
              </Text>
            </>
          )}
          {!isRunning(item) && displayedArgs.map((arg, index) => (
            <Text key={presentation.args[index]} numberOfLines={1} className="shrink text-[12px] leading-5 text-muted-foreground">
              <SearchText text={arg} />
            </Text>
          ))}
        </View>
        {changes && !isRunning(item) && (
          <View className="ml-2 shrink-0 flex-row gap-1.5">
            <Text className="font-mono text-[11px] leading-5" style={{ color: colors.done }}>+{changes.additions}</Text>
            <Text className="font-mono text-[11px] leading-5" style={{ color: colors.error }}>−{changes.deletions}</Text>
          </View>
        )}
        {presentation.href && !isRunning(item) && (
          <Pressable accessibilityLabel={`Open ${toolHeaderPreview(presentation.href)}`} className="ml-1 size-7 items-center justify-center" hitSlop={SMALL_ICON_HIT_SLOP} onPress={event => { event.stopPropagation(); onLinkPress(presentation.href!); }}>
            <ExternalLink size={14} color={colors.textTertiary} />
          </Pressable>
        )}
        {hasDetail && (expanded
          ? <ChevronDown className="ml-1" size={15} color={colors.textTertiary} />
          : <ChevronRight className="ml-1" size={15} color={colors.textTertiary} />)}
      </Pressable>
      {expanded && hasDetail && (
        <View className="mb-3 mt-1 gap-2">
          <ToolMetadata item={item} />
          <ToolInputDetails item={item} />
          {shellCommand
            ? <ShellToolBlock command={shellCommand} output={shellOutput} />
            : shellOutput ? <ToolOutputBlock text={shellOutput} bordered copyable /> : null}
          {files.map(file => <ToolFileDiffBlock key={file.file} file={file} />)}
          {markdownOutput && <ToolOutputBlock text={markdownOutput} markdown bordered copyable onLinkPress={onLinkPress} />}
          {otherOutput && <ToolOutputBlock text={otherOutput} bordered copyable />}
          {writtenContent && <ToolOutputBlock text={writtenContent} bordered copyable />}
          {error && <ToolOutputBlock text={error} error />}
          {diagnostics.length > 0 && (
            <View className="gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2">
              {diagnostics.map(diagnostic => (
                <View key={`${diagnostic.file}:${diagnostic.line}:${diagnostic.message}`} className="flex-row gap-2">
                  <Text className="shrink-0 font-mono text-[9px] text-destructive"><SearchText text={`${filename(diagnostic.file)}${diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}` : ''}`} /></Text>
                  <Text selectable className="min-w-0 flex-1 text-[10px] leading-4 text-destructive"><SearchText text={diagnostic.message} /></Text>
                </View>
              ))}
            </View>
          )}
          {item.state.loaded.map(path => <Text key={path} numberOfLines={1} className="px-1 font-mono text-[10px] text-muted-foreground">Loaded <SearchText text={path} /></Text>)}
        </View>
      )}
    </View>
  );
}

function ToolCodeCopyButton({
  accessibilityLabel = 'Copy tool output',
  text,
}: {
  accessibilityLabel?: string;
  text: string;
}) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { copied, copyText } = useCopyFeedback();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityValue={{ text: copied ? t('markdown.copied') : '' }}
      className="absolute right-1 top-1 z-10 size-11 items-end justify-start"
      onPress={() => copyText(text)}
    >
      <View className="size-7 items-center justify-center rounded-md bg-background/90">
        {copied ? <Check size={13} color={colors.done} /> : <Copy size={13} color={colors.textTertiary} />}
      </View>
    </Pressable>
  );
}

function ShellToolBlock({ command, output }: { command: string; output?: string }) {
  return (
    <View className="gap-2">
      <NativeCodeBlock content={command} language="bash" />
      {output && (
        <ToolOutputBlock
          text={output}
          bordered
          copyable
          copyText={`$ ${command}\n\n${output}`}
          copyAccessibilityLabel="Copy shell command and output"
        />
      )}
    </View>
  );
}

// Mounted only inside expanded tool cards; collapsed rows do no JSON work.
const ToolOutputBlock = memo(function MemoizedToolOutput({
  text,
  markdown = false,
  onLinkPress,
  bordered = false,
  muted = false,
  error = false,
  copyable = false,
  copyText,
  copyAccessibilityLabel,
}: {
  text: string;
  markdown?: boolean;
  onLinkPress?: (url: string) => void;
  bordered?: boolean;
  muted?: boolean;
  error?: boolean;
  copyable?: boolean;
  copyText?: string;
  copyAccessibilityLabel?: string;
}) {
  const json = useMemo(() => parseJsonToolOutput(text), [text]);
  if (markdown && !json) {
    return (
      <View className="border-l border-border py-1 pl-3">
        <MarkdownText content={text} variant="transcript" onLinkPress={({ url }) => onLinkPress?.(url)} />
      </View>
    );
  }
  return (
    <View className={cn('relative overflow-hidden', bordered && 'rounded-md border border-border', copyable && 'min-h-11')}>
      {copyable && <ToolCodeCopyButton text={copyText ?? text} accessibilityLabel={copyAccessibilityLabel} />}
      <ScrollView
        className="w-full"
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        contentContainerClassName={bordered ? 'min-w-full px-3 py-2.5 pr-10' : 'min-w-full px-1 py-1'}
      >
        <View>
          {!json && (
            <Text
              selectable
              className={cn(
                'font-mono text-[11px] leading-[17px] text-foreground',
                muted && 'text-muted-foreground',
                error && 'text-destructive',
              )}
            >
              <SearchText text={text} />
            </Text>
          )}
          {json && <JsonOutputViewer key={text} value={json.value} />}
        </View>
      </ScrollView>
    </View>
  );
});

function ToolInputDetails({ item }: { item: TranscriptToolPart }) {
  const [open, setOpen] = useState(false);
  const { colors } = useTheme();
  const input = useMemo(() => item.state.inputJson
    ?? (Object.keys(item.state.input).length ? JSON.stringify(item.state.input, null, 2) : undefined),
  [item.state.inputJson, item.state.input]);
  if (!input) return null;
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel="Tool input details" accessibilityState={{ expanded: open }}
        className="min-h-11 flex-row items-center gap-2" onPress={() => setOpen(value => !value)}>
        {open ? <ChevronDown size={13} color={colors.textTertiary} /> : <ChevronRight size={13} color={colors.textTertiary} />}
        <Text className="text-[11px] text-muted-foreground">Input</Text>
      </Pressable>
      {open && <ToolOutputBlock text={input} bordered copyable copyAccessibilityLabel="Copy tool input" />}
    </View>
  );
}

function ToolMetadata({ item }: { item: TranscriptToolPart }) {
  const { startedAt, completedAt, durationMs, exitCode } = item.state;
  const duration = durationMs ?? (startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt ? completedAt - startedAt : undefined);
  const summary = [duration === undefined ? undefined : formatElapsed(duration),
    exitCode !== undefined && toolKind(item.tool) === 'command' ? `Exit ${exitCode}` : undefined].filter(Boolean);
  if (!summary.length && startedAt === undefined && completedAt === undefined && item.timestamp === undefined) return null;
  return (
    <View className="gap-1">
      {summary.length > 0 && <Text className="text-[11px] text-muted-foreground">{summary.join(' · ')}</Text>}
      {startedAt !== undefined && <MetadataLine label="Started" value={formatFullTime(startedAt)} />}
      {completedAt !== undefined && <MetadataLine label="Finished" value={formatFullTime(completedAt)} />}
      {startedAt === undefined && completedAt === undefined && item.timestamp !== undefined && <MetadataLine label="Recorded" value={formatFullTime(item.timestamp)} />}
    </View>
  );
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
  onLinkPress,
  streaming = false,
  expanded,
  onToggle,
  active,
}: BlockExpansion & {
  active: boolean;
  part: TranscriptPart;
  onLinkPress: (url: string) => void;
  streaming?: boolean;
}) {
  const { colors } = useTheme();
  if (part.type === 'text') {
    if (!part.text.trim()) return null;
    return <View className="min-w-0 w-full"><MarkdownText content={part.text} streaming={streaming} variant="transcript" onLinkPress={({ url }) => onLinkPress(url)} /></View>;
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
  if (part.type === 'tool') return <ToolCard item={part} expanded={expanded} onToggle={onToggle} active={active} onLinkPress={onLinkPress} />;
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

function formatElapsed(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds < 10) return `${Number(seconds.toFixed(2))}s`;
  const rounded = Math.round(seconds);
  return rounded < 60 ? `${rounded}s` : `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

function formatFullTime(value: number): string {
  return new Date(value).toLocaleString();
}

function MetadataLine({ label, value }: { label: string; value?: string | number }) {
  if (value === undefined) return null;
  return <View className="flex-row gap-3"><Text className="w-24 text-[11px] text-muted-foreground">{label}</Text><Text selectable className="min-w-0 flex-1 text-[11px] text-foreground">{value}</Text></View>;
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

function UserPrompt({ message, imageClient, directory, active }: {
  message: TranscriptMessage;
  imageClient?: RemoteFileClient;
  directory?: string;
  active: boolean;
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
          ? <ChatPromptImage key={part.id} source={part.source} client={imageClient} directory={directory} active={active} />
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
  block, active, expanded, searchSelected, searchQuery, onToggle, onLinkPress, imageClient, directory, onAddToComposer, readAloud,
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
}) {
  const { colors } = useTheme();
  const toggle = () => onToggle(block.id);
  const content = () => {
    switch (block.type) {
      case 'user': return <UserPrompt message={block.message} imageClient={imageClient} directory={directory} active={active} />;
      case 'part': return <View className="gap-1">
        {block.message?.createdAt !== undefined && <Text className="text-[9px] text-muted-foreground">Assistant · {new Date(block.message.createdAt).toLocaleTimeString()}</Text>}
        <AssistantPart part={block.part} streaming={active && block.streaming} expanded={expanded} onToggle={toggle} active={active} onLinkPress={onLinkPress} />
      </View>;
      case 'error': return <TranscriptNoticeCard error className="flex-row"><CircleAlert size={15} color={colors.error} /><Text selectable className="min-w-0 flex-1 text-[12px] leading-[18px] text-muted-foreground"><SearchText text={block.error} /></Text></TranscriptNoticeCard>;
      case 'changes': return <ChangedFiles turn={block.turn} expanded={expanded} onToggle={toggle} />;
      case 'diff': return <ToolFileDiffBlock file={block.file} />;
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
        <ChatSearchQuery.Provider value={searchQuery}>{content()}</ChatSearchQuery.Provider>
      </ChatComposerSelection.Provider>
    </View>
  );
});

export function AgentChatView({
  imageClient,
  searchRuntime,
  searchKey,
  savedSearchNamespace,
  conversationSearchNamespace,
  initialSearchTarget,
  state,
  active = true,
  agent,
  agentStatus,
  contentInsets,
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
  const selectionOwner = useRef({ active, sessionId: state.sessionId });
  selectionOwner.current = { active, sessionId: state.sessionId };
  const addSelectionToComposer = useCallback((text: string) => {
    if (selectionOwner.current.active && selectionOwner.current.sessionId === state.sessionId) {
      addToComposer?.(text);
    }
  }, [addToComposer, state.sessionId]);
  const searchSession = useRef(state.sessionId);
  const searchOpen = active && searchRequested && searchSession.current === state.sessionId;
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
  const [scrollGeometry, setScrollGeometry] = useState<ChatScrollGeometry>({
    contentHeight: 0,
    offset: 0,
    viewportHeight: 0,
  });
  const turns = state.transcript.turns;
  const agentWorking = agentStatus === 'working';
  const requestedSource = useMemo(() => conversationSearchNamespace
    ? { type: 'conversation' as const, namespace: conversationSearchNamespace, agent, sessionId: state.sessionId }
    : searchRuntime && searchKey
    ? { type: 'live' as const, runtime: searchRuntime, key: searchKey }
    : savedSearchNamespace
      ? { type: 'saved' as const, namespace: savedSearchNamespace, agent, sessionId: state.sessionId }
      : undefined, [searchRuntime, searchKey, savedSearchNamespace, conversationSearchNamespace, agent, state.sessionId]);
  const sourceIdentity = JSON.stringify([state.sessionId, agent, searchKey, savedSearchNamespace, conversationSearchNamespace]);
  const retainedSource = useRef<{ identity: string; source: NonNullable<typeof requestedSource> } | undefined>(undefined);
  if (requestedSource) retainedSource.current = { identity: sourceIdentity, source: requestedSource };
  else if (retainedSource.current?.identity !== sourceIdentity) retainedSource.current = undefined;
  // A host disconnect can temporarily remove its JS client. This viewport's
  // native owner still has the canonical manager and its last usable history.
  const searchSource = retainedSource.current?.source;
  const search = useChatSearch(searchSource, state.transcript, searchOpen && active, initialSearchTarget);
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
  const lastInitialViewportDiagnosticRef = useRef('');
  const agentName = chatAgentDisplayName(agent);
  const anchorIndex = savedViewport?.anchor && !savedViewport.followEnd
    ? rowStore.indexOf(savedViewport.anchor.blockId) : -1;
  const initialScrollIndex = anchorIndex < 0 ? undefined : anchorIndex;

  const saveViewport = useCallback(() => {
    if (initialViewportRef.current.ready) {
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
    if (active && searchRequested) onCloseSearch?.();
  }, [state.sessionId, active, searchRequested, onCloseSearch]);

  useLayoutEffect(() => {
    if (!searchOpen) return;
    followEndRef.current = false;
    setFollowEndState(false);
  }, [searchOpen]);

  useLayoutEffect(() => {
    const match = search.match;
    if (!match || !active) {
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
  }, [search.match, search.query, search.navigationRevision, active]);

  const searchBarHeight = searchOpen ? chatSearchBarHeight(search.query) : 0;
  const contextTop = contentInsets.top + searchBarHeight;
  const { prompt: pinnedPrompt, update: updatePinnedPrompt } = usePinnedPrompt(rowStore, state, list, contextTop);
  const latestTurn = turns.at(-1);
  const workActive = state.status === 'live'
    && (agentWorking || latestTurn?.status === 'working')
    && latestTurn?.status !== 'error' && latestTurn?.status !== 'interrupted';
  const candidates = useMemo(() => workActive
      ? currentActivity(blocks, state, latestTurn)
      : undefined, [workActive, latestTurn, blocks, state]);
  const activityBottom = contentInsets.bottom + CHAT_CONTEXT_GAP;

  useLayoutEffect(() => {
    updatePinnedPrompt(scrollGeometryRef.current.offset);
  }, [updatePinnedPrompt]);

  const revealSearchMatch = () => {
    if (pendingSearch.current && active && initialViewportRef.current.ready) {
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
    scrollGeometryRef.current = next;
    updatePinnedPrompt(next.offset);
    setScrollGeometry(current => (
      current.contentHeight === next.contentHeight
      && current.offset === next.offset
      && current.viewportHeight === next.viewportHeight
        ? current
        : next
    ));
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
    if (!active || readiness.ready) return;
    recordInitialViewportReadiness(source);
    if (!initialViewportConditionsSatisfied()) return;
    readiness.ready = true;
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
    if (active && initialViewportRef.current.ready && followEndRef.current
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
      !active || readiness.ready ||
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

  const updateViewportActivity = useEffectEvent(() => {
    if (activeRef.current === active) return;
    activeRef.current = active;
    const readiness = initialViewportRef.current;
    if (!active && readiness.ready) {
      saveViewport();
    }
    readiness.ready = false;
    setViewportReady(false);
    resetScroll();
    scrollInteractionRef.current = {
      kind: ChatScrollInteractionKind.Idle,
      lastOffset: scrollGeometryRef.current.offset,
    };
    scrollbarDragRef.current = null;
    if (active) {
      setFollowEnd(savedViewportRef.current?.followEnd ?? true);
      alignLoadedInitialViewport();
      scheduleInitialViewportReady('reactivated');
    }
  });

  useLayoutEffect(() => {
    updateViewportActivity();
  }, [active]);

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
    if (!active) return;
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

  const viewportVisible = active && activeRef.current === active && (viewportReady || Boolean(rowStore.error));

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
          initialViewportRef.current.viewportLaidOut = true;
          const current = scrollGeometryRef.current;
          updateScrollExtent({
            contentHeight: current.contentHeight,
            viewportHeight: event.nativeEvent.layout.height,
          });
          alignLoadedInitialViewport();
        }}
      >
        {(rowStore.ready || rowStore.error) && <FlashList
          ref={list}
          onCommitLayoutEffect={() => {
            updatePinnedPrompt(scrollGeometryRef.current.offset);
            revealSearchMatch();
          }}
          initialScrollIndex={initialScrollIndex}
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
              expanded={expandedBlocks.has(item.id)}
              searchSelected={search.match?.documentId === item.id}
              searchQuery={searchOpen && search.ready ? search.query.trim() : ''}
              onToggle={toggleBlock}
              onLinkPress={openTranscriptLink}
              imageClient={imageClient}
              directory={state.transcript.info?.directory}
              onAddToComposer={active && addToComposer ? addSelectionToComposer : undefined}
              readAloud={active ? readAloud : undefined}
            />
          ) : null;
          }}
          contentContainerStyle={chatListStyles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={
            CHAT_MAINTAIN_VISIBLE_CONTENT_POSITION
          }
          scrollIndicatorInsets={contentInsets}
          showsVerticalScrollIndicator={false}
          viewabilityConfig={CHAT_VIEWABILITY_CONFIG}
          ListHeaderComponent={
            <>
              <ChatBoundarySpacer height={contentPadding.top} />
              {(state.status !== 'live' || rowStore.error) && (
                <View
                  className={cn(
                    'flex-row items-center gap-2 py-3',
                    turns.length > 0 && 'mb-4',
                  )}
                >
                  {state.status === 'loading' ? (
                    <ActivityIndicator animating={active} size="small" color={colors.primary} />
                  ) : (
                    <CircleAlert size={14} color={colors.textSecondary} />
                  )}
                  <Text
                    numberOfLines={2}
                    className="min-w-0 flex-1 text-[12px] text-muted-foreground"
                  >
                    {rowStore.error || state.error ||
                      (state.status === 'loading'
                        ? `Reading the local ${agentName} history…`
                        : 'The transcript is temporarily unavailable.')}
                  </Text>
                </View>
              )}
            </>
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
              active && initialViewportRef.current.ready &&
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
        {active && !searchOpen && pinnedPrompt && (
          <Pressable
            testID="chat-pinned-prompt"
            accessibilityRole="button"
            accessibilityLabel={`Jump to prompt: ${pinnedPrompt.preview}`}
            accessibilityHint="Scrolls to the original message"
            className="absolute left-4 right-4 z-20 flex-row items-center gap-2 rounded-xl bg-purple-950 px-3"
            style={{ top: contextTop, height: CHAT_CONTEXT_HEIGHT }}
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
        {activity && (
          <ChatActivityStrip
            activity={activity}
            bottom={activityBottom}
            onPress={() => {
              pendingSearch.current = null;
              setFollowEnd(true);
              scrollToLatest(true);
            }}
          />
        )}
        {searchOpen && <ChatSearchBar search={search} top={contentInsets.top} onClose={() => {
          pendingSearch.current = null;
          onCloseSearch?.();
          Keyboard.dismiss();
        }} />}
        {awayFromLatest && !scrolling && !activity && (
          <Button
            accessibilityLabel="Jump to latest"
            className={LATEST_BUTTON_CLASS_NAME}
            style={[
              { bottom: latestButtonBottom },
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
