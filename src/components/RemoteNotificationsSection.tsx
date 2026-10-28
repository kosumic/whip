import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, View, TextInput } from 'react-native';
import Constants from 'expo-constants';
import {
  BellOff,
  BellRing,
  Blocks,
  Check,
  Copy,
  ExternalLink,
  Network,
  Power,
  ShieldCheck,
  Trash2,
  Unplug,
} from 'lucide-react-native';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';
import {
  disableRemoteNotifications,
  enableRemoteNotifications,
  installNotificationPlugin,
  uninstallNotificationPlugin,
  notificationPluginState,
  remoteNotificationStates,
  subscribeRemoteNotifications,
  type RemoteNotificationState,
  type NotificationPluginState,
} from '../services/remoteNotifications';
import type { HostProfile } from '../types';
import { useCopyFeedback } from '../hooks/useCopyFeedback';

const PLUGIN_SOURCE_URL = 'https://github.com/kosumic/whip/tree/main/whip-notify';
const DEFAULT_RELAY =
  (Constants.expoConfig?.extra?.notifyRelayUrl as string | undefined) || '';

type NotificationOperation =
  | 'install'
  | 'uninstall'
  | 'enable'
  | 'disable'
  | 'unregister';

export function RemoteNotificationsSection({ host }: { host: HostProfile }) {
  const { copied, copyText } = useCopyFeedback();
  const [state, setState] = useState<RemoteNotificationState>();
  const [plugin, setPlugin] = useState<NotificationPluginState>();
  const [pluginError, setPluginError] = useState<string>();
  const hostName = host.name || host.host;
  const installCommand = plugin?.install_command;
  const [relay, setRelay] = useState(DEFAULT_RELAY);
  const [relaySettingsOpen, setRelaySettingsOpen] = useState(!DEFAULT_RELAY);
  const relayEdited = useRef(false);
  const [operation, setOperation] = useState<NotificationOperation>();
  const busy = operation !== undefined;
  const installing = operation === 'install';
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    let latestRequest = 0;
    const refresh = () => {
      const request = ++latestRequest;
      void Promise.allSettled([
        remoteNotificationStates(),
        notificationPluginState(host.id),
      ]).then(([registration, hostPlugin]) => {
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
      });
    };
    refresh();
    const unsubscribe = subscribeRemoteNotifications(refresh);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [host.id]);
  const run = async (
    pending: NotificationOperation,
    action: () => Promise<void>,
  ) => {
    setOperation(pending);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setOperation(undefined);
    }
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
      <Text>
        {hostName}
        {state?.enabled ? ' · enabled on this device' : ''}
        {state?.pendingHostRemoval ? ' · host cleanup pending' : ''}
      </Text>
      <Text className="text-sm font-medium">
        End-to-end encrypted (E2EE) from your host to this device. Push delivery
        uses{' '}
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
        <Text className="text-sm text-muted-foreground">
          {pluginError ||
            (plugin
              ? plugin.installed
                ? `Host plugin ${plugin.version || ''}${plugin.enabled ? '' : ' · disabled'}`
                : 'Host plugin not installed'
              : 'Connect to this host to manage its plugin')}
        </Text>
        {installCommand ? (
          <View className="gap-2">
            <View className="flex-row items-center justify-between gap-2">
              <Text className="min-w-0 flex-1 text-sm font-medium">
                Install command
              </Text>
              <Button
                variant="ghost"
                accessibilityLabel="Copy notification plugin install command"
                onPress={() => copyText(installCommand)}
              >
                <Icon as={copied ? Check : Copy} size={17} accessible={false} />
                <Text accessibilityLiveRegion="polite">{copied ? 'Copied' : 'Copy'}</Text>
              </Button>
            </View>
            <Text selectable className="rounded border border-border bg-muted p-3 font-mono text-xs">
              {installCommand}
            </Text>
            <Text className="text-xs text-muted-foreground">
              Run on {hostName}, or use Install on host below. Whip runs this
              command over SSH, then enables the host plugin.
            </Text>
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
          <Button
            variant="outline"
            disabled={busy || !plugin || plugin.enabled}
            accessibilityLabel={`Install notification plugin on ${hostName}`}
            accessibilityState={{ busy: installing }}
            onPress={() => run('install', () => installNotificationPlugin(host.id))}
          >
            {installing ? (
              <ActivityIndicator size="small" accessible={false} />
            ) : (
              <Icon
                as={
                  plugin?.enabled ? Check : plugin?.installed ? Power : Blocks
                }
                size={17}
                accessible={false}
              />
            )}
            <Text accessibilityLiveRegion="polite">
              {installing
                ? plugin?.installed
                  ? 'Enabling…'
                  : 'Installing…'
                : plugin?.enabled
                  ? 'Host plugin enabled'
                  : plugin?.installed
                    ? 'Enable host plugin'
                    : 'Install on host'}
            </Text>
          </Button>
          {plugin?.installed ? (
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
          ) : null}
        </View>
        {plugin?.installed ? (
          <Text className="text-xs text-muted-foreground">
            Host uninstall stops remote push for all devices and Herdr sessions
            using this SSH account. Saved host configuration is retained for
            reinstall.
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          <Button
            disabled={busy || (!state?.enabled && !plugin?.enabled)}
            accessibilityLabel={`${state?.enabled ? 'Disable' : 'Enable'} remote notifications on ${hostName}`}
            onPress={() =>
              run(state?.enabled ? 'disable' : 'enable', () =>
                state?.enabled
                  ? disableRemoteNotifications(host.id)
                  : enableRemoteNotifications(host.id, relay),
              )
            }
          >
            <Icon
              as={state?.enabled ? BellOff : BellRing}
              size={17}
              accessible={false}
            />
            <Text>{state?.enabled ? 'Disable' : 'Enable / rotate keys'}</Text>
          </Button>
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
