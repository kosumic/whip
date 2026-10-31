import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, View, TextInput } from 'react-native';
import Constants from 'expo-constants';
import {
  ArrowUp,
  Blocks,
  Check,
  Copy,
  ExternalLink,
  Link,
  Network,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  Unlink,
} from 'lucide-react-native';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';
import { Switch } from './ui/switch';
import { GlassSurface, useAppGlassEnabled } from './GlassSurface';
import { SyntaxCodeText } from './SyntaxCodeText';
import { DetailsInfoButton, DetailsTitle } from './SettingsDetails';
import { APP_FROSTED_GLASS_SURFACE_PROPS } from '../lib/appGlass';
import { cn } from '../lib/utils';
import { useTheme } from '../theme';
import {
  disableRemoteNotifications,
  enableRemoteNotifications,
  installNotificationPlugin,
  uninstallNotificationPlugin,
  setNotificationPluginEnabled,
  notificationPluginState,
  remoteNotificationStates,
  subscribeRemoteNotifications,
  remoteNotificationEncryption,
  setRemoteNotificationEncryption,
  DEFAULT_NOTIFICATION_E2EE,
  type RemoteNotificationState,
  type NotificationPluginState,
  type NotificationPluginInstallProgress,
} from '../services/remoteNotifications';
import type { HostProfile } from '../types';
import { useCopyFeedback } from '../hooks/useCopyFeedback';

const PLUGIN_SOURCE_URL = 'https://github.com/kosumic/whip/tree/main/whip-notify';
const DEFAULT_RELAY =
  (Constants.expoConfig?.extra?.notifyRelayUrl as string | undefined) || '';

const PLUGIN_ACTIONS = {
  install: {
    label: 'Install on host', pending: 'Installing…',
    accessibility: 'Install notification plugin', icon: Blocks,
  },
  upgrade: {
    label: 'Upgrade host plugin', pending: 'Upgrading…',
    accessibility: 'Upgrade notification plugin', icon: ArrowUp,
  },
} as const;

const PLUGIN_LIFECYCLE_ACTIONS = {
  enable: {
    label: 'Enable host plugin', pending: 'Enabling…',
    accessibility: 'Enable notification plugin', icon: Link,
  },
  disable: {
    label: 'Disable host plugin', pending: 'Disabling…',
    accessibility: 'Disable notification plugin', icon: Unlink,
  },
} as const;

const PLUGIN_INSTALL_STEPS = [
  { stage: 'checking-host', label: 'Check host and current plugin' },
  { stage: 'checking-release', label: 'Check platform and release availability' },
  { stage: 'downloading', label: 'Download and verify plugin' },
  { stage: 'enabling', label: 'Enable host plugin' },
  { stage: 'verifying', label: 'Verify installation' },
] as const;

function pluginActionFor(plugin: NotificationPluginState | undefined) {
  if (!plugin) return;
  if (!plugin.installed) return PLUGIN_ACTIONS.install;
  if (plugin.update_available) return PLUGIN_ACTIONS.upgrade;
}

type NotificationOperation =
  | 'install'
  | 'uninstall'
  | 'enable'
  | 'plugin'
  | 'encryption'
  | 'disable';

export function RemoteNotificationsSection({ host, connected = false }: { host: HostProfile; connected?: boolean }) {
  const appGlassEnabled = useAppGlassEnabled();
  const { colors, isDark } = useTheme();
  const commandTextClassName = appGlassEnabled
    ? 'text-foreground'
    : 'text-terminal-text';
  const commandMutedClassName = appGlassEnabled
    ? 'text-muted-foreground'
    : 'text-terminal-muted';
  const { copied, copyText } = useCopyFeedback();
  const [state, setState] = useState<RemoteNotificationState>();
  const [registrationLoaded, setRegistrationLoaded] = useState(false);
  const [encrypted, setEncrypted] = useState(DEFAULT_NOTIFICATION_E2EE);
  const [encryptionLoaded, setEncryptionLoaded] = useState(false);
  const [plugin, setPlugin] = useState<NotificationPluginState>();
  const [pluginChecked, setPluginChecked] = useState(false);
  const [pluginError, setPluginError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const refreshState = useRef<() => void>(() => {});
  const previousConnected = useRef(connected);
  const hostName = host.name || host.host;
  const installCommand = plugin?.install_command;
  const pluginAction = pluginActionFor(plugin);
  const pluginLifecycleAction = plugin?.enabled
    ? PLUGIN_LIFECYCLE_ACTIONS.disable
    : PLUGIN_LIFECYCLE_ACTIONS.enable;
  const pluginStatus = pluginError ||
    (plugin
      ? plugin.installed
        ? `Host plugin ${plugin.version || ''}${plugin.enabled ? '' : ' · disabled'}`
        : 'Host plugin not installed'
      : pluginChecked
        ? 'Connect to this host to check its plugin status'
        : 'Checking host plugin…');
  const [relay, setRelay] = useState(DEFAULT_RELAY);
  const [relaySettingsOpen, setRelaySettingsOpen] = useState(!DEFAULT_RELAY);
  const relayEdited = useRef(false);
  const [operation, setOperation] = useState<NotificationOperation>();
  const [installProgress, setInstallProgress] = useState<NotificationPluginInstallProgress>();
  const installScope = useRef({ active: true });
  const busy = operation !== undefined;
  const enabled = Boolean(state?.enabled);
  const enabling = operation === 'enable';
  const expanded = enabled || enabling;
  const installing = operation === 'install' || (enabling && Boolean(pluginAction));
  const installStepIndex = PLUGIN_INSTALL_STEPS.findIndex(step => step.stage === installProgress?.stage);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const progressScope = { active: true };
    installScope.current = progressScope;
    let latestRequest = 0;
    setState(undefined);
    setRegistrationLoaded(false);
    setOperation(undefined);
    setError(null);
    setPlugin(undefined);
    setInstallProgress(undefined);
    setPluginChecked(false);
    setPluginError(undefined);
    setEncrypted(DEFAULT_NOTIFICATION_E2EE);
    setEncryptionLoaded(false);
    relayEdited.current = false;
    setRelay(DEFAULT_RELAY);
    setRelaySettingsOpen(!DEFAULT_RELAY);
    const refresh = () => {
      const request = ++latestRequest;
      setRefreshing(true);
      void Promise.allSettled([
        remoteNotificationStates(),
        notificationPluginState(host.id),
        remoteNotificationEncryption(host.id),
      ]).then(([registration, hostPlugin, encryption]) => {
        if (!mounted || request !== latestRequest) return;
        setRefreshing(false);
        if (registration.status === 'fulfilled') {
          const current = registration.value.find(
            item => item.hostId === host.id,
          );
          setState(current);
          setRegistrationLoaded(true);
          if (current?.relayUrl && !relayEdited.current) {
            setRelay(current.relayUrl);
            if (current.relayUrl !== DEFAULT_RELAY) setRelaySettingsOpen(true);
          }
        } else {
          setError('Could not read notification registrations');
        }
        if (hostPlugin.status === 'fulfilled') {
          setPlugin(hostPlugin.value);
          setPluginError(undefined);
        } else {
          setPlugin(undefined);
          const reason = hostPlugin.reason instanceof Error
            ? hostPlugin.reason.message : String(hostPlugin.reason);
          setPluginError(`Could not check host plugin: ${reason}`);
        }
        setPluginChecked(true);
        if (encryption.status === 'fulfilled') {
          setEncrypted(encryption.value);
          setEncryptionLoaded(true);
        } else {
          setEncryptionLoaded(false);
          setError('Could not read notification encryption setting');
        }
      });
    };
    refreshState.current = refresh;
    refresh();
    const unsubscribe = subscribeRemoteNotifications(refresh);
    return () => {
      mounted = false;
      progressScope.active = false;
      unsubscribe();
    };
  }, [host.id]);
  useEffect(() => {
    if (previousConnected.current === connected) return;
    previousConnected.current = connected;
    refreshState.current();
  }, [connected]);
  const run = async (
    pending: NotificationOperation,
    action: () => Promise<void>,
  ) => {
    const scope = installScope.current;
    setOperation(pending);
    setError(null);
    setInstallProgress(undefined);
    try {
      await action();
    } catch (failure) {
      if (scope.active) setError(String(failure));
    } finally {
      if (scope.active) setOperation(undefined);
    }
  };
  const installPlugin = () => {
    const scope = installScope.current;
    return installNotificationPlugin(host.id, progress => {
      if (scope.active) setInstallProgress(progress);
    });
  };
  const install = () => run('install', installPlugin);
  const toggleNotifications = (value: boolean) => {
    if (busy || value === enabled) return;
    if (!value) return run('disable', () => disableRemoteNotifications(host.id, true));
    const scope = installScope.current;
    return run('enable', async () => {
      if (state) await disableRemoteNotifications(host.id, true);
      if (!scope.active) return;
      if (pluginAction) await installPlugin();
      else if (plugin && !plugin.enabled) await setNotificationPluginEnabled(host.id, true);
      if (!scope.active) return;
      await enableRemoteNotifications(host.id, relay, encrypted);
    });
  };
  return (
    <View className="gap-3 p-4">
      <View className="flex-row items-center gap-2">
        <Icon
          as={ShieldCheck}
          size={20}
          className="text-primary"
          accessible={false}
        />
        <Text
          accessibilityRole="header"
          className="min-w-0 flex-1 font-semibold"
        >
          Server-side push notification
        </Text>
        {busy ? <ActivityIndicator size="small" accessible={false} /> : null}
        <Switch
          accessibilityLabel={`Push notifications for ${hostName}`}
          accessibilityHint="Enable push notifications on this device and expand settings, or disable them and collapse settings."
          accessibilityState={{ busy }}
          checked={expanded}
          disabled={busy || !registrationLoaded || (!enabled && (!plugin || !encryptionLoaded))}
          onCheckedChange={toggleNotifications}
        />
      </View>
      <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
        {enabling
          ? 'Enabling push notifications… Keep Whip open for verification.'
          : operation === 'disable'
            ? 'Disabling push notifications…'
            : !registrationLoaded
              ? 'Loading push notification settings…'
              : enabled
                ? 'Enabled on this device. Receive notifications when Whip is not running.'
                : !plugin
                  ? pluginError || (connected
                    ? 'Host connected. Refresh host status to check push notification support.'
                    : 'Connect to this host to enable push notifications.')
                  : 'Disabled on this device. Whip uses local notifications.'}
      </Text>
      {!plugin && pluginChecked ? (
        <Button
          variant="outline"
          disabled={busy || refreshing}
          accessibilityLabel={`Refresh notification host status for ${hostName}`}
          accessibilityState={{ busy: refreshing }}
          onPress={() => {
            setError(null);
            refreshState.current();
          }}
        >
          {refreshing ? <ActivityIndicator size="small" accessible={false} /> : <Icon as={RefreshCw} size={17} accessible={false} />}
          <Text>{refreshing ? 'Checking host…' : 'Refresh host status'}</Text>
        </Button>
      ) : null}
      {expanded ? (
        <View className="gap-3">
          <View className="flex-row items-center gap-3">
            <View className="min-w-0 flex-1">
              <DetailsTitle
                title="End-to-end encryption (E2EE)"
                titleClassName="text-sm font-medium"
                copy={encrypted
                  ? 'Only this device can read agent details. Push previews show a generic update.'
                  : 'Show the tab, agent and status in push previews, plus the task title when available. The relay and push providers can read these details.'}
              />
            </View>
            <Switch
              accessibilityLabel={`End-to-end encryption for ${hostName}`}
              checked={encrypted}
              disabled={busy || !encryptionLoaded || Boolean(state?.enabled && !state.connected)}
              onCheckedChange={value => run('encryption', () => setRemoteNotificationEncryption(host.id, value))}
            />
          </View>
          {state?.enabled && !state.connected ? (
            <Text className="text-xs text-muted-foreground">Connect to this host to change encryption.</Text>
          ) : null}
          <Text className="text-sm text-muted-foreground">
            Push delivery uses{' '}
            {Platform.OS === 'android'
              ? 'Firebase Cloud Messaging (FCM)'
              : 'Apple Push Notification service (APNs)'}.
          </Text>
          <Button
            variant="link"
            accessibilityLabel="Notification relay settings"
            onPress={() => setRelaySettingsOpen(open => !open)}
          >
            <Icon as={Network} size={17} accessible={false} />
            <Text>Custom relay</Text>
          </Button>
          {relaySettingsOpen ? (
            <TextInput
              accessibilityLabel="Notification relay URL"
              placeholder="HTTPS relay URL"
              value={relay}
              onChangeText={value => {
                relayEdited.current = true;
                setRelay(value);
              }}
              autoCapitalize="none"
              className="rounded border border-border p-2 text-foreground"
            />
          ) : null}
          <View className="gap-2">
            {plugin?.installed ? (
              <Text className="text-sm text-muted-foreground">{pluginStatus}</Text>
            ) : (
              <DetailsTitle
                title={pluginStatus}
                titleClassName="text-sm text-muted-foreground"
                copy={`Run on ${hostName}, or let Whip run this command over SSH using the button below.`}
              />
            )}
            {installCommand && (!plugin?.installed || plugin.update_available) ? (
              <View className="gap-2">
                <GlassSurface
                  {...APP_FROSTED_GLASS_SURFACE_PROPS}
                  className="rounded-xl border border-white/30 dark:border-white/10"
                  fallbackClassName="bg-black"
                >
                  <View className="flex-row items-center gap-2 border-b border-white/15 pl-4 pr-1">
                    <Icon
                      as={Terminal}
                      size={15}
                      className={commandMutedClassName}
                      accessible={false}
                    />
                    <Text
                      className={cn(
                        'min-w-0 flex-1 text-xs font-medium',
                        commandMutedClassName,
                      )}
                    >
                      Install command
                    </Text>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="active:bg-white/10 dark:active:bg-white/10"
                      accessibilityLabel={
                        copied
                          ? 'Notification plugin install command copied'
                          : 'Copy notification plugin install command'
                      }
                      accessibilityLiveRegion="polite"
                      onPress={() => copyText(installCommand)}
                    >
                      <Icon
                        as={copied ? Check : Copy}
                        size={15}
                        className={commandTextClassName}
                        accessible={false}
                      />
                    </Button>
                  </View>
                  <View className="flex-row items-start gap-3 p-4">
                    <Text
                      accessible={false}
                      className={cn(
                        'font-mono text-xs leading-5',
                        appGlassEnabled ? 'text-primary' : 'text-terminal-accent',
                      )}
                    >
                      $
                    </Text>
                    <Text
                      selectable
                      className={cn(
                        'min-w-0 flex-1 font-mono text-xs leading-5',
                        commandTextClassName,
                      )}
                    >
                      <SyntaxCodeText
                        content={installCommand}
                        filename="install.sh"
                        isDark={!appGlassEnabled || isDark}
                        backgroundColor={appGlassEnabled ? colors.surface : '#000000'}
                      />
                    </Text>
                  </View>
                </GlassSurface>
              </View>
            ) : null}
            <Button
              variant="link"
              accessibilityRole="link"
              accessibilityLabel="View notification plugin source on GitHub"
              onPress={() => {
                Linking.openURL(PLUGIN_SOURCE_URL).catch(failure => setError(String(failure)));
              }}
            >
              <Icon as={ExternalLink} size={17} accessible={false} />
              <Text>Plugin source on GitHub</Text>
            </Button>
            <View className="flex-row flex-wrap gap-2">
              {pluginAction ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  accessibilityLabel={`${pluginAction.accessibility} on ${hostName}`}
                  accessibilityState={{ busy: installing }}
                  onPress={install}
                >
                  {installing ? (
                    <ActivityIndicator size="small" accessible={false} />
                  ) : (
                    <Icon as={pluginAction.icon} size={17} accessible={false} />
                  )}
                  <Text accessibilityLiveRegion="polite">
                    {installing ? pluginAction.pending : pluginAction.label}
                  </Text>
                </Button>
              ) : null}
              {plugin?.installed ? (
                <View className="flex-row items-center">
                  <Button
                    variant="outline"
                    disabled={busy}
                    accessibilityLabel={`${pluginLifecycleAction.accessibility} on ${hostName}`}
                    accessibilityState={{ busy: operation === 'plugin' }}
                    onPress={() => run('plugin', () => setNotificationPluginEnabled(host.id, !plugin.enabled))}
                  >
                    {operation === 'plugin' ? (
                      <ActivityIndicator size="small" accessible={false} />
                    ) : (
                      <Icon as={pluginLifecycleAction.icon} size={17} accessible={false} />
                    )}
                    <Text>{operation === 'plugin' ? pluginLifecycleAction.pending : pluginLifecycleAction.label}</Text>
                  </Button>
                  <DetailsInfoButton
                    title={pluginLifecycleAction.label}
                    copy="Enable or pause push notification hooks for all devices and Herdr sessions using this SSH account. The installation and saved registrations are retained."
                  />
                </View>
              ) : null}
              {plugin?.installed ? (
                <View className="flex-row items-center">
                  <Button
                    variant="outline"
                    disabled={busy}
                    accessibilityLabel={`Uninstall notification plugin from ${hostName}`}
                    onPress={() =>
                      run('uninstall', () => uninstallNotificationPlugin(host.id))
                    }
                  >
                    <Icon as={Trash2} size={17} accessible={false} />
                    <Text>Uninstall from host</Text>
                  </Button>
                  <DetailsInfoButton
                    title="Uninstall from host"
                    copy="Host uninstall stops remote push for all devices and Herdr sessions using this SSH account. Saved host configuration is retained for reinstall."
                  />
                </View>
              ) : null}
            </View>
            {installing || installProgress ? (
              <View accessibilityLabel="Notification plugin installation progress" className="gap-2">
                {installProgress ? (
                  <>
                    <Text className="text-xs text-muted-foreground">
                      {Math.floor(installProgress.elapsed_ms / 1000)}s elapsed
                      {installProgress.running
                        ? ` · stops after ${Math.round(installProgress.timeout_ms / 60000)} minutes`
                        : ''}
                    </Text>
                    {PLUGIN_INSTALL_STEPS.map((step, index) => {
                      const current = installProgress.stage === step.stage;
                      const complete = installProgress.completed_stages.includes(step.stage);
                      if (!complete && (index < installStepIndex || installProgress.stage === 'complete')) return null;
                      const status = complete ? 'complete' : current ? (installProgress.error ? 'failed' : 'in progress') : 'pending';
                      return (
                        <View key={step.stage} className="flex-row items-center gap-2">
                          {complete ? (
                            <Icon as={Check} size={14} className="text-primary" accessible={false} />
                          ) : (
                            <View className={cn('size-3.5 rounded-full border', current ? 'border-primary bg-primary/20' : 'border-muted-foreground/40')} />
                          )}
                          <Text
                            accessibilityLabel={`${step.label}: ${status}`}
                            accessibilityLiveRegion={current ? 'polite' : undefined}
                            className={cn('text-xs', current ? 'font-medium' : 'text-muted-foreground', current && installProgress.error && 'text-destructive')}
                          >
                            {step.label}
                            {current && installProgress.error ? ' · failed' : ''}
                          </Text>
                        </View>
                      );
                    })}
                    {installProgress.stage === 'complete' ? (
                      <Text accessibilityLiveRegion="polite" className="text-xs text-primary">
                        Plugin installed and enabled.
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
                    Waiting to start installation…
                  </Text>
                )}
              </View>
            ) : null}
          </View>
        </View>
      ) : null}
      {!expanded && state ? (
        <View className="gap-2">
          <Text className="text-xs text-muted-foreground">
            {state.pendingHostRemoval && !state.connected
              ? connected
                ? 'Push is off on this device. Refresh host status to resume cleanup on the connected host.'
                : 'Push is off on this device. Host cleanup will resume when this host is connected.'
              : 'Push is off on this device. Retry cleanup to finish removing its registration.'}
          </Text>
          <Button
            variant="outline"
            disabled={busy}
            accessibilityLabel={`Retry disabling push notifications for ${hostName}`}
            onPress={() => run('disable', () => disableRemoteNotifications(host.id, true))}
          >
            <Text>Retry cleanup</Text>
          </Button>
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
