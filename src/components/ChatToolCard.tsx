import { memo, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import Check from 'lucide-react-native/icons/check';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import Copy from 'lucide-react-native/icons/copy';
import ExternalLink from 'lucide-react-native/icons/external-link';
import File from 'lucide-react-native/icons/file';
import FileDiff from 'lucide-react-native/icons/file-diff';
import FilePlus from 'lucide-react-native/icons/file-plus';
import Link from 'lucide-react-native/icons/link';
import Search from 'lucide-react-native/icons/search';
import SquareTerminal from 'lucide-react-native/icons/square-terminal';
import type { LucideIcon } from 'lucide-react-native';
import type { TranscriptToolPart } from '../agentChat';
import { useCopyFeedback } from '../hooks/useCopyFeedback';
import { isRunningTool as isRunning } from '../lib/agentChatBlocks';
import { parseJsonToolOutput, textValue } from '../lib/toolOutput';
import { cn } from '../lib/utils';
import { hapticPress } from '../services/interactionFeedback';
import { useTheme } from '../theme';
import { ChatFileDiff as ToolFileDiffBlock } from './ChatFileDiff';
import { JsonOutputViewer } from './JsonOutputViewer';
import { MarkdownText } from './MarkdownText';
import { NativeCodeBlock } from './NativeCodeBlock';
import { SearchText } from './SearchText';
import { formatElapsed, formatFullTime, MetadataLine } from './TranscriptMetadata';
import { Text } from './ui/text';

const SMALL_ICON_HIT_SLOP = 8;
const TOOL_HEADER_PREVIEW_LENGTH = 160;
const LEADING_EXECUTABLE_PATH = /^[^\s"'`\\|;&<>()=$]*\/([^/\s"'`\\|;&<>()=$]+)(?=\s|[|;&<>()]|$)/;

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

export function toolPresentation(item: TranscriptToolPart): ToolPresentation {
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

export function ChatToolCard({ item, expanded, onToggle, active, onLinkPress, directory }: BlockExpansion & { item: TranscriptToolPart; active: boolean; onLinkPress: (url: string) => void; directory?: string }) {
  const { colors } = useTheme();
  const failed = item.state.status === 'error';
  const presentation = toolPresentation(item);
  const name = item.tool.toLowerCase();
  const files = item.state.files;
  // Keep tool file diffs collapsed until the user selects a file.
  // This state belongs to the tool card so closing and reopening the card
  // does not discard previously selected diffs.
  const [expandedFiles, setExpandedFiles] = useState<ReadonlySet<string>>(() => new Set());
  const toggleFile = (path: string) => {
    setExpandedFiles(current => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  };
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
  // Shorten only the collapsed display; details and copy keep the original command.
  const headerSubtitle = !expanded && presentation.kind === 'command'
    ? subtitle?.replace(LEADING_EXECUTABLE_PATH, '$1')
    : subtitle;
  const displayedSubtitle = headerSubtitle ? toolHeaderPreview(headerSubtitle) : undefined;
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
          {files.map(file => <ToolFileDiffBlock key={file.file} file={file} directory={directory} expanded={expandedFiles.has(file.file)} onToggle={() => toggleFile(file.file)} />)}
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
export const ToolOutputBlock = memo(function MemoizedToolOutput({
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

export function ToolInputDetails({ item }: { item: TranscriptToolPart }) {
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

export function ToolMetadata({ item }: { item: TranscriptToolPart }) {
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
