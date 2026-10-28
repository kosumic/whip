import { useEffect, useState } from 'react';
import { View, TextInput } from 'react-native';
import Constants from 'expo-constants';
import { Button } from './ui/button';
import { Text } from './ui/text';
import { loadHostProfiles } from '../services/hostProfiles';
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

export function RemoteNotificationsSection() {
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [states, setStates] = useState<RemoteNotificationState[]>([]);
  const [plugins, setPlugins] = useState<
    Record<string, NotificationPluginState | undefined>
  >({});
  const [pluginErrors, setPluginErrors] = useState<Record<string, string>>({});
  const [relay, setRelay] = useState(
    (Constants.expoConfig?.extra?.notifyRelayUrl as string | undefined) || '',
  );
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    let latestRequest = 0;
    const refresh = () => {
      const request = ++latestRequest;
      void Promise.all([loadHostProfiles(), remoteNotificationStates()])
        .then(async ([saved, remote]) => {
          if (mounted && request === latestRequest) {
            setHosts(saved);
            setStates(remote);
          }
          const statuses = await Promise.all(
            saved.map(async host => {
              try {
                return {
                  id: host.id,
                  status: await notificationPluginState(host.id),
                };
              } catch {
                return {
                  id: host.id,
                  error:
                    'Plugin support unavailable; requires Herdr 0.9.5 or newer',
                };
              }
            }),
          );
          if (mounted && request === latestRequest) {
            setPlugins(
              Object.fromEntries(statuses.map(item => [item.id, item.status])),
            );
            setPluginErrors(
              Object.fromEntries(
                statuses
                  .filter(item => item.error)
                  .map(item => [item.id, item.error!]),
              ),
            );
          }
        })
        .catch(() => {
          if (mounted && request === latestRequest)
            setError('Could not read notification registrations');
        });
    };
    refresh();
    const unsubscribe = subscribeRemoteNotifications(refresh);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 border-t border-border p-4">
      <Text className="font-semibold">Encrypted remote notifications</Text>
      <Text className="text-sm text-muted-foreground">
        Connect to a saved host, install its plugin here, then enable push for
        this device. Installation needs Herdr 0.9.5 or newer, Git and a current
        stable Rust toolchain on that host. The first build can take several
        minutes. Delivery switches automatically when local monitoring stops.
      </Text>
      <TextInput
        accessibilityLabel="Notification relay URL"
        placeholder="HTTPS relay URL"
        value={relay}
        onChangeText={setRelay}
        autoCapitalize="none"
        className="rounded border border-border p-2 text-foreground"
      />
      <TextInput
        accessibilityLabel="Relay enrollment code"
        placeholder="Relay enrollment code"
        value={invite}
        onChangeText={setInvite}
        secureTextEntry
        autoCapitalize="none"
        className="rounded border border-border p-2 text-foreground"
      />
      {hosts.map(host => {
        const state = states.find(item => item.hostId === host.id);
        const plugin = plugins[host.id];
        return (
          <View key={host.id} className="gap-2">
            <Text>
              {host.name || host.host}
              {state?.enabled ? ' · enabled' : ''}
              {state?.pendingHostRemoval ? ' · host cleanup pending' : ''}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {pluginErrors[host.id] ||
                (plugin
                  ? plugin.installed
                    ? `Host plugin ${plugin.version || ''}${plugin.enabled ? '' : ' · disabled'}`
                    : 'Host plugin not installed'
                  : 'Connect to this host to manage its plugin')}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={busy || !plugin || plugin.enabled}
                accessibilityLabel={`Install notification plugin on ${host.name || host.host}`}
                onPress={() => run(() => installNotificationPlugin(host.id))}
              >
                <Text>
                  {plugin?.enabled
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
                  accessibilityLabel={`Uninstall notification plugin from ${host.name || host.host}`}
                  onPress={() =>
                    run(() => uninstallNotificationPlugin(host.id))
                  }
                >
                  <Text>Uninstall from host</Text>
                </Button>
              ) : null}
            </View>
            {plugin?.installed ? (
              <Text className="text-xs text-muted-foreground">
                Host uninstall stops remote push for all devices and Herdr
                sessions using this SSH account. Saved host configuration is
                retained for reinstall.
              </Text>
            ) : null}
            <View className="flex-row gap-2">
              <Button
                disabled={busy || (!state?.enabled && !plugin?.enabled)}
                onPress={() =>
                  run(() =>
                    state?.enabled
                      ? disableRemoteNotifications(host.id)
                      : enableRemoteNotifications(host.id, relay, invite),
                  )
                }
              >
                <Text>
                  {state?.enabled ? 'Disable' : 'Enable / rotate keys'}
                </Text>
              </Button>
              {state ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onPress={() =>
                    run(() => disableRemoteNotifications(host.id, true))
                  }
                >
                  <Text>Unregister</Text>
                </Button>
              ) : null}
            </View>
          </View>
        );
      })}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
