import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlashList,
  type FlashListRef,
  type ViewToken,
} from '@shopify/flash-list';
import CodeHighlighter from 'react-native-code-highlighter';
import {
  atomOneDarkReasonable,
  atomOneLight,
} from 'react-syntax-highlighter/dist/esm/styles/hljs';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  File,
} from 'lucide-react-native';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import type {
  AgentChatState,
  TranscriptFileDiff,
  TranscriptMessage,
  TranscriptPart,
  TranscriptToolPart,
  TranscriptTurn,
} from '../agentChat';
import type { ChatAgent } from '../lib/agentChatSession';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from '../services/operationalDiagnostics';
import { recordAgentChatDiagnostic } from '../services/agentChatDiagnostics';
import { appGlassBackgroundClassName } from '../lib/appGlass';
import { insetContentPadding, type VisualContentInsets } from '../lib/floatingChrome';
import { scrollOffsetFromDrag, scrollThumbGeometry } from '../lib/terminalScroll';
import { terminalFontFamily } from '../lib/terminalFonts';
import { transcriptFileLinkTarget, type TranscriptFileLinkTarget } from '../lib/transcriptLinks';
import { cn } from '../lib/utils';
import { appGlassControlStyle, useTheme } from '../theme';
import type { AgentStatus } from '../types';
import { useReducedMotion } from './app-ui';
import { useAppGlassEnabled } from './GlassSurface';
import { MarkdownText } from './MarkdownText';
import { OverlayScrollbar, type OverlayScrollbarDragEvent } from './OverlayScrollbar';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface Props {
  state: AgentChatState;
  agent: ChatAgent;
  agentStatus: AgentStatus;
  contentInsets: VisualContentInsets;
  latestButtonBottom: number;
  onOpenFile: (target: TranscriptFileLinkTarget) => void;
  onInitialViewportReady?: () => void;
}

const COPY_FEEDBACK_MS = 1_500;
const CHAT_CONTENT_TOP_GAP = 16;
const CHAT_CONTENT_BOTTOM_GAP = 24;
const CHAT_FOLLOW_END_THRESHOLD = 72;
const CHAT_INITIAL_END_THRESHOLD = 2;
const CHAT_SCROLL_OFFSET_EPSILON = 1;
const SMALL_ICON_HIT_SLOP = 8;
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
  measuredLatestTurnId: string | null;
  ready: boolean;
  viewableLatestTurnId: string | null;
  viewportLaidOut: boolean;
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

function ThinkingIndicator() {
  const reduceMotion = useReducedMotion();
  const progress = useSharedValue(0);
  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (reduceMotion) return;
    progress.value = withRepeat(withSequence(
      withTiming(1, { duration: 800, easing: Easing.inOut(Easing.quad) }),
      withTiming(0, { duration: 800, easing: Easing.inOut(Easing.quad) }),
    ), -1);
    return () => cancelAnimation(progress);
  }, [progress, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: reduceMotion ? 1 : 0.48 + (progress.value * 0.52) }), [reduceMotion]);
  return (
    <View accessibilityLiveRegion="polite" className="mt-3 min-h-5 flex-row items-center">
      <Animated.View style={style}>
        <Text className="text-[13px] font-medium leading-5 text-muted-foreground">Thinking</Text>
      </Animated.View>
    </View>
  );
}

type ToolKind = 'command' | 'file' | 'mcp' | 'web' | 'other';

interface ToolPresentation {
  title: string;
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
  if (/^(?:shell|command|terminal)$/i.test(name)) return 'command';
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
    return { title: 'Shell', subtitle: command || item.state.title, args: [], command, kind };
  }
  if (kind === 'file') {
    const lower = name.toLowerCase();
    const title = /read/.test(lower)
      ? 'Read'
      : /write/.test(lower)
        ? 'Write'
        : /patch|apply/.test(lower)
          ? 'Patch'
          : 'Edit';
    return {
      title,
      subtitle: filename(path) || item.state.title,
      args: primitiveArgs(input, ['path', 'old_string', 'new_string', 'content']),
      kind,
    };
  }
  if (kind === 'web') {
    return {
      title: url ? 'Fetch' : 'Web search',
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

function isRunning(item: TranscriptToolPart): boolean {
  return item.state.status === 'pending' || item.state.status === 'running';
}

function ToolCard({ item }: { item: TranscriptToolPart }) {
  const { colors } = useTheme();
  const failed = item.state.status === 'error';
  const [expanded, setExpanded] = useState(false);
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
  const writtenContent = name === 'write' ? textValue(item.state.input.content) : undefined;
  const error = item.state.error;
  const diagnostics = item.state.diagnostics
    .filter(diagnostic => diagnostic.severity === 'error')
    .slice(0, 3);
  const hasDetail = Boolean(shellCommand || shellOutput || files.length || markdownOutput || writtenContent || error || item.state.loaded.length || diagnostics.length);
  const subtitle = presentation.subtitle
    || (files.length === 1 ? filename(files[0].file) : files.length > 1 ? `${files.length} files` : undefined);
  return (
    <View
      className={cn('min-h-11 w-full overflow-hidden', failed && 'rounded-md bg-destructive/10 px-2')}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        disabled={!hasDetail && !presentation.href}
        className="min-h-11 flex-row items-center py-1"
        onPress={() => {
          if (hasDetail) setExpanded(value => !value);
          else if (presentation.href) openExternalUrl(presentation.href);
        }}
      >
        {isRunning(item) && (
          <View className="mr-1.5 size-4 items-center justify-center">
            <ActivityIndicator size={13} color={colors.textTertiary} />
          </View>
        )}
        {failed && (
          <View className="mr-1.5 size-4 items-center justify-center">
            <CircleAlert size={14} color={colors.error} />
          </View>
        )}
        <View className="min-w-0 shrink flex-row items-center gap-1.5">
          <Text numberOfLines={1} className="shrink-0 text-[13px] font-medium leading-5 text-foreground">
            {presentation.title}
          </Text>
          {subtitle && !isRunning(item) && (
            <>
              <Text className="text-[11px] leading-5 text-muted-foreground">·</Text>
              <Text numberOfLines={1} className="min-w-0 shrink text-[13px] leading-5 text-muted-foreground">
                {subtitle}
              </Text>
            </>
          )}
          {!isRunning(item) && presentation.args.map(arg => (
            <Text key={arg} numberOfLines={1} className="shrink text-[12px] leading-5 text-muted-foreground">
              {arg}
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
          <Pressable accessibilityLabel={`Open ${presentation.href}`} className="ml-1 size-7 items-center justify-center" hitSlop={SMALL_ICON_HIT_SLOP} onPress={event => { event.stopPropagation(); openExternalUrl(presentation.href!); }}>
            <ExternalLink size={14} color={colors.textTertiary} />
          </Pressable>
        )}
        {hasDetail && (expanded
          ? <ChevronDown className="ml-1" size={15} color={colors.textTertiary} />
          : <ChevronRight className="ml-1" size={15} color={colors.textTertiary} />)}
      </Pressable>
      {expanded && hasDetail && (
        <View className="mb-3 mt-1 gap-2">
          {shellCommand
            ? <ShellToolBlock command={shellCommand} output={shellOutput} />
            : shellOutput ? <ToolCodeBlock text={shellOutput} bordered copyable /> : null}
          {files.map(file => <ToolFileDiffBlock key={file.file} file={file} />)}
          {markdownOutput && <View className="border-l border-border py-1 pl-3"><MarkdownText content={markdownOutput} variant="transcript" /></View>}
          {writtenContent && <ToolCodeBlock text={writtenContent} bordered copyable />}
          {error && <ToolCodeBlock text={error} error />}
          {diagnostics.length > 0 && (
            <View className="gap-1.5 rounded-md bg-destructive/10 px-2.5 py-2">
              {diagnostics.map(diagnostic => (
                <View key={`${diagnostic.file}:${diagnostic.line}:${diagnostic.message}`} className="flex-row gap-2">
                  <Text className="shrink-0 font-mono text-[9px] text-destructive">{filename(diagnostic.file)}{diagnostic.line ? `:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ''}` : ''}</Text>
                  <Text selectable className="min-w-0 flex-1 text-[10px] leading-4 text-destructive">{diagnostic.message}</Text>
                </View>
              ))}
            </View>
          )}
          {item.state.loaded.map(path => <Text key={path} numberOfLines={1} className="px-1 font-mono text-[10px] text-muted-foreground">Loaded {path}</Text>)}
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
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      className="absolute right-1 top-1 z-10 size-11 items-end justify-start"
      onPress={() => Clipboard.setString(text)}
    >
      <View className="size-7 items-center justify-center rounded-md bg-background/90">
        <Copy size={13} color={colors.textTertiary} />
      </View>
    </Pressable>
  );
}

function ShellToolBlock({ command, output }: { command: string; output?: string }) {
  const { isDark } = useTheme();
  const copyText = [`$ ${command}`, output].filter(Boolean).join('\n\n');
  return (
    <View className="relative min-h-11 overflow-hidden rounded-md border border-border">
      <ToolCodeCopyButton accessibilityLabel="Copy shell command and output" text={copyText} />
      <CodeHighlighter
        hljsStyle={isDark ? atomOneDarkReasonable : atomOneLight}
        language="bash"
        scrollViewProps={{
          nestedScrollEnabled: true,
          showsHorizontalScrollIndicator: false,
          style: toolCodeStyles.scroll,
          contentContainerStyle: toolCodeStyles.highlightedContent,
        }}
        textStyle={toolCodeStyles.text}
      >
        {`$ ${command}`}
      </CodeHighlighter>
      {output && (
        <View className="border-t border-border px-2 py-1.5">
          <ToolCodeBlock text={output} />
        </View>
      )}
    </View>
  );
}

function ToolCodeBlock({
  text,
  bordered = false,
  muted = false,
  error = false,
  copyable = false,
}: {
  text: string;
  bordered?: boolean;
  muted?: boolean;
  error?: boolean;
  copyable?: boolean;
}) {
  return (
    <View className={cn('relative overflow-hidden', bordered && 'rounded-md border border-border', copyable && 'min-h-11')}>
      {copyable && <ToolCodeCopyButton text={text} />}
      <ScrollView
        className="w-full"
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        contentContainerClassName={bordered ? 'min-w-full px-3 py-2.5 pr-10' : 'min-w-full px-1 py-1'}
      >
        <Text
          selectable
          className={cn(
            'font-mono text-[11px] leading-[17px] text-foreground',
            muted && 'text-muted-foreground',
            error && 'text-destructive',
          )}
        >
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

const toolCodeStyles = StyleSheet.create({
  highlightedContent: {
    backgroundColor: 'transparent',
    minWidth: '100%',
    paddingBottom: 10,
    paddingLeft: 12,
    paddingRight: 40,
    paddingTop: 10,
  },
  scroll: {
    width: '100%',
  },
  text: {
    fontFamily: terminalFontFamily,
    fontSize: 11,
    includeFontPadding: false,
    lineHeight: 17,
  },
});

const chatListStyles = StyleSheet.create({
  content: {
    flexGrow: 1,
    paddingHorizontal: 16,
  },
});

function ToolDiffBlock({ diff }: { diff: string }) {
  const { colors } = useTheme();
  const lines = diff.split('\n');
  return (
    <View className="overflow-hidden">
      <ScrollView className="w-full" horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false} contentContainerClassName="min-w-full px-1">
        <Text selectable className="font-mono text-[11px] leading-[17px] text-foreground">
          {lines.map((line, index) => (
            <Text
              key={`${index}:${line}`}
              style={{
                color: line.startsWith('+') && !line.startsWith('+++')
                  ? colors.done
                  : line.startsWith('-') && !line.startsWith('---')
                    ? colors.error
                    : colors.text,
              }}
            >
              {line}{index < lines.length - 1 ? '\n' : ''}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}

function fileDiffText(file: TranscriptFileDiff): string | undefined {
  if (file.patch) return file.patch;
  if (file.before === undefined && file.after === undefined) return undefined;
  const before = (file.before || '').split('\n').map(line => `-${line}`).join('\n');
  const after = (file.after || '').split('\n').map(line => `+${line}`).join('\n');
  return [`--- ${file.file}`, `+++ ${file.file}`, before, after].filter(Boolean).join('\n');
}

function ToolFileDiffBlock({ file }: { file: TranscriptFileDiff }) {
  const { colors } = useTheme();
  const diff = fileDiffText(file);
  return (
    <View className="overflow-hidden rounded-md border border-border">
      <View className="min-h-8 flex-row items-center gap-2 border-b border-border px-2.5 py-1.5">
        <File size={13} color={colors.textTertiary} />
        <Text numberOfLines={1} className="min-w-0 flex-1 font-mono text-[10px] text-foreground">{file.file}</Text>
        {file.additions > 0 && <Text className="font-mono text-[10px]" style={{ color: colors.done }}>+{file.additions}</Text>}
        {file.deletions > 0 && <Text className="font-mono text-[10px]" style={{ color: colors.error }}>−{file.deletions}</Text>}
      </View>
      {diff && <View className="py-2"><ToolDiffBlock diff={diff} /></View>}
    </View>
  );
}

function isContextTool(part: TranscriptPart): part is TranscriptToolPart {
  return part.type === 'tool' && /^(?:read|list|glob|grep)$/i.test(part.tool);
}

function contextSummary(tools: readonly TranscriptToolPart[]): string {
  const counts = [
    ['read', tools.filter(tool => tool.tool === 'read').length],
    ['search', tools.filter(tool => /^(?:glob|grep)$/i.test(tool.tool)).length],
    ['list', tools.filter(tool => tool.tool === 'list').length],
  ] as const;
  const labels = counts.flatMap(([label, count]) => count ? [`${count} ${label}${count === 1 ? '' : 's'}`] : []);
  return labels.length ? labels.join(' · ') : `${tools.length} operation${tools.length === 1 ? '' : 's'}`;
}

function ContextToolGroup({ tools }: { tools: TranscriptToolPart[] }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const running = tools.some(isRunning);
  const failed = tools.some(tool => tool.state.status === 'error');
  return (
    <View className="w-full">
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} className="min-h-11 flex-row items-center py-1" onPress={() => setExpanded(value => !value)}>
        {running && <ActivityIndicator className="mr-2" size={13} color={colors.textTertiary} />}
        {failed && !running && <CircleAlert className="mr-2" size={14} color={colors.error} />}
        <Text className="text-[13px] font-medium text-foreground">{running ? 'Gathering context' : 'Gathered context'}</Text>
        <Text numberOfLines={1} className="ml-1.5 min-w-0 shrink text-[12px] text-muted-foreground">{contextSummary(tools)}</Text>
        {expanded ? <ChevronDown className="ml-1" size={15} color={colors.textTertiary} /> : <ChevronRight className="ml-1" size={15} color={colors.textTertiary} />}
      </Pressable>
      {expanded && <View className="ml-3 border-l border-border pl-3">{tools.map(tool => <ToolCard key={tool.id} item={tool} />)}</View>}
    </View>
  );
}

type PartGroup = { type: 'part'; part: TranscriptPart } | { type: 'context'; id: string; tools: TranscriptToolPart[] };

function groupParts(parts: readonly TranscriptPart[]): PartGroup[] {
  const groups: PartGroup[] = [];
  let context: TranscriptToolPart[] = [];
  const flush = () => {
    if (!context.length) return;
    groups.push({ type: 'context', id: `context:${context[0].id}`, tools: context });
    context = [];
  };
  for (const part of parts) {
    if (isContextTool(part)) {
      context.push(part);
      continue;
    }
    flush();
    groups.push({ type: 'part', part });
  }
  flush();
  return groups;
}

function renderablePart(part: TranscriptPart): boolean {
  if (part.type === 'text' || part.type === 'reasoning') return Boolean(part.text.trim());
  if (part.type === 'tool') {
    if (part.tool === 'todowrite') return false;
    if (part.tool === 'question' && isRunning(part)) return false;
    return true;
  }
  return part.type === 'plan' || part.type === 'notice';
}

function AssistantPart({
  part,
  onLinkPress,
  streaming = false,
}: {
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
  if (part.type === 'tool') return <ToolCard item={part} />;
  if (part.type === 'plan') {
    return <View className="w-full py-1"><Text className="mb-2 text-[13px] font-medium leading-5 text-foreground">Plan</Text><MarkdownText content={part.text} variant="transcript" onLinkPress={({ url }) => onLinkPress(url)} /></View>;
  }
  if (part.type === 'notice') {
    return (
      <View className={cn('w-full flex-row gap-2 rounded-md px-3 py-2.5', part.level === 'error' ? 'bg-destructive/10' : 'bg-muted')}>
        {part.level === 'error' && <CircleAlert size={15} color={colors.error} />}
        <Text selectable className="min-w-0 flex-1 text-[12px] leading-[18px] text-muted-foreground">{part.text}</Text>
      </View>
    );
  }
  return null;
}

function visibleUserText(message: TranscriptMessage | undefined): string {
  return message?.parts
    .filter(part => part.type === 'text')
    .map(part => part.type === 'text' ? part.text : '')
    .filter(Boolean)
    .join('\n') || '';
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

function UserPrompt({ message }: { message: TranscriptMessage }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const text = visibleUserText(message);
  if (!text) return null;
  const meta = formatTime(message.createdAt);
  return (
    <View className="ml-9 items-end">
      <Pressable accessibilityLabel="Copy prompt" className="min-h-11 max-w-[86%] rounded-xl bg-muted px-3 py-2.5" onLongPress={() => Clipboard.setString(text)}>
        <Text selectable className="text-[14px] leading-[20px] text-foreground">{text}</Text>
      </Pressable>
      <View className="mt-1 flex-row items-center gap-1 px-1">
        {meta && <Text className="text-[9px] text-muted-foreground">{meta}</Text>}
        <Button accessibilityLabel="Copy prompt" className="size-6 rounded-full px-0" variant="ghost" onPress={() => { Clipboard.setString(text); setCopied(true); setTimeout(() => setCopied(false), COPY_FEEDBACK_MS); }}>{copied ? <Check size={11} color={colors.done} /> : <Copy size={11} color={colors.textTertiary} />}</Button>
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

function TurnMeta({ turn }: { turn: TranscriptTurn }) {
  const { colors } = useTheme();
  const [copied, setCopied] = useState(false);
  const duration = formatDuration(turn.startedAt, turn.completedAt);
  const values = [
    duration,
    turn.status === 'interrupted' ? 'Interrupted' : undefined,
  ].filter(Boolean);
  const copy = assistantCopyText(turn);
  if (!values.length && !copy) return null;
  return (
    <View className="mt-2 min-h-7 flex-row items-center gap-2">
      {values.length > 0 && <Text className="text-[10px] text-muted-foreground">{values.join(' · ')}</Text>}
      {copy.length > 0 && (
        <Button
          accessibilityLabel="Copy response"
          className="ml-auto size-7 rounded-full px-0"
          variant="ghost"
          onPress={() => {
            Clipboard.setString(copy);
            setCopied(true);
            setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
          }}
        >
          {copied ? <Check size={13} color={colors.done} /> : <Copy size={13} color={colors.textTertiary} />}
        </Button>
      )}
    </View>
  );
}

function ChangedFiles({ turn }: { turn: TranscriptTurn }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  if (!turn.diffs.length) return null;
  const additions = turn.diffs.reduce((total, diff) => total + diff.additions, 0);
  const deletions = turn.diffs.reduce((total, diff) => total + diff.deletions, 0);
  return (
    <View className="mt-2 border-t border-border pt-2">
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} className="min-h-11 flex-row items-center" onPress={() => setExpanded(value => !value)}>
        <Text className="text-[11px] font-medium text-foreground">Changed {turn.diffs.length} file{turn.diffs.length === 1 ? '' : 's'}</Text>
        <Text className="ml-2 font-mono text-[10px]" style={{ color: colors.done }}>+{additions}</Text>
        <Text className="ml-1 font-mono text-[10px]" style={{ color: colors.error }}>−{deletions}</Text>
        {expanded
          ? <ChevronDown className="ml-auto" size={14} color={colors.textTertiary} />
          : <ChevronRight className="ml-auto" size={14} color={colors.textTertiary} />}
      </Pressable>
      {expanded && <View className="mt-1 gap-2">{turn.diffs.map(diff => <ToolFileDiffBlock key={diff.file} file={diff} />)}</View>}
    </View>
  );
}

const TranscriptTurnView = memo(function TranscriptTurnRow({
  turn,
  working,
  onLinkPress,
}: {
  turn: TranscriptTurn;
  working: boolean;
  onLinkPress: (url: string) => void;
}) {
  const { colors } = useTheme();
  const parts = useMemo(() => groupParts(turn.assistants.flatMap(message => message.parts).filter(renderablePart)), [turn.assistants]);
  const tail = parts.at(-1);
  const streamingPartId = working
    && tail?.type === 'part'
    && (tail.part.type === 'text' || tail.part.type === 'reasoning')
    && turn.assistants.some(message => message.completedAt === undefined && message.parts.includes(tail.part))
    ? tail.part.id
    : undefined;
  const hasRunningTool = parts.some(group => group.type === 'context'
    ? group.tools.some(isRunning)
    : group.part.type === 'tool' && isRunning(group.part));
  const showThinking = working && turn.status !== 'error' && streamingPartId === undefined && !hasRunningTool;
  return (
    <View className="w-full">
      {turn.user && <UserPrompt message={turn.user} />}
      <View className={cn('w-full gap-3', turn.user && 'mt-3')}>
        {parts.map(group => group.type === 'context'
          ? <ContextToolGroup key={group.id} tools={group.tools} />
          : <AssistantPart
              key={group.part.id}
              part={group.part}
              streaming={group.part.id === streamingPartId}
              onLinkPress={onLinkPress}
            />)}
        {showThinking && <ThinkingIndicator />}
        {turn.assistants.flatMap(message => message.error ? [message.error] : []).map((error, index) => (
          <View key={`error:${index}`} className="flex-row gap-2 rounded-md bg-destructive/10 px-3 py-2.5"><CircleAlert size={15} color={colors.error} /><Text selectable className="min-w-0 flex-1 text-[12px] leading-[18px] text-muted-foreground">{error}</Text></View>
        ))}
      </View>
      <ChangedFiles turn={turn} />
      <TurnMeta turn={turn} />
    </View>
  );
});

export function AgentChatView({
  state,
  agent,
  agentStatus,
  contentInsets,
  latestButtonBottom,
  onOpenFile,
  onInitialViewportReady,
}: Props) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const [followEnd, setFollowEndState] = useState(true);
  const [scrollGeometry, setScrollGeometry] = useState<ChatScrollGeometry>({
    contentHeight: 0,
    offset: 0,
    viewportHeight: 0,
  });
  const turns = state.transcript.turns;
  const latestTurnId = turns.at(-1)?.id ?? null;
  const list = useRef<FlashListRef<TranscriptTurn>>(null);
  const followEndRef = useRef(true);
  const latestTurnIdRef = useRef(latestTurnId);
  latestTurnIdRef.current = latestTurnId;
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
    measuredLatestTurnId: null,
    ready: false,
    viewableLatestTurnId: null,
    viewportLaidOut: false,
  });
  const initialViewportReadyCallbackRef = useRef(onInitialViewportReady);
  initialViewportReadyCallbackRef.current = onInitialViewportReady;
  const lastInitialViewportDiagnosticRef = useRef('');
  const agentName = agent === 'opencode' ? 'OpenCode' : 'Codex';
  const agentWorking = agentStatus === 'working';
  const contentPadding = insetContentPadding(contentInsets, {
    top: CHAT_CONTENT_TOP_GAP,
    bottom: CHAT_CONTENT_BOTTOM_GAP,
  });
  const maxOffset = Math.max(0, scrollGeometry.contentHeight - scrollGeometry.viewportHeight);
  const scrollThumb = scrollThumbGeometry(
    scrollGeometry.offset,
    maxOffset,
    scrollGeometry.viewportHeight,
  );

  const updateScrollGeometry = (next: ChatScrollGeometry) => {
    scrollGeometryRef.current = next;
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

  const nearEnd = (offset: number, maximumOffset: number) => (
    maximumOffset - offset < CHAT_FOLLOW_END_THRESHOLD
  );

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

  const initialViewportConditionsSatisfied = () => {
    const readiness = initialViewportRef.current;
    const currentLatestTurnId = latestTurnIdRef.current;
    return readiness.viewportLaidOut
      && readiness.contentSizeKnown
      && readiness.measuredLatestTurnId === currentLatestTurnId
      && readiness.atEnd
      && (
        currentLatestTurnId === null
        || readiness.viewableLatestTurnId === currentLatestTurnId
      );
  };

  const recordInitialViewportReadiness = (source: string) => {
    const readiness = initialViewportRef.current;
    const currentLatestTurnId = latestTurnIdRef.current;
    const geometry = scrollGeometryRef.current;
    const details = {
      atEnd: readiness.atEnd,
      conditionsSatisfied: initialViewportConditionsSatisfied(),
      contentHeight: Math.round(geometry.contentHeight),
      contentSizeKnown: readiness.contentSizeKnown,
      itemsLoaded: readiness.itemsLoaded,
      latestTurnId: currentLatestTurnId,
      measuredLatestTurnMatches:
        readiness.measuredLatestTurnId === currentLatestTurnId,
      ready: readiness.ready,
      source,
      viewableLatestTurnMatches:
        currentLatestTurnId === null ||
        readiness.viewableLatestTurnId === currentLatestTurnId,
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
    if (readiness.ready) return;
    recordInitialViewportReadiness(source);
    if (!initialViewportConditionsSatisfied()) return;
    readiness.ready = true;
    recordInitialViewportReadiness('ready');
    recordAgentChatDiagnostic('viewport-ready', {
      latestTurnId: latestTurnIdRef.current,
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
      viewportHeight > 0 &&
      maximumOffset - offset <= CHAT_INITIAL_END_THRESHOLD;
    scheduleInitialViewportReady('scroll-extent');
  };

  const updateScrollExtent = ({
    contentHeight,
    viewportHeight,
  }: Pick<ChatScrollGeometry, 'contentHeight' | 'viewportHeight'>) => {
    const current = scrollGeometryRef.current;
    const nextMaxOffset = Math.max(0, contentHeight - viewportHeight);
    const boundedOffset = Math.min(current.offset, nextMaxOffset);
    updateScrollGeometry({
      contentHeight,
      offset: boundedOffset,
      viewportHeight,
    });
    const interaction = scrollInteractionRef.current;
    if (interaction.kind !== ChatScrollInteractionKind.Idle) {
      scrollInteractionRef.current = {
        ...interaction,
        lastOffset: boundedOffset,
      };
    }
    updateInitialEndPosition(boundedOffset, contentHeight, viewportHeight);
  };

  const alignLoadedInitialViewportToEnd = () => {
    const readiness = initialViewportRef.current;
    const geometry = scrollGeometryRef.current;
    const maximumOffset = Math.max(
      0,
      geometry.contentHeight - geometry.viewportHeight,
    );
    if (
      readiness.ready ||
      !readiness.itemsLoaded ||
      !readiness.contentSizeKnown ||
      geometry.viewportHeight <= 0 ||
      maximumOffset <= CHAT_INITIAL_END_THRESHOLD ||
      readiness.atEnd
    )
      return;
    scrollInteractionRef.current = {
      kind: ChatScrollInteractionKind.Idle,
      lastOffset: maximumOffset,
    };
    updateScrollGeometry({ ...geometry, offset: maximumOffset });
    readiness.atEnd = true;
    list.current?.scrollToOffset({ offset: maximumOffset, animated: false });
    scheduleInitialViewportReady('initial-end-alignment');
  };

  useEffect(() => {
    recordAgentChatDiagnostic('viewport-props-changed', {
      agent,
      latestTurnId,
      sessionId: state.sessionId,
      state: state.status,
      stateRevision: state.revision,
      turnCount: turns.length,
    });
  }, [
    agent,
    latestTurnId,
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
    updateInitialEndPosition(
      offset,
      contentSize.height,
      layoutMeasurement.height,
    );
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
  };
  const beginMomentumScroll = () => {
    const interaction = scrollInteractionRef.current;
    if (interaction.kind !== ChatScrollInteractionKind.AwaitingMomentum) return;
    scrollInteractionRef.current = { ...interaction, kind: ChatScrollInteractionKind.UserMomentum };
  };
  const endMomentumScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    trackScroll(event);
    scrollInteractionRef.current = {
      kind: ChatScrollInteractionKind.Idle,
      lastOffset: scrollGeometryRef.current.offset,
    };
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
  const trackViewableTurns = ({
    viewableItems,
  }: {
    viewableItems: ViewToken<TranscriptTurn>[];
  }) => {
    const currentLatestTurnId = latestTurnIdRef.current;
    initialViewportRef.current.viewableLatestTurnId =
      currentLatestTurnId !== null &&
      viewableItems.some(
        token => token.isViewable && token.item.id === currentLatestTurnId,
      )
        ? currentLatestTurnId
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
      if (/^(?:https?:|mailto:|tel:)/i.test(url)) openExternalUrl(url);
    },
    [onOpenFile, state.transcript.info?.directory],
  );

  return (
    <View
      className={cn('flex-1', appGlassBackgroundClassName(appGlassEnabled))}
    >
      <View
        testID="agent-chat-viewport"
        className="relative flex-1"
        onLayout={event => {
          initialViewportRef.current.viewportLaidOut = true;
          const current = scrollGeometryRef.current;
          updateScrollExtent({
            contentHeight: current.contentHeight,
            viewportHeight: event.nativeEvent.layout.height,
          });
        }}
      >
        <FlashList
          ref={list}
          data={turns}
          keyExtractor={turn => turn.id}
          renderItem={({ item, index }) => (
            <View className={index === 0 ? '' : 'mt-7'}>
              <TranscriptTurnView
                turn={item}
                working={
                  index === turns.length - 1 &&
                  (agentWorking || item.status === 'working')
                }
                onLinkPress={openTranscriptLink}
              />
            </View>
          )}
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
              {state.status !== 'live' && (
                <View
                  className={cn(
                    'flex-row items-center gap-2 py-3',
                    turns.length > 0 && 'mb-4',
                  )}
                >
                  {state.status === 'loading' ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : (
                    <CircleAlert size={14} color={colors.textSecondary} />
                  )}
                  <Text
                    numberOfLines={2}
                    className="min-w-0 flex-1 text-[12px] text-muted-foreground"
                  >
                    {state.error ||
                      (state.status === 'loading'
                        ? `Reading the local ${agentName} history…`
                        : 'The transcript is temporarily unavailable.')}
                  </Text>
                </View>
              )}
            </>
          }
          ListFooterComponent={
            <ChatBoundarySpacer height={contentPadding.bottom} />
          }
          ListEmptyComponent={
            state.status === 'live' && agentWorking ? (
              <ThinkingIndicator />
            ) : state.status === 'live' ? (
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
            initialViewportRef.current.measuredLatestTurnId =
              latestTurnIdRef.current;
            const current = scrollGeometryRef.current;
            updateScrollExtent({
              contentHeight: height,
              viewportHeight: current.viewportHeight,
            });
            alignLoadedInitialViewportToEnd();
            if (
              contentSizeWasKnown &&
              height > current.contentHeight + CHAT_SCROLL_OFFSET_EPSILON &&
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
          }}
          onEndReached={() => {
            initialViewportRef.current.atEnd = true;
            scheduleInitialViewportReady('end-reached');
          }}
          onEndReachedThreshold={0}
          onLoad={() => {
            initialViewportRef.current.itemsLoaded = true;
            recordInitialViewportReadiness('items-loaded');
            alignLoadedInitialViewportToEnd();
          }}
          onScroll={trackScroll}
          onScrollBeginDrag={beginUserScroll}
          onScrollEndDrag={endUserScroll}
          onMomentumScrollBegin={beginMomentumScroll}
          onMomentumScrollEnd={endMomentumScroll}
          onViewableItemsChanged={trackViewableTurns}
          scrollEventThrottle={16}
        />
        {!followEnd && (
          <Button
            accessibilityLabel="Jump to latest"
            className={cn(
              'absolute right-4 h-8 flex-row gap-1.5 rounded-full px-3 shadow-lg',
              appGlassEnabled && 'border',
            )}
            style={[
              { bottom: latestButtonBottom },
              appGlassEnabled ? appGlassControlStyle(false, colors) : undefined,
            ]}
            variant={appGlassEnabled ? 'ghost' : 'secondary'}
            onPress={() => {
              setFollowEnd(true);
              scrollToLatest(true);
            }}
          >
            <ChevronDown size={15} color={colors.text} />
            <Text className="text-[10px] font-semibold">Latest</Text>
          </Button>
        )}
        {scrollThumb && (
          <OverlayScrollbar
            accessibilityLabel="Conversation scroll position"
            heightPercent={scrollThumb.heightPercent}
            insets={contentInsets}
            topPercent={scrollThumb.topPercent}
            onAccessibilityAdjust={adjustScrollbar}
            onDrag={dragScrollbar}
            onDragEnd={() => {
              scrollbarDragRef.current = null;
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
