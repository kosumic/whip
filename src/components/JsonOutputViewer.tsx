import { memo, useContext, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import type { JsonValue } from '../lib/toolOutput';
import { useTheme } from '../theme';
import { ChatSearchQuery, SearchCodeScope, SearchCodeToken, searchTextRanges } from './SearchText';
import { Text } from './ui/text';

const JSON_CHILD_PAGE_SIZE = 50;
const JSON_INDENT = 14;
const JSON_ROW_CLASS_NAME = 'font-mono text-[11px] leading-[17px] text-foreground';

function JsonRow({ label, content, color }: { label?: string; content: string; color?: string }) {
  const { colors } = useTheme();
  const prefix = label === undefined ? '' : `${label}: `;
  const row = prefix + content;
  return (
    <Text selectable className={JSON_ROW_CLASS_NAME}>
      <SearchCodeScope text={row}>
        <Text style={{ color: colors.link }}><SearchCodeToken text={prefix} start={0} row={row} /></Text>
        <Text style={{ color }}><SearchCodeToken text={content} start={prefix.length} row={row} /></Text>
      </SearchCodeScope>
    </Text>
  );
}

function JsonNode({ value, label, root = false }: { value: JsonValue; label?: string; root?: boolean }) {
  const { colors } = useTheme();
  const query = useContext(ChatSearchQuery);
  const [open, setOpen] = useState(root);
  const [limit, setLimit] = useState(JSON_CHILD_PAGE_SIZE);
  const container = value !== null && typeof value === 'object';
  const array = Array.isArray(value);
  const entries = useMemo(() => {
    if (!container) return [];
    return array ? value.map((child, index) => [String(index), child] as const) : Object.entries(value);
  }, [array, container, value]);
  const matchingEntries = useMemo(() => query ? entries.filter(([key, child]) => (
    searchTextRanges(`${array ? key : JSON.stringify(key)}: ${JSON.stringify(child, null, 2)}`, query).length > 0
  )) : entries, [array, entries, query]);
  if (!container) {
    const color = typeof value === 'string' ? colors.done
      : typeof value === 'number' ? colors.warning
        : value === null ? colors.textTertiary : colors.primary;
    return <View className="py-0.5 pl-5"><JsonRow label={label} content={JSON.stringify(value)} color={color} /></View>;
  }
  const expanded = open || Boolean(query);
  const opening = array ? '[' : '{';
  const closing = array ? ']' : '}';
  const entryType = array ? 'items' : 'keys';
  const summary = entries.length === 0 ? opening + closing
    : `${opening}…${closing} · ${entries.length} ${entryType}`;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label ?? 'JSON'}: ${entries.length} ${entryType}`}
        accessibilityState={{ expanded }}
        disabled={entries.length === 0 || Boolean(query)}
        className="min-h-8 flex-row items-center gap-1"
        hitSlop={{ top: 6, bottom: 6 }}
        onPress={() => setOpen(previous => !previous)}
      >
        {expanded ? <ChevronDown size={14} color={colors.textTertiary} /> : <ChevronRight size={14} color={colors.textTertiary} />}
        <JsonRow label={label} content={expanded && entries.length ? opening : summary} />
      </Pressable>
      {expanded && entries.length > 0 && (
        <View style={{ paddingLeft: JSON_INDENT }}>
          {matchingEntries.slice(0, limit).map(([key, child]) => (
            <JsonNode key={key} label={array ? key : JSON.stringify(key)} value={child} />
          ))}
          {matchingEntries.length > limit && (
            <Pressable accessibilityRole="button" accessibilityLabel="Show more JSON entries" className="min-h-8 justify-center pl-5" onPress={() => setLimit(previous => previous + JSON_CHILD_PAGE_SIZE)}>
              <Text className={JSON_ROW_CLASS_NAME} style={{ color: colors.link }}>Show more ({matchingEntries.length - limit} remaining)</Text>
            </Pressable>
          )}
          <Text className={JSON_ROW_CLASS_NAME}>{closing}</Text>
        </View>
      )}
    </View>
  );
}

/** Child branches mount on expansion; large collections reveal one page at a time. */
export const JsonOutputViewer = memo(function MemoizedJsonOutputViewer({ value }: { value: JsonValue }) {
  return <JsonNode value={value} root />;
});
