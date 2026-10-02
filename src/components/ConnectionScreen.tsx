import { ArrowRight, Check, ChevronDown, ChevronLeft, ClipboardPaste, FileUp, KeyRound, Network, Sparkles, Trash2, X } from 'lucide-react-native';
import { generateKeyPair, getKeyDetails } from 'react-native-whip-ssh';
import { useEffect, useRef, useState } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import { Alert, Keyboard, KeyboardAvoidingView, Modal, NativeModules, Platform, Pressable, ScrollView, TextInput, ToastAndroid, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useKeyboardInset } from '@/src/hooks/useKeyboardInset';
import { errorCode, privateKeyErrorTranslationKey } from '@/src/lib/connectionErrors';
import { hostDisplayName, jumpHostCandidates } from '@/src/lib/hostProfiles';
import { normalizePrivateKey } from '@/src/lib/privateKey';
import {
  credentialDraftsForProfile,
  switchCredentialAuthMode,
  updateActiveCredential,
} from '@/src/lib/connectionCredentialDrafts';
import { cn } from '@/src/lib/utils';
import { appGlassControlStyle, useTheme } from '@/src/theme';
import type { ConnectionProfile, GlobalSshKeyMaterial, HostProfile } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader, WhipMark } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Text } from './ui/text';
import { SshKeyCopySheet } from './SshKeyCopySheet';

interface Props {
  initialProfile: ConnectionProfile;
  hosts: HostProfile[];
  connecting: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (profile: ConnectionProfile) => void;
  onConnect: (profile: ConnectionProfile) => void;
  onDelete?: () => void;
  onAuthenticatePrivateKey?: () => Promise<boolean>;
  onLoadGlobalKeys?: () => Promise<GlobalSshKeyMaterial[] | null>;
}

type KeyInspection =
  | { state: 'idle' | 'loading' }
  | { state: 'valid'; fingerprint: string; keyType: string; publicKey: string }
  | { state: 'passphrase-required' }
  | { state: 'invalid'; message: string };

type PrivateKeyFilePickerModule = {
  pickPrivateKey(): Promise<string | null>;
};

const privateKeyFilePicker = NativeModules.PrivateKeyFilePicker as PrivateKeyFilePickerModule | undefined;
const FOCUSED_FIELD_SPACING = 16;

export function ConnectionScreen({ initialProfile, hosts, connecting, error, onCancel, onSave, onConnect, onDelete, onAuthenticatePrivateKey, onLoadGlobalKeys }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { top: keyboardVerticalOffset } = useSafeAreaInsets();
  const keyboardViewportRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const scrollOffset = useRef(0);
  const { inset: keyboardInset } = useKeyboardInset(keyboardViewportRef, {
    enabled: Platform.OS === 'android',
  });
  const appGlassEnabled = useAppGlassEnabled();
  const [profile, setProfile] = useState(initialProfile);
  const [credentialDrafts, setCredentialDrafts] = useState(() => (
    credentialDraftsForProfile(initialProfile)
  ));
  const [keyInspection, setKeyInspection] = useState<KeyInspection>({ state: 'idle' });
  const [keyActionsOpen, setKeyActionsOpen] = useState(false);
  const [globalKeys, setGlobalKeys] = useState<GlobalSshKeyMaterial[] | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [jumpHostPickerOpen, setJumpHostPickerOpen] = useState(false);

  const revealFocusedField = () => {
    const keyboard = Keyboard.metrics();
    const input = TextInput.State.currentlyFocusedInput();
    if (!keyboard || !input) return;

    scrollRef.current?.getNativeScrollRef()?.measureInWindow((_x, viewportTop, _width, viewportHeight) => {
      input.measureInWindow((_inputX, inputTop, _inputWidth, inputHeight) => {
        if (TextInput.State.currentlyFocusedInput() !== input) return;
        const visibleBottom = Math.min(viewportTop + viewportHeight, keyboard.screenY);
        const overlap = inputTop + inputHeight + FOCUSED_FIELD_SPACING - visibleBottom;
        const aboveViewport = inputTop - viewportTop - FOCUSED_FIELD_SPACING;
        const adjustment = overlap > 0 ? overlap : Math.min(0, aboveViewport);
        if (adjustment !== 0) {
          scrollRef.current?.scrollTo({
            y: Math.max(0, scrollOffset.current + adjustment),
            animated: true,
          });
        }
      });
    });
  };

  useEffect(() => {
    setProfile(initialProfile);
    setCredentialDrafts(credentialDraftsForProfile(initialProfile));
    setKeyActionsOpen(false);
    setJumpHostPickerOpen(false);
  }, [initialProfile]);

  useEffect(() => {
    if (profile.authMode !== 'key' || !profile.secret.trim()) {
      setKeyInspection({ state: 'idle' });
      return;
    }

    let active = true;
    setKeyInspection({ state: 'loading' });
    const timeout = setTimeout(() => {
      Promise.resolve()
        .then(() => getKeyDetails(normalizePrivateKey(profile.secret), profile.passphrase || undefined))
        .then(details => {
          if (active) setKeyInspection({
            state: 'valid',
            fingerprint: details.fingerprint,
            keyType: details.keyType,
            publicKey: details.publicKey,
          });
        })
        .catch((inspectionError: { code?: string; message?: string }) => {
          if (!active) return;
          if (inspectionError?.code === 'E_KEY_PASSPHRASE_REQUIRED') {
            setKeyInspection({ state: 'passphrase-required' });
            return;
          }
          setKeyInspection({
            state: 'invalid',
            message: inspectionError?.code === 'E_KEY_PASSPHRASE_INVALID'
              ? t('connection.incorrectPassphrase')
              : t('connection.unreadableKey'),
          });
        });
    }, 250);

    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [profile.authMode, profile.passphrase, profile.secret, t]);

  const update = <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => setProfile(current => ({ ...current, [key]: value }));
  const canSave = Boolean(profile.host.trim() && profile.username.trim());
  const canConnect = Boolean(canSave && profile.secret);
  const jumpHosts = jumpHostCandidates(hosts, profile.id);
  const selectedJumpHost = hosts.find(host => host.id === profile.jumpHostId);
  const privateKeyAccessibilityLabel = keyInspection.state === 'valid'
    ? t('connection.keyA11y', { fingerprint: keyInspection.fingerprint, keyType: keyInspection.keyType })
    : t('connection.loadedKeyA11y');
  const removePrivateKey = () => {
    const next = updateActiveCredential(profile, credentialDrafts, '', '');
    setProfile(next.profile);
    setCredentialDrafts(next.drafts);
    setKeyActionsOpen(false);
  };
  const setAuthMode = (authMode: ConnectionProfile['authMode']) => {
    const next = switchCredentialAuthMode(profile, credentialDrafts, authMode);
    setProfile(next.profile);
    setCredentialDrafts(next.drafts);
  };
  const applyPrivateKey = (value: string) => {
    const privateKey = normalizePrivateKey(value);
    if (!privateKey) {
      Alert.alert(t('connection.noPrivateKeyTitle'), t('connection.noPrivateKeyCopy'));
      return;
    }
    const next = updateActiveCredential(profile, credentialDrafts, privateKey);
    setProfile(next.profile);
    setCredentialDrafts(next.drafts);
    setKeyActionsOpen(false);
  };
  const pastePrivateKey = async () => {
    try {
      applyPrivateKey(await Clipboard.getString());
    } catch (pasteError) {
      Alert.alert(t('connection.pasteError'), String(pasteError));
    }
  };
  const selectPrivateKeyFile = async () => {
    setKeyActionsOpen(false);
    if (!privateKeyFilePicker) {
      Alert.alert(t('connection.fileUnavailableTitle'), t('connection.fileUnavailableCopy'));
      return;
    }
    try {
      const privateKey = await privateKeyFilePicker.pickPrivateKey();
      if (privateKey != null) applyPrivateKey(privateKey);
    } catch (fileError) {
      Alert.alert(t('connection.readKeyError'), String(fileError));
    }
  };
  const generatePrivateKey = () => {
    setKeyActionsOpen(false);
    setGeneratingKey(true);
    try {
      const generated = generateKeyPair('ed25519', profile.passphrase || '', 256, profile.name.trim() || 'herdr');
      applyPrivateKey(generated.privateKey);
    } catch (generationError) {
      Alert.alert(t('connection.generateKeyError'), String(generationError));
    } finally {
      setGeneratingKey(false);
    }
  };
  const useGlobalKeychain = async () => {
    setKeyActionsOpen(false);
    if (!onLoadGlobalKeys) return;
    try {
      const keys = await onLoadGlobalKeys();
      if (keys === null) return;
      if (keys.length === 0) {
        Alert.alert(t('keychain.emptyTitle'), t('keychain.emptyPickerCopy'));
        return;
      }
      setGlobalKeys(keys);
    } catch (keychainError) {
      if (errorCode(keychainError) !== 'E_GLOBAL_KEYCHAIN_CANCELLED') {
        Alert.alert(t('keychain.unlockError'), String(keychainError));
      }
    }
  };
  const selectGlobalKey = (key: GlobalSshKeyMaterial) => {
    const next = updateActiveCredential(profile, credentialDrafts, key.secret, key.passphrase);
    setProfile(next.profile);
    setCredentialDrafts(next.drafts);
    setGlobalKeys(null);
  };
  const copied = (label: string) => {
    setKeyActionsOpen(false);
    if (Platform.OS === 'android') ToastAndroid.show(t('connection.copied', { label }), ToastAndroid.SHORT);
    else Alert.alert(t('connection.copied', { label }));
  };
  const copyPrivateKey = async () => {
    if (onAuthenticatePrivateKey && !await onAuthenticatePrivateKey()) return;
    Clipboard.setString(profile.secret);
    copied(t('connection.privateKey'));
  };
  const copyPublicKey = () => {
    try {
      const publicKey = keyInspection.state === 'valid'
        ? keyInspection.publicKey
        : getKeyDetails(normalizePrivateKey(profile.secret), profile.passphrase || undefined).publicKey;
      Clipboard.setString(publicKey);
      copied(t('connection.publicKey'));
    } catch (copyError) {
      setKeyActionsOpen(false);
      Alert.alert(
        t('connection.copyPublicError'),
        t(privateKeyErrorTranslationKey(copyError)),
      );
    }
  };

  return (
    <View ref={keyboardViewportRef} collapsable={false} className="flex-1">
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={keyboardVerticalOffset}
      style={Platform.OS === 'android' ? { paddingBottom: keyboardInset } : undefined}
      className="flex-1">
      <ScreenHeader title={profile.name.trim() ? t('connection.editHost') : t('connection.newHost')} left={<IconButton icon={ChevronLeft} accessibilityLabel={t('connection.back')} onPress={onCancel} />} />
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        onFocus={revealFocusedField}
        onLayout={revealFocusedField}
        onScroll={event => { scrollOffset.current = event.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}><View className="p-4 pb-11">
        <View className="mb-[30px] flex-row items-center gap-3.5"><WhipMark size={48} /><View className="flex-1"><Text className="text-lg font-semibold leading-6">{t('connection.title')}</Text><Text className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">{t('connection.intro')}</Text></View></View>

        <GlassSurface className="rounded-lg border border-white/30 p-4 dark:border-white/10">
        <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{t('connection.hostIdentity')}</Text>
        <Field label={t('connection.displayName')} value={profile.name} placeholder={profile.host.trim() || 'Savior'} onChangeText={value => update('name', value)} />

        <Text className="mb-3 mt-3.5 px-1 text-sm font-semibold text-muted-foreground">{t('connection.sshDestination')}</Text>
        <View className="flex-row gap-2.5"><Field label={t('connection.hostOrIp')} value={profile.host} placeholder="server.example.com" onChangeText={value => update('host', value)} className="flex-1" autoCapitalize="none" /><Field label={t('connection.port')} value={profile.port} onChangeText={value => update('port', value)} keyboardType="number-pad" className="w-[88px]" /></View>
        <Field label={t('connection.sshUser')} value={profile.username} placeholder="kosumi" onChangeText={value => update('username', value)} autoCapitalize="none" />
        <JumpHostField
          jumpHost={selectedJumpHost}
          onPress={() => setJumpHostPickerOpen(true)}
        />

        <View
          className={cn('mb-4 flex-row rounded-full p-1', appGlassEnabled ? 'border' : 'bg-muted')}
          style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}>
          {(['password', 'key'] as const).map(mode => {
            const selected = profile.authMode === mode;
            return (
              <Button
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                className={cn(
                  'h-[38px] flex-1 rounded-full',
                  !appGlassEnabled && selected && 'bg-background',
                  appGlassEnabled && selected && 'border',
                )}
                key={mode}
                style={appGlassEnabled && selected ? appGlassControlStyle(true, colors) : undefined}
                variant="ghost"
                onPress={hapticPress(() => setAuthMode(mode))}>
                <Text className={cn(
                  'text-[13px] font-semibold',
                  !selected && 'text-muted-foreground',
                  appGlassEnabled && selected && 'text-primary',
                )}>
                  {mode === 'password' ? t('hosts.password') : t('connection.privateKey')}
                </Text>
              </Button>
            );
          })}
        </View>

        {profile.authMode === 'password' ? (
          <Field label={t('connection.sshPassword')} value={profile.secret} onChangeText={value => {
            const next = updateActiveCredential(profile, credentialDrafts, value);
            setProfile(next.profile);
            setCredentialDrafts(next.drafts);
          }} secureTextEntry autoCapitalize="none" />
        ) : (
          <View className="mb-3.5"><Text className="mb-1.5 text-xs font-medium text-muted-foreground">{t('connection.privateKeyFormat')}</Text><View className={cn('min-h-[58px] w-full flex-row overflow-hidden rounded-md border border-border', !appGlassEnabled && 'bg-card')} style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}><Button accessibilityLabel={profile.secret ? privateKeyAccessibilityLabel : t('connection.addPrivateKey')} className="min-h-[58px] min-w-0 flex-1 justify-start rounded-none px-3.5 py-2.5" disabled={generatingKey} size="content" variant="ghost" onPress={hapticPress(() => setKeyActionsOpen(true))}><Icon as={KeyRound} size={18} />{profile.secret ? (keyInspection.state === 'valid' ? <KeyIdentity fingerprint={keyInspection.fingerprint} keyType={keyInspection.keyType} /> : <Text className="min-w-0 flex-1 text-[13px] font-medium" numberOfLines={1}>{t('connection.privateKeyLoaded')}</Text>) : <Text className="min-w-0 flex-1 text-[13px] font-medium" numberOfLines={1}>{generatingKey ? t('connection.generatingKey') : t('connection.addPrivateKey')}</Text>}</Button>{profile.secret ? <Button accessibilityLabel={t('connection.removePrivateKey')} className="min-h-[58px] w-[52px] rounded-none border-l border-border px-0 py-0" size="content" variant="ghost" onPress={hapticPress(removePrivateKey)}><Icon as={X} className="text-muted-foreground" size={19} /></Button> : null}</View></View>
        )}
        {profile.authMode === 'key' && keyInspection.state !== 'idle' && keyInspection.state !== 'valid' ? (
            <Text
              accessibilityLiveRegion="polite"
              className={cn(
                '-mt-2 mb-3.5 px-1 text-xs leading-[17px]',
                keyInspection.state === 'invalid' && 'text-destructive',
                (keyInspection.state === 'loading' || keyInspection.state === 'passphrase-required') && 'text-muted-foreground',
              )}>
              {keyInspection.state === 'loading' && t('connection.inspectingKey')}
              {keyInspection.state === 'passphrase-required' && t('connection.passphraseRequired')}
              {keyInspection.state === 'invalid' && keyInspection.message}
            </Text>
        ) : null}
        {profile.authMode === 'key' ? <Field label={t('connection.keyPassphrase')} value={profile.passphrase} onChangeText={value => {
          const next = updateActiveCredential(profile, credentialDrafts, profile.secret, value);
          setProfile(next.profile);
          setCredentialDrafts(next.drafts);
        }} secureTextEntry /> : null}

        <View className="mb-3.5 mt-0.5 min-h-[82px] flex-row items-center gap-4 border-y border-border">
          <View className="flex-1">
            <Text className="text-[15px] font-semibold leading-5">{t('connection.agentForwarding')}</Text>
            <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">
              {profile.authMode === 'key'
                ? t('connection.agentForwardingCopy')
                : t('connection.agentForwardingKeyRequired')}
            </Text>
          </View>
          <Switch
            checked={Boolean(profile.forwardAgent)}
            disabled={profile.authMode !== 'key'}
            onCheckedChange={value => update('forwardAgent', value)}
          />
        </View>

        <Text className="mb-3 mt-3.5 px-1 text-sm font-semibold text-muted-foreground">{t('connection.herdrTarget')}</Text>
        <View className="flex-row gap-2.5"><Field label={t('connection.command')} value={profile.herdrCommand} onChangeText={value => update('herdrCommand', value)} className="flex-1" autoCapitalize="none" /><Field label={t('connection.session')} value={profile.sessionName} placeholder="default" onChangeText={value => update('sessionName', value)} className="w-[118px]" autoCapitalize="none" /></View>
        <Field className="mt-2.5" label={t('connection.socket')} value={profile.herdrSocketPath || ''} placeholder="auto (~/.config/herdr/herdr.sock)" onChangeText={value => update('herdrSocketPath', value)} autoCapitalize="none" />

        {error ? <Text className="my-2.5 text-[13px] leading-[18px] text-destructive">{error}</Text> : null}
        <View className="mt-2 flex-row gap-2.5">
          <Button
            className={cn('flex-1 rounded-full', appGlassEnabled && 'border')}
            style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
            variant={appGlassEnabled ? 'ghost' : 'secondary'}
            disabled={!canSave || connecting}
            onPress={hapticPress(() => onSave(profile))}>
            <Text>{t('connection.saveHost')}</Text>
          </Button>
          <Button
            className={cn('flex-1 rounded-full', appGlassEnabled && 'border')}
            style={appGlassEnabled ? appGlassControlStyle(true, colors) : undefined}
            variant={appGlassEnabled ? 'ghost' : 'default'}
            disabled={!canConnect || connecting}
            onPress={hapticPress(() => onConnect(profile))}>
            <Text className={cn(appGlassEnabled && 'text-primary')}>{connecting ? t('connection.openingSsh') : t('common.connect')}</Text>
            <Icon as={ArrowRight} className={appGlassEnabled ? 'text-primary' : 'text-primary-foreground'} size={17} />
          </Button>
        </View>
        {onDelete ? <Button className="mt-3.5 rounded-full" variant="destructive" onPress={hapticPress(onDelete)}><Icon as={Trash2} className="text-destructive-foreground" size={17} /><Text>{t('connection.deleteHost')}</Text></Button> : null}
        <Text className="mt-4 text-center text-[11px] leading-4 text-muted-foreground/70">{t('connection.hostKeyWarning')}</Text>
        </GlassSurface>
      </View></ScrollView>
      <PrivateKeyActions
        hasKey={Boolean(profile.secret)}
        visible={keyActionsOpen}
        onClose={() => setKeyActionsOpen(false)}
        onCopyPrivate={copyPrivateKey}
        onCopyPublic={copyPublicKey}
        onGenerate={generatePrivateKey}
        onGlobalKeychain={onLoadGlobalKeys ? useGlobalKeychain : undefined}
        onPaste={pastePrivateKey}
        onSelectFile={selectPrivateKeyFile}
      />
      <GlobalKeyPicker
        keys={globalKeys || []}
        visible={globalKeys !== null}
        onClose={() => setGlobalKeys(null)}
        onSelect={selectGlobalKey}
      />
      <JumpHostPicker
        hosts={jumpHosts}
        selectedHostId={profile.jumpHostId}
        visible={jumpHostPickerOpen}
        onClose={() => setJumpHostPickerOpen(false)}
        onSelect={jumpHostId => {
          update('jumpHostId', jumpHostId);
          setJumpHostPickerOpen(false);
        }}
      />
    </KeyboardAvoidingView>
    </View>
  );
}

interface FieldProps extends React.ComponentProps<typeof TextInput> { label: string; className?: string }

function Field({ label, className, multiline, ...props }: FieldProps) {
  return <View className={cn('mb-3.5', className)}><Text className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</Text><Input {...props} multiline={multiline} className={multiline ? 'min-h-[116px] font-mono text-xs' : undefined} textAlignVertical={multiline ? 'top' : 'center'} /></View>;
}

function KeyIdentity({ fingerprint, keyType }: { fingerprint: string; keyType: string }) {
  return <View className="min-w-0 flex-1 justify-center"><Text className="shrink font-mono text-[12px] leading-[17px]" ellipsizeMode="middle" numberOfLines={1}>{fingerprint}</Text><Text className="text-[11px] font-semibold leading-[17px] text-muted-foreground" numberOfLines={1}>{keyType}</Text></View>;
}

function JumpHostField({ jumpHost, onPress }: { jumpHost?: HostProfile; onPress: () => void }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  return (
    <View className="mb-3.5">
      <Text className="mb-1.5 text-xs font-medium text-muted-foreground">{t('connection.jumpHost')}</Text>
      <Button
        accessibilityLabel={t('connection.chooseJumpHost')}
        className={cn('h-[52px] justify-start rounded-md border border-border px-3.5', !appGlassEnabled && 'bg-card')}
        style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
        variant="ghost"
        onPress={hapticPress(onPress)}>
        <Icon as={Network} size={18} />
        <View className="min-w-0 flex-1">
          <Text className="text-[14px] font-medium" numberOfLines={1}>
            {jumpHost ? hostDisplayName(jumpHost) : t('connection.directConnection')}
          </Text>
          {jumpHost ? (
            <Text className="mt-0.5 text-[11px] text-muted-foreground" numberOfLines={1}>
              {jumpHost.username}@{jumpHost.host}:{jumpHost.port}
            </Text>
          ) : null}
        </View>
        <Icon as={ChevronDown} className="text-muted-foreground" size={17} />
      </Button>
    </View>
  );
}

function PrivateKeyActions({ hasKey, visible, onClose, onCopyPrivate, onCopyPublic, onGenerate, onGlobalKeychain, onPaste, onSelectFile }: {
  hasKey: boolean;
  visible: boolean;
  onClose: () => void;
  onCopyPrivate: () => void;
  onCopyPublic: () => void;
  onGenerate: () => void;
  onGlobalKeychain?: () => void;
  onPaste: () => void;
  onSelectFile: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  if (hasKey) {
    return (
      <SshKeyCopySheet
        visible={visible}
        onClose={onClose}
        onCopyPrivate={onCopyPrivate}
        onCopyPublic={onCopyPublic}
      />
    );
  }
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable accessibilityLabel={t('connection.closeKeyActions')} className="absolute inset-0 bg-black/55" onPress={onClose} />
        <GlassSurface accessibilityViewIsModal className="rounded-t-[28px] border-t border-white/30 px-4 pb-8 pt-5 dark:border-white/10">
          <Text className="px-2 text-lg font-semibold">{t('connection.addPrivateKey')}</Text>
          <Text className="mb-3 mt-1 px-2 text-[13px] leading-[18px] text-muted-foreground">
            {t('connection.chooseAddMethod')}
          </Text>
          {onGlobalKeychain ? <KeyAction icon={KeyRound} label={t('keychain.useGlobal')} onPress={onGlobalKeychain} /> : null}
          <KeyAction icon={ClipboardPaste} label={t('connection.pasteClipboard')} onPress={onPaste} />
          <KeyAction icon={FileUp} label={t('connection.selectFile')} onPress={onSelectFile} />
          <KeyAction icon={Sparkles} label={t('connection.generateNew')} onPress={onGenerate} />
          <Button
            className={cn('mt-2 rounded-full', appGlassEnabled && 'border')}
            style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
            variant={appGlassEnabled ? 'ghost' : 'secondary'}
            onPress={hapticPress(onClose)}>
            <Text>{t('common.cancel')}</Text>
          </Button>
        </GlassSurface>
      </View>
    </Modal>
  );
}

function GlobalKeyPicker({ keys, visible, onClose, onSelect }: {
  keys: GlobalSshKeyMaterial[];
  visible: boolean;
  onClose: () => void;
  onSelect: (key: GlobalSshKeyMaterial) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable accessibilityLabel={t('keychain.closePicker')} className="absolute inset-0 bg-black/55" onPress={onClose} />
        <GlassSurface accessibilityViewIsModal className="max-h-[72%] rounded-t-[28px] border-t border-white/30 px-4 pb-8 pt-5 dark:border-white/10">
          <Text className="px-2 text-lg font-semibold">{t('keychain.chooseKey')}</Text>
          <Text className="mb-3 mt-1 px-2 text-[13px] leading-[18px] text-muted-foreground">{t('keychain.chooseKeyCopy')}</Text>
          <ScrollView contentContainerClassName="gap-2">
            {keys.map(key => (
              <Button
                key={key.id}
                className={cn('min-h-[68px] justify-start rounded-xl px-3 py-2', appGlassEnabled && 'border')}
                style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
                size="content"
                variant="ghost"
                onPress={hapticPress(() => onSelect(key))}>
                <Icon as={KeyRound} size={19} />
                <View className="ml-1 min-w-0 flex-1">
                  <Text className="text-[15px] font-medium" numberOfLines={1}>{key.name}</Text>
                  <Text className="mt-0.5 font-mono text-[11px] text-muted-foreground" ellipsizeMode="middle" numberOfLines={1}>{key.fingerprint}</Text>
                  <Text className="mt-0.5 text-[11px] text-muted-foreground">{key.keyType}</Text>
                </View>
              </Button>
            ))}
          </ScrollView>
          <Button
            className={cn('mt-2 rounded-full', appGlassEnabled && 'border')}
            style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
            variant={appGlassEnabled ? 'ghost' : 'secondary'}
            onPress={hapticPress(onClose)}>
            <Text>{t('common.cancel')}</Text>
          </Button>
        </GlassSurface>
      </View>
    </Modal>
  );
}

function JumpHostPicker({ hosts, selectedHostId, visible, onClose, onSelect }: {
  hosts: HostProfile[];
  selectedHostId?: string;
  visible: boolean;
  onClose: () => void;
  onSelect: (hostId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const options: Array<HostProfile | null> = [null, ...hosts];
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <Pressable accessibilityLabel={t('connection.closeJumpHostPicker')} className="flex-1 justify-end bg-black/55" onPress={onClose}>
        <Pressable className="max-h-[72%] rounded-t-[28px] border-t border-border bg-card px-4 pb-8 pt-5" onPress={event => event.stopPropagation()}>
          <Text className="px-2 text-lg font-semibold">{t('connection.chooseJumpHost')}</Text>
          <Text className="mb-3 mt-1 px-2 text-[13px] leading-[18px] text-muted-foreground">{t('connection.jumpHostCopy')}</Text>
          <ScrollView>
            {options.map(host => {
              const selected = host ? host.id === selectedHostId : !selectedHostId;
              return (
                <Button
                  key={host?.id || 'direct'}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  className="min-h-[62px] justify-start rounded-xl px-3 py-2"
                  size="content"
                  variant="ghost"
                  onPress={hapticPress(() => onSelect(host?.id))}>
                  <Icon as={host ? Network : ArrowRight} size={19} />
                  <View className="ml-1 min-w-0 flex-1">
                    <Text className="text-[15px] font-medium" numberOfLines={1}>
                      {host ? hostDisplayName(host) : t('connection.directConnection')}
                    </Text>
                    <Text className="mt-0.5 text-[11px] text-muted-foreground" numberOfLines={1}>
                      {host ? `${host.username}@${host.host}:${host.port}` : t('connection.directConnectionCopy')}
                    </Text>
                  </View>
                  {selected ? <Icon as={Check} className="text-primary" size={18} /> : null}
                </Button>
              );
            })}
          </ScrollView>
          <Button className="mt-2 rounded-full" variant="secondary" onPress={hapticPress(onClose)}><Text>{t('common.cancel')}</Text></Button>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function KeyAction({ icon, label, onPress }: { icon: typeof KeyRound; label: string; onPress: () => void }) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  return <Button className={cn('h-14 justify-start rounded-xl px-3', appGlassEnabled && 'border')} style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined} variant="ghost" onPress={hapticPress(onPress)}><Icon as={icon} size={19} /><Text className="text-[15px] font-medium">{label}</Text></Button>;
}
