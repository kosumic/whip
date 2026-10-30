import { Image, View } from 'react-native';
import { Text } from './ui/text';

export function GithubAuthorRow({ name, avatarUrl, date }: { name: string; avatarUrl?: string; date?: string }) {
  const timestamp = date ? new Date(date) : null;
  return <View className="flex-row items-center gap-3">
    {avatarUrl?.startsWith('https://') ? <Image source={{ uri: avatarUrl }} className="size-9 rounded-full" accessibilityLabel={name} />
      : <View className="size-9 items-center justify-center rounded-full bg-muted"><Text className="text-sm font-semibold">{name.slice(0, 1).toUpperCase()}</Text></View>}
    <Text className="min-w-0 shrink text-sm font-semibold" numberOfLines={1}>{name}</Text>
    {timestamp && !Number.isNaN(timestamp.getTime()) ? <Text className="text-xs text-muted-foreground">· {timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</Text> : null}
  </View>;
}
