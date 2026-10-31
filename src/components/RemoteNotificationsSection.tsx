import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, View, TextInput } from 'react-native';
import Constants from 'expo-constants';
import {
  ArrowUp,
  BellRing,
  Blocks,
  Check,
  Copy,
  ExternalLink,
  Network,
  Power,
  ShieldCheck,
  Terminal,
  Trash2,
  Unplug,
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
  enable: {
    label: 'Enable host plugin', pending: 'Enabling…',
    accessibility: 'Enable notification plugin', icon: Power,
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
  if (!plugin.enabled) return PLUGIN_ACTIONS.enable;
}

type NotificationOperation =
  | 'install'
  | 'uninstall'
  | 'enable'
  | 'encryption'
  | 'unregister';

export function RemoteNotificationsSection({ host }: { host: HostProfile }) {
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
  const [encrypted, setEncrypted] = useState(DEFAULT_NOTIFICATION_E2EE);
  const [encryptionLoaded, setEncryptionLoaded] = useState(false);
  const [plugin, setPlugin] = useState<NotificationPluginState>();
  const [pluginChecked, setPluginChecked] = useState(false);
  const [pluginError, setPluginError] = useState<string>();
  const hostName = host.name || host.host;
  const installCommand = plugin?.install_command;
  const pluginAction = pluginActionFor(plugin);
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
  const installing = operation === 'install';
  const installStepIndex = PLUGIN_INSTALL_STEPS.findIndex(step => step.stage === installProgress?.stage);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const progressScope = { active: true };
    installScope.current = progressScope;
    let latestRequest = 0;
    setState(undefined);
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
      void Promise.allSettled([
        remoteNotificationStates(),
        notificationPluginState(host.id),
        remoteNotificationEncryption(host.id),
      ]).then(([registration, hostPlugin, encryption]) => {
        if (!mounted || request !== latestRequest) return;
        if (registration.status === 'fulfilled') {
          const current = registration.value.find(
            item => item.hostId === host.id,
          );
          setState(current);
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
          setPluginError(
            'Plugin support unavailable; requires Herdr 0.9.5 or newer',
          );
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
    refresh();
    const unsubscribe = subscribeRemoteNotifications(refresh);
    return () => {
      mounted = false;
      progressScope.active = false;
      unsubscribe();
    };
  }, [host.id]);
  const run = async (
    pending: NotificationOperation,
    action: () => Promise<void>,
  ) => {
    setOperation(pending);
    setError(null);
    setInstallProgress(undefined);
    try {
      await action();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setOperation(undefined);
    }
  };
  const install = () => {
    const scope = installScope.current;
    return run('install', () => installNotificationPlugin(host.id, progress => {
      if (scope.active) setInstallProgress(progress);
    }));
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
      </View>
      <Text className="text-sm text-muted-foreground">
        Whip uses local notifications by default. Enable push notifications to
        receive notifications when Whip is not running.
      </Text>
      <Text>
        {hostName}
        {state?.enabled ? ' · enabled on this device' : ''}
        {state?.pendingHostRemoval ? ' · host cleanup pending' : ''}
      </Text>
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
                accessibilityLabel={`Uninstall notification plugin from ${hostName}`}
                onPress={() =>
                  run('uninstall', () => uninstallNotificationPlugin(host.id))
                }
              >
                <Icon as={Unplug} size={17} accessible={false} />
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
        <View className="flex-row flex-wrap gap-2">
          {plugin && !state?.enabled ? (
            <Button
              disabled={busy || !plugin?.enabled || !encryptionLoaded}
              accessibilityLabel={`Enable remote notifications on ${hostName}`}
              onPress={() =>
                run('enable', () => enableRemoteNotifications(host.id, relay, encrypted))
              }
            >
              <Icon as={BellRing} size={17} accessible={false} />
              <Text>Enable / rotate keys</Text>
            </Button>
          ) : null}
          {state ? (
            <Button
              variant="outline"
              disabled={busy}
              accessibilityLabel={`Unregister remote notifications from ${hostName}`}
              onPress={() =>
                run('unregister', () => disableRemoteNotifications(host.id, true))
              }
            >
              <Icon as={Trash2} size={17} accessible={false} />
              <Text>Unregister</Text>
            </Button>
          ) : null}
        </View>
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
