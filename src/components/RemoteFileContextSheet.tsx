import Clipboard from '@react-native-clipboard/clipboard';
import { Check, ChevronLeft, Copy, Download, FileText, Folder, FolderInput, Info } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { RuntimeRemoteFileEntry } from 'react-native-whip-ssh';
import { formatRemoteFileSize, joinRemotePath, parentRemotePath, sortRemoteEntries } from '@/src/lib/remoteFiles';
import { REMOTE_FILE_GLASS_SURFACE_PROPS } from '@/src/lib/remoteFileGlass';
import type { HerdrClient } from '@/src/services/HerdrClient';
import { downloadRemoteEntry } from '@/src/services/remoteFileTransfer';
import { appGlassControlStyle, useTheme } from '@/src/theme';
import { hapticPress } from './app-ui';
import { GlassButton, GlassIconBadge } from './GlassControls';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { Input } from './ui/input';
import { Text } from './ui/text';

export function remoteFilenameSelection(entry: Pick<RuntimeRemoteFileEntry, 'name' | 'kind'>) {
  const dot = entry.name.lastIndexOf('.');
  return { start: 0, end: entry.kind === 'directory' || dot <= 0 ? entry.name.length : dot };
}

interface Props {
  entry: RuntimeRemoteFileEntry;
  client: HerdrClient;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}

type SheetPage = 'menu' | 'move' | 'properties';

export function RemoteFileContextSheet({ entry, client, onClose, onChanged, onBusyChange }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  const [name, setName] = useState(entry.name);
  const initialSelection = useRef(remoteFilenameSelection(entry)).current;
  const [selection, setSelection] = useState<typeof initialSelection | undefined>();
  const filenameEditingStarted = useRef(false);
  const [page, setPage] = useState<SheetPage>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pickerPath, setPickerPath] = useState(parentRemotePath(entry.path));
  const [directories, setDirectories] = useState<RuntimeRemoteFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [properties, setProperties] = useState(entry);
  const input = useRef<TextInput>(null);
  const downloadAbort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  const request = useRef(0);
  const [connection] = useState(() => {
    const native = client.native;
    return { native, generation: native.status().generation };
  });
  const current = () => alive.current && client.activeNative === connection.native
    && connection.native.status().generation === connection.generation && connection.native.status().state === 'connected';

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; downloadAbort.current?.abort(); };
  }, []);

  const run = async (action: () => Promise<void>) => {
    if (operation.current || !alive.current) return;
    operation.current = true;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    setFeedback(null);
    try {
      if (!current()) throw new Error(t('common.notConnected'));
      await action();
    } catch (reason) {
      if (alive.current) setError(String(reason));
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
      onBusyChange(false);
    }
  };

  const rename = () => run(async () => {
    if (name === entry.name) { onClose(); return; }
    if (!name.trim() || name === '.' || name === '..' || Array.from(name).some(char => char === '/' || char === '\\' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      throw new Error(t('files.invalidName'));
    }
    await connection.native.renameRemotePath(entry.path, joinRemotePath(parentRemotePath(entry.path), name));
    if (current()) { await onChanged(); onClose(); }
  });

  const invalidDestination = (path: string) => entry.kind === 'directory'
    && (path === entry.path || path.startsWith(`${entry.path}/`));

  const browse = async (path: string) => {
    const id = ++request.current;
    setPickerPath(path);
    setError(null);
    setLoadedPath(null);
    setLoading(true);
    const cached = connection.native.cachedDirectory(path);
    setDirectories(cached?.entries.filter(item => item.kind === 'directory') ?? []);
    try {
      const listing = await connection.native.listDirectory(path);
      if (id !== request.current || !current()) return;
      setPickerPath(listing.path);
      setLoadedPath(listing.path);
      setDirectories(sortRemoteEntries(listing.entries.filter(item => item.kind === 'directory')));
    } catch (reason) {
      if (id === request.current && alive.current) setError(String(reason));
    } finally {
      if (id === request.current && alive.current) setLoading(false);
    }
  };

  const changePage = (next: SheetPage) => {
    Keyboard.dismiss();
    setPage(next);
    setError(null);
    setFeedback(null);
    if (next === 'move') void browse(parentRemotePath(entry.path));
  };

  const move = () => run(async () => {
    if (invalidDestination(pickerPath)) throw new Error(t('files.invalidMove'));
    const destination = joinRemotePath(pickerPath, entry.name);
    if (destination !== entry.path) await connection.native.renameRemotePath(entry.path, destination);
    if (current()) { await onChanged(); onClose(); }
  });

  const actions = [
    { label: 'files.moveTo', icon: FolderInput, action: () => changePage('move') },
    { label: 'files.copyPath', icon: Copy, action: () => {
      Keyboard.dismiss(); Clipboard.setString(entry.path); setFeedback(t('files.pathCopied'));
    } },
    { label: 'files.download', icon: Download, action: () => run(async () => {
      Keyboard.dismiss();
      const abort = new AbortController();
      downloadAbort.current = abort;
      try {
        const downloaded = await downloadRemoteEntry({ native: connection.native }, entry.path, bytes => {
          if (alive.current) setFeedback(t('files.downloadProgress', { size: formatRemoteFileSize(bytes) }));
        }, abort.signal);
        if (alive.current) setFeedback(t(downloaded ? 'files.downloadedTitle' : 'common.cancel'));
      } finally { downloadAbort.current = null; }
    }) },
    { label: 'files.properties', icon: Info, action: () => {
      changePage('properties');
      // Listing metadata is immediately usable; STAT adds no recursive work.
      if (entry.kind !== 'symlink') void run(async () => {
        const value = await connection.native.statRemotePath(entry.path);
        if (current()) setProperties(value);
      });
    } },
  ];
  const details = [
    ['files.filename', properties.name], ['files.absolutePath', entry.path],
    ['files.entryType', t(`files.type.${properties.kind}`)],
    ['files.size', formatRemoteFileSize(properties.size ?? -1)],
    ['files.modified', properties.modifiedAt == null ? '—' : new Date(properties.modifiedAt * 1000).toLocaleString()],
    ['files.permissions', properties.permissions == null ? '—' : (properties.permissions % 0o10000).toString(8).padStart(4, '0')],
  ];

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="absolute inset-0 items-center justify-center px-5">
      <Pressable
        accessibilityLabel={t('common.cancel')}
        className="absolute inset-0 bg-black/55"
        disabled={busy}
        onPress={onClose}
      />
      <GlassSurface
        {...REMOTE_FILE_GLASS_SURFACE_PROPS}
        accessibilityViewIsModal
        className="w-full max-h-[85%] max-w-[380px] rounded-[24px] border border-white/30 p-5 dark:border-white/10">
        {page === 'menu' ? (
          <>
            <View className="mb-5 flex-row items-center gap-2">
              <GlassIconBadge>
                {entry.kind === 'directory'
                  ? <Folder size={20} color={colors.primary} />
                  : <FileText size={20} color={colors.primary} />}
              </GlassIconBadge>
              <Input
                ref={input}
                accessibilityLabel={t('files.filename')}
                autoFocus={false}
                autoCapitalize="none"
                autoCorrect={false}
                className="h-12 min-w-0 flex-1 rounded-xl border-border bg-transparent text-[17px] font-semibold"
                style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
                editable={!busy}
                value={name}
                selection={selection}
                onFocus={() => {
                  if (filenameEditingStarted.current) return;
                  filenameEditingStarted.current = true;
                  setSelection(initialSelection);
                  input.current?.setNativeProps({ selection: initialSelection });
                }}
                onSelectionChange={() => setSelection(undefined)}
                onChangeText={setName}
                returnKeyType="done"
                onSubmitEditing={() => { void rename(); }}
              />
              <GlassButton
                accessibilityLabel={t('files.commitRename')}
                className="size-11 rounded-full px-0"
                disabled={busy}
                onPress={hapticPress(rename)}>
                <Check size={20} color={appGlassEnabled ? colors.primary : colors.onPrimary} />
              </GlassButton>
            </View>
            <ScrollView keyboardShouldPersistTaps="handled" bounces={false}>
              <View className="gap-2">
                {actions.map(({ label, icon: ActionIcon, action }) => (
                  <GlassButton
                    key={label}
                    accessibilityLabel={t(label)}
                    className="h-14 justify-start gap-3 rounded-xl px-3"
                    variant="ghost"
                    disabled={busy}
                    onPress={hapticPress(action)}>
                    <ActionIcon size={19} color={colors.text} />
                    <Text className="text-[15px] font-medium">{t(label)}</Text>
                  </GlassButton>
                ))}
              </View>
            </ScrollView>
          </>
        ) : (
          <>
            <View className="mb-4 flex-row items-center gap-3 px-1">
              <GlassButton
                accessibilityLabel={t('files.contextBack')}
                className="size-10 rounded-full px-0"
                variant="ghost"
                disabled={busy}
                onPress={hapticPress(() => {
                  request.current++;
                  setLoading(false);
                  setError(null);
                  setFeedback(null);
                  setPage('menu');
                })}>
                <ChevronLeft color={colors.text} size={20} />
              </GlassButton>
              <View className="min-w-0 flex-1">
                <Text className="text-[19px] font-bold leading-6">
                  {t(page === 'move' ? 'files.moveTo' : 'files.properties')}
                </Text>
                <Text numberOfLines={1} className="mt-1 text-[13px] text-muted-foreground">
                  {entry.name}
                </Text>
              </View>
            </View>
            {page === 'move' ? (
              <>
                <View className="flex-row items-center gap-2 rounded-xl border border-border bg-muted/40 px-2 py-1">
                  <GlassButton
                    accessibilityLabel={t('files.moveParent')}
                    className="size-10 rounded-full px-0"
                    disabled={pickerPath === '/' || busy}
                    variant="ghost"
                    onPress={hapticPress(() => browse(parentRemotePath(pickerPath)))}>
                    <ChevronLeft color={colors.text} size={20} />
                  </GlassButton>
                  <Text className="min-w-0 flex-1 font-mono text-xs" numberOfLines={2}>
                    {pickerPath}
                  </Text>
                  {loading ? <ActivityIndicator accessibilityLabel={t('files.loading')} color={colors.primary} /> : null}
                </View>
                <FlatList
                  className="mt-3"
                  style={{ maxHeight: 260 }}
                  data={directories}
                  keyboardShouldPersistTaps="handled"
                  keyExtractor={item => item.path}
                  renderItem={({ item }) => (
                    <GlassButton
                      accessibilityLabel={t('files.moveOpenDirectory', { name: item.name })}
                      className="mb-2 h-14 justify-start gap-3 rounded-xl px-3"
                      variant="ghost"
                      disabled={busy || invalidDestination(item.path)}
                      onPress={hapticPress(() => browse(item.path))}>
                      <Folder size={19} color={colors.primary} />
                      <Text className="text-[15px] font-medium">{item.name}</Text>
                    </GlassButton>
                  )}
                />
                {error && !loading ? (
                  <GlassButton
                    accessibilityLabel={t('files.retry')}
                    variant="ghost"
                    className="mt-2 rounded-full"
                    onPress={hapticPress(() => browse(pickerPath))}
                    disabled={busy}>
                    <Text>{t('files.retry')}</Text>
                  </GlassButton>
                ) : null}
                <GlassButton
                  accessibilityLabel={t('files.moveHere')}
                  className="mt-4 h-12 rounded-full"
                  disabled={busy || loading || loadedPath !== pickerPath || invalidDestination(pickerPath) || pickerPath === parentRemotePath(entry.path)}
                  onPress={hapticPress(move)}>
                  <Text>{t('files.moveHere')}</Text>
                </GlassButton>
              </>
            ) : (
              <ScrollView>
                <View className="overflow-hidden rounded-xl border border-border bg-muted/40">
                  {details.map(([label, value], index) => (
                    <View key={label} className={index === 0 ? 'px-3.5 py-3' : 'border-t border-border px-3.5 py-3'}>
                      <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {t(label)}
                      </Text>
                      <Text selectable className="mt-1 font-mono text-[12px] leading-5">
                        {value}
                      </Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            )}
          </>
        )}
        {busy ? <ActivityIndicator className="mt-3" color={colors.primary} /> : null}
        {error ? <Text accessibilityRole="alert" className="mt-3 px-2 text-[13px] text-destructive">{error}</Text> : null}
        {feedback ? <Text accessibilityLiveRegion="polite" className="mt-3 px-2 text-[13px] text-muted-foreground">{feedback}</Text> : null}
        <GlassButton
          accessibilityLabel={t('common.cancel')}
          className="mt-3 h-12 rounded-full"
          variant="secondary"
          disabled={busy && !downloadAbort.current}
          onPress={hapticPress(() => {
            if (busy) downloadAbort.current?.abort();
            else onClose();
          })}>
          <Text>{t('common.cancel')}</Text>
        </GlassButton>
      </GlassSurface>
    </KeyboardAvoidingView>
  );
}
