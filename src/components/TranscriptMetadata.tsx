import { View } from 'react-native';
import { Text } from './ui/text';

export function formatElapsed(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  if (seconds < 10) return `${Number(seconds.toFixed(2))}s`;
  const rounded = Math.round(seconds);
  return rounded < 60 ? `${rounded}s` : `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

export function formatFullTime(value: number): string {
  return new Date(value).toLocaleString();
}

export function MetadataLine({ label, value }: { label: string; value?: string | number }) {
  if (value === undefined) return null;
  return <View className="flex-row gap-3"><Text className="w-24 text-[11px] text-muted-foreground">{label}</Text><Text selectable className="min-w-0 flex-1 text-[11px] text-foreground">{value}</Text></View>;
}
