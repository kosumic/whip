import { memo, useContext, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import { isSmallJsonToolOutput, type JsonValue } from '../lib/toolOutput';
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

function JsonNode({ value, label, initiallyOpen = false, expandChildren = false }: {
  value: JsonValue;
  label?: string;
  initiallyOpen?: boolean;
  expandChildren?: boolean;
}) {
  const { colors } = useTheme();
  const query = useContext(ChatSearchQuery);
  const array = Array.isArray(value);
  const singleItem = array && value.length === 1;
  const [open, setOpen] = useState(initiallyOpen || singleItem || expandChildren);
  const [limit, setLimit] = useState(JSON_CHILD_PAGE_SIZE);
  const container = value !== null && typeof value === 'object';
  const entries = useMemo(() => {
    if (!container) return [];
    if (array) return value.map((child, index) => ({ key: index, label: singleItem ? undefined : String(index), child }));
    return Object.entries(value).map(([key, child]) => ({ key, label: JSON.stringify(key), child }));
  }, [array, container, singleItem, value]);
  const matchingEntries = useMemo(() => query ? entries.filter(entry => {
    const prefix = entry.label === undefined ? '' : `${entry.label}: `;
    return searchTextRanges(prefix + JSON.stringify(entry.child, null, 2), query).length > 0;
  }) : entries, [entries, query]);
  if (!container) {
    const color = typeof value === 'string' ? colors.done
      : typeof value === 'number' ? colors.warning
        : value === null ? colors.textTertiary : colors.primary;
    return <View className="py-0.5 pl-5"><JsonRow label={label} content={JSON.stringify(value)} color={color} /></View>;
  }
  const expanded = open || Boolean(query);
  const opening = array ? '[' : '{';
  const closing = array ? ']' : '}';
  if (!entries.length) {
    return <View className="py-0.5 pl-5"><JsonRow label={label} content={opening + closing} /></View>;
  }
  const entryType = array ? 'item' : 'key';
  const count = `${entries.length} ${entryType}${entries.length === 1 ? '' : 's'}`;
  const summary = `${opening}…${closing} · ${count}`;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label ?? 'JSON'}: ${count}`}
        accessibilityState={{ expanded }}
        disabled={Boolean(query)}
        className="min-h-8 flex-row items-center gap-1"
        hitSlop={{ top: 6, bottom: 6 }}
        onPress={() => setOpen(previous => !previous)}
      >
        {expanded ? <ChevronDown size={14} color={colors.textTertiary} /> : <ChevronRight size={14} color={colors.textTertiary} />}
        <JsonRow label={label} content={expanded ? opening : summary} />
      </Pressable>
      {expanded && (
        <View style={{ paddingLeft: JSON_INDENT }}>
          {matchingEntries.slice(0, limit).map(entry => (
            <JsonNode key={entry.key} label={entry.label} value={entry.child} initiallyOpen={singleItem} expandChildren={expandChildren} />
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

/** Small results open fully; larger results mount branches and pages on demand. */
export const JsonOutputViewer = memo(function MemoizedJsonOutputViewer({ value }: { value: JsonValue }) {
  const expandChildren = useMemo(() => isSmallJsonToolOutput(value), [value]);
  return <JsonNode value={value} initiallyOpen expandChildren={expandChildren} />;
});
