import { useState } from 'react';
import { FlatList, Modal, Pressable, View } from 'react-native';
import { Check, ChevronRight, Trash2 } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { formatRemoteFileSize } from '../lib/remoteFiles';
import { hapticPress } from '../services/interactionFeedback';
import type { SpeechVoice } from '../services/speechPlayback';
import { GlassButton } from './GlassControls';
import { GlassSurface } from './GlassSurface';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Text } from './ui/text';

interface Props {
  title: string;
  selected: string;
  voices: SpeechVoice[];
  disabled?: boolean;
  loading?: boolean;
  error?: string;
  onOpen?: () => void;
  onSelect: (id: string) => void;
  onRemove?: (id: string) => void;
}

export function SpeechVoicePicker({ title, selected, voices, disabled, loading, error, onOpen, onSelect, onRemove }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const current = voices.find(voice => voice.id === selected);
  const query = search.trim().toLocaleLowerCase();
  const filtered = voices.filter(voice => `${voice.name} ${voice.language} ${voice.description ?? ''}`.toLocaleLowerCase().includes(query));

  return <>
    <GlassButton variant="ghost" size="content" className="min-h-14 justify-start rounded-none px-3.5 py-3" disabled={disabled}
      accessibilityLabel={title} onPress={hapticPress(() => { setSearch(''); setOpen(true); onOpen?.(); })}>
      <View className="flex-1">
        <Text className="text-xs text-muted-foreground">{title}</Text>
        <Text className="mt-1 text-sm font-medium">{current?.name ?? t(loading ? 'speech.voicesLoading' : 'speech.voiceUnavailable')}</Text>
      </View>
      <Icon as={ChevronRight} className="text-muted-foreground" size={18} />
    </GlassButton>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View className="flex-1 justify-center bg-black/50 px-5">
        <Pressable className="absolute inset-0" accessibilityLabel={t('common.cancel')} onPress={() => setOpen(false)} />
        <GlassSurface className="h-[80%] overflow-hidden rounded-2xl border border-border bg-background">
          <View className="flex-row items-center justify-between px-4 pt-3">
            <Text accessibilityRole="header" className="text-lg font-semibold">{title}</Text>
            <GlassButton variant="ghost" onPress={() => setOpen(false)}><Text>{t('common.cancel')}</Text></GlassButton>
          </View>
          <View className="px-4 pb-3">
            <Input value={search} onChangeText={setSearch} placeholder={t('speech.searchVoices')}
              accessibilityLabel={t('speech.searchVoices')} autoCorrect={false} autoCapitalize="none" />
          </View>
          {loading ? <Text className="px-4 pb-3 text-sm text-muted-foreground">{t('speech.voicesLoading')}</Text> : null}
          {error ? <Text accessibilityLiveRegion="polite" className="px-4 pb-3 text-sm text-destructive">{error}</Text> : null}
          <FlatList data={filtered} keyExtractor={voice => voice.id} keyboardShouldPersistTaps="handled"
            renderItem={({ item: voice }) => <View className="flex-row items-center border-t border-border">
              <GlassButton variant={voice.id === selected ? 'secondary' : 'ghost'} size="content"
                accessibilityRole="radio" accessibilityState={{ selected: voice.id === selected }} disabled={disabled}
                className="min-h-16 flex-1 justify-start rounded-none px-4 py-3"
                onPress={hapticPress(() => { setOpen(false); onSelect(voice.id); })}>
                <View className="flex-1 gap-1">
                  <Text className="text-sm font-medium">{voice.name}</Text>
                  {voice.language ? <Text className="text-xs text-muted-foreground">{voice.language}</Text> : null}
                  {voice.description ? <Text className="text-xs text-muted-foreground" numberOfLines={2}>{voice.description}</Text> : null}
                  {voice.bytes && !voice.installed ? <Text className="text-xs text-primary">{t('speech.downloadVoice', { size: formatRemoteFileSize(voice.bytes) })}</Text> : null}
                  {voice.bytes && voice.installed ? <Text className="text-xs text-muted-foreground">{t('speech.installed', { size: formatRemoteFileSize(voice.bytes) })}</Text> : null}
                  {voice.networkRequired ? <Text className="text-xs text-muted-foreground">{t('speech.networkVoice')}</Text> : null}
                </View>
                {voice.id === selected ? <Icon as={Check} size={18} className="text-primary" /> : null}
              </GlassButton>
              {onRemove && voice.installed && voice.bytes ? <GlassButton variant="ghost" disabled={disabled}
                accessibilityLabel={t('speech.removeVoice', { name: voice.name })} className="mr-1 px-3"
                onPress={hapticPress(() => onRemove(voice.id))}><Icon as={Trash2} size={18} className="text-muted-foreground" /></GlassButton> : null}
            </View>} />
        </GlassSurface>
      </View>
    </Modal>
  </>;
}
