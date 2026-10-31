import { KeyboardAvoidingView, KeyboardController } from 'react-native-keyboard-controller';
import { ChevronLeft, ClipboardPaste, FileText, FileUp, KeyRound, Link, Save, Sparkles, SquareTerminal, Trash2, X } from 'lucide-react-native';
import { generateKeyPair, getKeyDetails } from 'react-native-whip-ssh';
import { useEffect, useReducer, useRef, useState } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import { Alert, Keyboard, Modal, Pressable, ScrollView, TextInput, View, type ScrollViewInstance } from 'react-native';
import { useTranslation } from 'react-i18next';

import { errorCode, privateKeyErrorTranslationKey } from '@/src/lib/connectionErrors';
import { DEFAULT_SSH_PORT, jumpHostCandidates } from '@/src/lib/hostProfiles';
import { normalizePrivateKey } from '@/src/lib/privateKey';
import { limitAgentInstructions } from '@/src/lib/agentInstructions';
import {
  connectionCredentialReducer,
  createConnectionCredentialState,
} from '@/src/lib/connectionCredentialDrafts';
import { cn } from '@/src/lib/utils';
import { APP_FROSTED_GLASS_SURFACE_PROPS } from '@/src/lib/appGlass';
import { copyTextWithHaptic } from '@/src/services/interactionFeedback';
import { pickPrivateKeyFile } from '@/src/services/privateKeyFilePicker';
import type { UnknownHostKeyChallenge } from '@/src/services/knownHosts';
import { appGlassControlStyle, useTheme } from '@/src/theme';
import type { ConnectionProfile, GlobalSshKeyMaterial, HostProfile } from '@/src/types';
import { hapticPress, IconButton, ScreenHeader, WhipMark } from './app-ui';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { GlassButton } from './GlassControls';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Input } from './ui/input';
import { Separator } from './ui/separator';
import { Switch } from './ui/switch';
import { Text } from './ui/text';
import { SshKeyCopySheet } from './SshKeyCopySheet';
import { JumpHostSelect } from './JumpHostSelect';
import { TailcatSettings } from './TailcatSettings';
import { ensureTailcatIdentity } from '../services/hostProfiles';
import { InstallPublicKeySheet } from './InstallPublicKeySheet';
import { RemoteNotificationsSection } from './RemoteNotificationsSection';
import { SettingsDetailsProvider } from './SettingsDetails';

interface Props {
  initialProfile: ConnectionProfile;
  hosts: HostProfile[];
  connecting: boolean;
  connected?: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (profile: ConnectionProfile) => void;
  onConnect: (profile: ConnectionProfile) => void;
  onDelete?: () => void;
  onAuthenticatePrivateKey?: () => Promise<boolean>;
  onLoadGlobalKeys?: () => Promise<GlobalSshKeyMaterial[] | null>;
  onConfirmUnknownHost: (challenge: UnknownHostKeyChallenge) => Promise<boolean>;
  onTrustHost: (challenge: UnknownHostKeyChallenge) => Promise<void>;
}

type KeyInspection =
  | { state: 'idle' | 'loading' }
  | { state: 'valid'; fingerprint: string; keyType: string; publicKey: string }
  | { state: 'passphrase-required' }
  | { state: 'invalid'; message: string };

const FOCUSED_FIELD_SPACING = 16;
const HOST_DETAIL_CARD_CLASS_NAME = 'rounded-lg border border-white/30 dark:border-white/10';
const DEFAULT_TAILCAT_NAME = 'Tailcat';

export function ConnectionScreen({ initialProfile, hosts, connecting, connected = false, error, onCancel, onSave, onConnect, onDelete, onAuthenticatePrivateKey, onLoadGlobalKeys, onConfirmUnknownHost, onTrustHost }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollOffset = useRef(0);
  const appGlassEnabled = useAppGlassEnabled();
  const [{ profile }, dispatchCredentials] = useReducer(
    connectionCredentialReducer,
    initialProfile,
    createConnectionCredentialState,
  );
  const [keyInspection, setKeyInspection] = useState<KeyInspection>({ state: 'idle' });
  const [keyActionsOpen, setKeyActionsOpen] = useState(false);
  const [globalKeys, setGlobalKeys] = useState<GlobalSshKeyMaterial[] | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [installPublicKeyOpen, setInstallPublicKeyOpen] = useState(false);
  const savedHost = hosts.find(host => host.id === initialProfile.id);
  const herdrEnabled = profile.herdrEnabled !== false;
  const connectedHost = savedHost && (savedHost.lastConnectedAt || connected) ? savedHost : undefined;

  const revealFocusedField = () => {
    const keyboardVisible = KeyboardController.isVisible();
    const input = TextInput.State.currentlyFocusedInput();
    if (!keyboardVisible || !input) return;

    scrollRef.current?.getNativeScrollRef()?.measureInWindow((_x, viewportTop, _width, viewportHeight) => {
      input.measureInWindow((_inputX, inputTop, _inputWidth, inputHeight) => {
        if (TextInput.State.currentlyFocusedInput() !== input) return;
        const visibleBottom = viewportTop + viewportHeight;
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
    dispatchCredentials({ type: 'reset', profile: initialProfile });
    setKeyActionsOpen(false);
  }, [initialProfile]);

  const [tailcatIdentityError, setTailcatIdentityError] = useState(false);
  const [tailcatIdentityAttempt, setTailcatIdentityAttempt] = useState(0);
  useEffect(() => {
    if (!profile.tailcatEnabled || (profile.tailcatPrivateKey && profile.tailcatPublicKey)) return;
    let active = true;
    setTailcatIdentityError(false);
    ensureTailcatIdentity(profile).then(prepared => {
      if (active) dispatchCredentials({ type: 'profile-changed', changes: {
        tailcatPrivateKey: prepared.tailcatPrivateKey, tailcatPublicKey: prepared.tailcatPublicKey,
      } });
    }).catch(() => { if (active) setTailcatIdentityError(true); });
    return () => { active = false; };
  }, [profile, tailcatIdentityAttempt]);

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

  const update = <K extends Exclude<keyof ConnectionProfile, 'authMode' | 'secret' | 'passphrase'>>(key: K, value: ConnectionProfile[K]) =>
    dispatchCredentials({ type: 'profile-changed', changes: { [key]: value } });
  // A Tailcat-only host uses a stable, secret-free alias for SSH host-key trust.
  const tailcatHostAlias = `tailcat-${profile.id}.invalid`;
  const sshHost = profile.host === tailcatHostAlias ? '' : profile.host;
  const hostFieldValue = profile.tailcatEnabled ? profile.tailcatAddress ?? '' : sshHost;
  const hostFieldLabel = t(profile.tailcatEnabled ? 'connection.tailcatAddress' : 'connection.hostOrIp');
  const hostNamePlaceholder = profile.tailcatEnabled && !sshHost.trim() ? DEFAULT_TAILCAT_NAME : sshHost.trim() || 'Savior';
  const submittedProfile = {
    ...profile,
    host: profile.tailcatEnabled ? sshHost.trim() || tailcatHostAlias : sshHost,
    name: profile.tailcatEnabled && !sshHost.trim() && !profile.name.trim() ? DEFAULT_TAILCAT_NAME : profile.name,
  };
  const canSave = Boolean(hostFieldValue.trim() && profile.username.trim()
    && (!profile.tailcatEnabled || (profile.tailcatPrivateKey && profile.tailcatPublicKey)));
  const builtinTailcatSsh = Boolean(profile.tailcatEnabled && profile.tailcatSshServer);
  const canConnect = Boolean(canSave && profile.secret && (!builtinTailcatSsh || profile.authMode === 'key'));
  const jumpHosts = jumpHostCandidates(hosts, profile.id);
  const privateKeyAccessibilityLabel = keyInspection.state === 'valid'
    ? t('connection.keyA11y', { fingerprint: keyInspection.fingerprint, keyType: keyInspection.keyType })
    : t('connection.loadedKeyA11y');
  const removePrivateKey = () => {
    dispatchCredentials({ type: 'credential-changed', changes: { secret: '', passphrase: '' } });
    setKeyActionsOpen(false);
  };
  const setAuthMode = (authMode: ConnectionProfile['authMode']) => {
    dispatchCredentials({ type: 'auth-mode-changed', authMode });
  };
  const applyPrivateKey = (value: string) => {
    const privateKey = normalizePrivateKey(value);
    if (!privateKey) {
      Alert.alert(t('connection.noPrivateKeyTitle'), t('connection.noPrivateKeyCopy'));
      return;
    }
    dispatchCredentials({ type: 'credential-changed', changes: { secret: privateKey } });
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
    try {
      const privateKey = await pickPrivateKeyFile();
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
    dispatchCredentials({ type: 'credential-changed', changes: { secret: key.secret, passphrase: key.passphrase } });
    setGlobalKeys(null);
  };
  const copyKey = (key: string) => {
    copyTextWithHaptic(key);
    setKeyActionsOpen(false);
  };
  const copyPrivateKey = async () => {
    if (onAuthenticatePrivateKey && !await onAuthenticatePrivateKey()) return;
    copyKey(profile.secret);
  };
  const copyPublicKey = () => {
    try {
      const publicKey = keyInspection.state === 'valid'
        ? keyInspection.publicKey
        : getKeyDetails(normalizePrivateKey(profile.secret), profile.passphrase || undefined).publicKey;
      copyKey(publicKey);
    } catch (copyError) {
      setKeyActionsOpen(false);
      Alert.alert(
        t('connection.copyPublicError'),
        t(privateKeyErrorTranslationKey(copyError)),
      );
    }
  };

  return (
    <SettingsDetailsProvider>
    <KeyboardAvoidingView
      accessibilityElementsHidden={installPublicKeyOpen}
      importantForAccessibility={installPublicKeyOpen ? 'no-hide-descendants' : 'auto'}
      behavior="padding" automaticOffset
      className="flex-1">
      <ScreenHeader title={savedHost ? t('connection.editHost') : t('connection.newHost')} left={<IconButton icon={ChevronLeft} accessibilityLabel={t('connection.back')} onPress={onCancel} />} />
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        keyboardShouldPersistTaps="handled"
        onFocus={revealFocusedField}
        onLayout={revealFocusedField}
        onScroll={event => { scrollOffset.current = event.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16}><View className="p-4 pb-11">
        <View className="mb-[30px] flex-row items-center gap-3.5"><WhipMark size={48} /><View className="flex-1"><Text className="text-lg font-semibold leading-6">{t('connection.title')}</Text><Text className="mt-0.5 text-[13px] leading-[19px] text-muted-foreground">{t('connection.intro')}</Text></View></View>

        <GlassSurface className={cn(HOST_DETAIL_CARD_CLASS_NAME, 'p-4')}>
        <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{t('connection.hostIdentity')}</Text>
        <Field label={t('connection.displayName')} value={profile.name} placeholder={hostNamePlaceholder} onChangeText={value => update('name', value)} />

        <Text className="mb-3 mt-3.5 px-1 text-sm font-semibold text-muted-foreground">{t('connection.sshDestination')}</Text>
        <View className="flex-row gap-2.5">
          <Field
            label={hostFieldLabel}
            accessibilityLabel={hostFieldLabel}
            value={hostFieldValue}
            placeholder={profile.tailcatEnabled ? 'tc…' : 'server.example.com'}
            onChangeText={value => update(profile.tailcatEnabled ? 'tailcatAddress' : 'host', value)}
            className="flex-1"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={Boolean(profile.tailcatEnabled)}
          />
          <Field label={t('connection.port')} value={builtinTailcatSsh ? DEFAULT_SSH_PORT : profile.port} editable={!builtinTailcatSsh} onChangeText={value => update('port', value)} keyboardType="number-pad" className="w-[88px]" />
        </View>
        {profile.tailcatEnabled ? <Text className="-mt-1.5 mb-3.5 text-xs leading-[17px] text-muted-foreground">{t('connection.tailcatSetup')}</Text> : null}
        <Field label={t('connection.sshUser')} value={profile.username} placeholder="kosumi" onChangeText={value => update('username', value)} autoCapitalize="none" />
        {!profile.tailcatEnabled && <JumpHostSelect
          hosts={jumpHosts}
          selectedHostId={profile.jumpHostId}
          onSelect={jumpHostId => update('jumpHostId', jumpHostId)}
        />}

        <View
          className={cn('mb-4 flex-row rounded-full p-1', appGlassEnabled ? 'border' : 'bg-muted')}
          style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}>
          {(['password', 'key'] as const).map(mode => {
            const selected = profile.authMode === mode;
            return (
              <Button
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                disabled={builtinTailcatSsh && mode === 'password'}
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
            dispatchCredentials({ type: 'credential-changed', changes: { secret: value } });
          }} secureTextEntry autoCapitalize="none" />
        ) : (
          <View className="mb-3.5"><Text className="mb-1.5 text-xs font-medium text-muted-foreground">{t('connection.privateKeyFormat')}</Text><View className={cn('min-h-[58px] w-full flex-row overflow-hidden rounded-md border border-border', !appGlassEnabled && 'bg-card')} style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}><Button accessibilityLabel={profile.secret ? privateKeyAccessibilityLabel : t('connection.addPrivateKey')} className="min-h-[58px] min-w-0 flex-1 justify-start rounded-none px-3.5 py-2.5" disabled={generatingKey} size="content" variant="ghost" onLongPress={hapticPress(() => setKeyActionsOpen(true))} onPress={hapticPress(() => setKeyActionsOpen(true))}><Icon as={KeyRound} size={18} />{profile.secret ? (keyInspection.state === 'valid' ? <KeyIdentity fingerprint={keyInspection.fingerprint} keyType={keyInspection.keyType} /> : <Text className="min-w-0 flex-1 text-[13px] font-medium" numberOfLines={1}>{t('connection.privateKeyLoaded')}</Text>) : <Text className="min-w-0 flex-1 text-[13px] font-medium" numberOfLines={1}>{generatingKey ? t('connection.generatingKey') : t('connection.addPrivateKey')}</Text>}</Button>{profile.secret ? <Button accessibilityLabel={t('connection.removePrivateKey')} className="min-h-[58px] w-[52px] rounded-none border-l border-border px-0 py-0" size="content" variant="ghost" onPress={hapticPress(removePrivateKey)}><Icon as={X} className="text-muted-foreground" size={19} /></Button> : null}</View></View>
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
          dispatchCredentials({ type: 'credential-changed', changes: { passphrase: value } });
        }} secureTextEntry /> : null}

        <View className="mb-3.5 mt-0.5 min-h-[82px] flex-row items-center gap-4 border-t border-border">
          <View className="flex-1">
            <Text className="text-[15px] font-semibold leading-5">{t('connection.agentForwarding')}</Text>
            <Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">
              {profile.authMode === 'key'
                ? t('connection.agentForwardingCopy')
                : t('connection.agentForwardingKeyRequired')}
            </Text>
          </View>
          <Switch
            checked={!builtinTailcatSsh && Boolean(profile.forwardAgent)}
            disabled={builtinTailcatSsh || profile.authMode !== 'key'}
            onCheckedChange={value => update('forwardAgent', value)}
          />
        </View>

        {connectedHost ? <GlassButton
          accessibilityLabel={t('publicKeys.install')}
          className="mb-3.5 rounded-full"
          variant="secondary"
          disabled={connecting}
          onPress={hapticPress(() => {
            Keyboard.dismiss();
            setInstallPublicKeyOpen(true);
          })}>
          <Icon as={KeyRound} size={17} /><Text>{t('publicKeys.install')}</Text>
        </GlassButton> : null}

        <Separator className="mb-2.5" />
        <TailcatSettings
          enabled={Boolean(profile.tailcatEnabled)}
          onEnabledChange={value => {
            if (value && profile.tailcatSshServer) setAuthMode('key');
            dispatchCredentials({ type: 'profile-changed', changes: { tailcatEnabled: value, ...(value ? { jumpHostId: undefined } : {}) } });
          }}
          port={profile.port}
          sshServer={profile.tailcatSshServer}
          onSshServerChange={value => {
            if (value) setAuthMode('key');
            update('tailcatSshServer', value);
          }}
          clientPublicKey={profile.tailcatPublicKey}
          sshPublicKey={keyInspection.state === 'valid' ? keyInspection.publicKey : undefined}
          identityError={tailcatIdentityError}
          identityPending={!profile.tailcatPublicKey}
          onRetryIdentity={() => setTailcatIdentityAttempt(value => value + 1)}
        />

        </GlassSurface>
        <GlassSurface className={cn(HOST_DETAIL_CARD_CLASS_NAME, 'mt-4 p-4')}>
          <View className="flex-row items-center gap-3">
            <Icon as={SquareTerminal} size={20} className="text-primary" accessible={false} />
            <View className="min-w-0 flex-1">
              <Text accessibilityRole="header" className="font-semibold">{t('connection.herdr')}</Text>
              <Text className="mt-1 text-xs leading-[17px] text-muted-foreground">
                {t(herdrEnabled ? 'connection.herdrCopy' : 'connection.sshOnlyCopy')}
              </Text>
            </View>
            <Switch
              accessibilityLabel={t('connection.herdrEnabled')}
              checked={herdrEnabled}
              onCheckedChange={value => update('herdrEnabled', value)}
            />
          </View>
          {herdrEnabled ? <View className="mt-4">
            <View className="flex-row gap-2.5"><Field label={t('connection.command')} value={profile.herdrCommand} onChangeText={value => update('herdrCommand', value)} className="flex-1" autoCapitalize="none" /><Field label={t('connection.session')} value={profile.sessionName} placeholder="default" onChangeText={value => update('sessionName', value)} className="w-[118px]" autoCapitalize="none" /></View>
            <Field className="mt-2.5" label={t('connection.socket')} value={profile.herdrSocketPath || ''} placeholder="auto (~/.config/herdr/herdr.sock)" onChangeText={value => update('herdrSocketPath', value)} autoCapitalize="none" />
          </View> : null}
        </GlassSurface>
        {savedHost && herdrEnabled ? (
          <GlassSurface className={cn(HOST_DETAIL_CARD_CLASS_NAME, 'mt-4 overflow-hidden')}>
            <RemoteNotificationsSection key={savedHost.id} host={savedHost} />
          </GlassSurface>
        ) : null}
        <GlassSurface className={cn(HOST_DETAIL_CARD_CLASS_NAME, 'mt-4 gap-3 p-4')}>
          <View className="flex-row items-center gap-2">
            <Icon as={FileText} size={20} className="text-primary" accessible={false} />
            <Text accessibilityRole="header" className="min-w-0 flex-1 font-semibold">
              {t('connection.agentInstructions')}
            </Text>
          </View>
          <Text className="text-xs leading-[17px] text-muted-foreground">
            {t('connection.agentInstructionsCopy')}
          </Text>
          <Input
            accessibilityLabel={t('connection.agentInstructions')}
            value={profile.agentInstructions || ''}
            onChangeText={value => update('agentInstructions', limitAgentInstructions(value))}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-[116px] font-mono text-xs"
            textAlignVertical="top"
          />
        </GlassSurface>
        {error ? <Text className="my-2.5 text-[13px] leading-[18px] text-destructive">{error}</Text> : null}
        <View className="mt-5 flex-row gap-2.5">
          <Button
            className={cn('flex-1 rounded-full', appGlassEnabled && 'border')}
            style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined}
            variant={appGlassEnabled ? 'ghost' : 'secondary'}
            disabled={!canSave || connecting}
            onPress={hapticPress(() => onSave(submittedProfile))}>
            <Icon as={Save} size={17} accessible={false} />
            <Text>{t('connection.saveHost')}</Text>
          </Button>
          <Button
            className={cn('flex-1 rounded-full', appGlassEnabled && 'border')}
            style={appGlassEnabled ? appGlassControlStyle(true, colors) : undefined}
            variant={appGlassEnabled ? 'ghost' : 'default'}
            disabled={!canConnect || connecting}
            onPress={hapticPress(() => onConnect(submittedProfile))}>
            <Icon as={Link} className={appGlassEnabled ? 'text-primary' : 'text-primary-foreground'} size={17} accessible={false} />
            <Text className={cn(appGlassEnabled && 'text-primary')}>{connecting ? t('connection.openingSsh') : t('common.connect')}</Text>
          </Button>
        </View>
        {onDelete ? <Button className="mt-3.5 rounded-full" variant="destructive" onPress={hapticPress(onDelete)}><Icon as={Trash2} className="text-destructive-foreground" size={17} /><Text>{t('connection.deleteHost')}</Text></Button> : null}
        <Text className="mt-4 text-center text-[11px] leading-4 text-muted-foreground/70">{t('connection.hostKeyWarning')}</Text>
      </View></ScrollView>
      <PrivateKeyActions
        hasKey={Boolean(profile.secret)}
        visible={keyActionsOpen}
        onClose={() => setKeyActionsOpen(false)}
        onCopyPrivate={copyPrivateKey}
        onCopyPublic={copyPublicKey}
        onGetPublicKey={() => getKeyDetails(normalizePrivateKey(profile.secret), profile.passphrase || undefined).publicKey}
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
    </KeyboardAvoidingView>
    {installPublicKeyOpen && connectedHost ? <InstallPublicKeySheet
      host={connectedHost}
      hosts={hosts}
      connected={connected}
      onClose={() => setInstallPublicKeyOpen(false)}
      onLoadGlobalKeys={onLoadGlobalKeys}
      onAuthenticatePrivateKey={onAuthenticatePrivateKey}
      onConfirmUnknownHost={onConfirmUnknownHost}
      onTrustHost={onTrustHost}
    /> : null}
    </SettingsDetailsProvider>
  );
}

interface FieldProps extends React.ComponentProps<typeof TextInput> { label: string; className?: string }

function Field({ label, className, multiline, ...props }: FieldProps) {
  return <View className={cn('mb-3.5', className)}><Text className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</Text><Input {...props} multiline={multiline} className={multiline ? 'min-h-[116px] font-mono text-xs' : undefined} textAlignVertical={multiline ? 'top' : 'center'} /></View>;
}

function KeyIdentity({ fingerprint, keyType }: { fingerprint: string; keyType: string }) {
  return <View className="min-w-0 flex-1 justify-center"><Text className="shrink font-mono text-[12px] leading-[17px]" ellipsizeMode="middle" numberOfLines={1}>{fingerprint}</Text><Text className="text-[11px] font-semibold leading-[17px] text-muted-foreground" numberOfLines={1}>{keyType}</Text></View>;
}

function PrivateKeyActions({ hasKey, visible, onClose, onCopyPrivate, onCopyPublic, onGetPublicKey, onGenerate, onGlobalKeychain, onPaste, onSelectFile }: {
  hasKey: boolean;
  visible: boolean;
  onClose: () => void;
  onCopyPrivate: () => void;
  onCopyPublic: () => void;
  onGetPublicKey: () => string;
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
        onGetPublicKey={onGetPublicKey}
      />
    );
  }
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable accessibilityLabel={t('connection.closeKeyActions')} className="absolute inset-0 bg-black/55" onPress={onClose} />
        <GlassSurface {...APP_FROSTED_GLASS_SURFACE_PROPS} accessibilityViewIsModal className="rounded-t-[28px] border-t border-white/30 px-4 pb-8 pt-5 dark:border-white/10">
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

function KeyAction({ icon, label, onPress }: { icon: typeof KeyRound; label: string; onPress: () => void }) {
  const { colors } = useTheme();
  const appGlassEnabled = useAppGlassEnabled();
  return <Button className={cn('h-14 justify-start rounded-xl px-3', appGlassEnabled && 'border')} style={appGlassEnabled ? appGlassControlStyle(false, colors) : undefined} variant="ghost" onPress={hapticPress(onPress)}><Icon as={icon} size={19} /><Text className="text-[15px] font-medium">{label}</Text></Button>;
}
