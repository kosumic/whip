import { useRef, useState } from 'react';
import { ScrollView, View, type TextInputInstance } from 'react-native';
import { Bold, Code, Italic, Link2, List, ListTodo, Quote, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { formatGithubComment, type RuntimeGithubCommentFormat } from 'react-native-whip-ssh';
import { cn } from '../lib/utils';
import { useTheme } from '../theme';
import { MarkdownText } from './MarkdownText';
import { hapticPress } from './app-ui';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Text } from './ui/text';

const MAX_COMMENT_LENGTH = 65_536;
const FORMATS: readonly { id: RuntimeGithubCommentFormat; icon: LucideIcon }[] = [
  { id: 'bold', icon: Bold }, { id: 'italic', icon: Italic }, { id: 'code', icon: Code },
  { id: 'quote', icon: Quote }, { id: 'bulletList', icon: List }, { id: 'taskList', icon: ListTodo }, { id: 'link', icon: Link2 },
];

export function GithubMarkdownEditor({ value, onChange, disabled, onOpenLink }: {
  value: string; onChange: (value: string) => void; disabled: boolean; onOpenLink: (url: string) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [preview, setPreview] = useState(false);
  const [selection, setSelection] = useState(() => ({ start: value.length, end: value.length }));
  const input = useRef<TextInputInstance>(null);
  const format = (kind: RuntimeGithubCommentFormat) => {
    const edit = formatGithubComment(value, selection, kind);
    onChange(edit.text);
    setSelection(edit.selection);
    input.current?.focus();
  };
  return (
    <View className="overflow-hidden rounded-lg border border-border">
      <View className="flex-row border-b border-border bg-muted/40">
        {(['write', 'preview'] as const).map(mode => (
          <Button key={mode} accessibilityLabel={t(`github.${mode}`)} accessibilityRole="tab"
            accessibilityState={{ selected: preview === (mode === 'preview') }}
            className={cn('h-11 rounded-none border-b-2 border-transparent px-4', preview === (mode === 'preview') && 'border-primary bg-background')}
            disabled={disabled} variant="ghost" onPress={() => setPreview(mode === 'preview')}>
            <Text className="text-xs">{t(`github.${mode}`)}</Text>
          </Button>
        ))}
      </View>
      {preview ? (
        <View className="min-h-[160px] p-3">
          {value.trim() ? <MarkdownText content={value} onLinkPress={({ url }) => onOpenLink(url)} /> : <Text className="text-sm text-muted-foreground">{t('github.nothingPreview')}</Text>}
        </View>
      ) : <>
        <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} className="border-b border-border">
          {FORMATS.map(({ id, icon: Icon }) => (
            <Button key={id} accessibilityLabel={t(`github.format.${id}`)} className="size-11 rounded-none px-0" disabled={disabled} variant="ghost" onPress={hapticPress(() => format(id))}>
              <Icon size={17} color={colors.textSecondary} />
            </Button>
          ))}
        </ScrollView>
        <Input ref={input} accessibilityLabel={t('github.replyPlaceholder')}
          className="h-auto min-h-[160px] rounded-none border-0 bg-transparent font-mono text-sm leading-6"
          editable={!disabled} maxLength={MAX_COMMENT_LENGTH} multiline placeholder={t('github.replyPlaceholder')}
          selection={{ start: Math.min(selection.start, value.length), end: Math.min(selection.end, value.length) }}
          textAlignVertical="top" value={value} onChangeText={onChange} onSelectionChange={event => setSelection(event.nativeEvent.selection)} />
      </>}
      <View className="border-t border-border px-3 py-2"><Text className="text-[10px] text-muted-foreground">{t('github.markdownSupported')}</Text></View>
    </View>
  );
}
