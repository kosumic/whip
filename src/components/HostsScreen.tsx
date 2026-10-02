import { AlertCircle, Bot, Ellipsis, LockKeyhole, LogIn, LogOut, Network, Plus, Server, ServerOff, Trash2 } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { PanResponder, Platform, ScrollView, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { orderByConnectionAndAgentStatusPriority } from '@/src/herdQueue';
import { DEFAULT_SSH_PORT, hostDisplayName } from '@/src/lib/hostProfiles';
import type { HostRuntimeSummary } from '@/src/lib/hostRuntimeSummary';
import { DEFAULT_SPRING_CONFIG } from '@/src/lib/motion';
import {
  HOST_SWIPE_ACTION_WIDTH,
  hostSwipeOffset,
  shouldClaimHostSwipe,
  shouldOpenHostSwipe,
} from '@/src/lib/hostSwipeActions';
import type { CredentialRecoveryStatus } from '@/src/services/credentialVault';
import { statusColor, useTheme } from '@/src/theme';
import type { HostProfile } from '@/src/types';
import { AgentStatusMedallion, hapticPress, HerdrMark, IconButton, ScreenHeader, StatusBadge, WhipMark } from './app-ui';
import { GlassSurface } from './GlassSurface';
import { Button } from './ui/button';
import { Icon } from './ui/icon';
import { Text } from './ui/text';

interface Props {
  hosts: HostProfile[];
  connectingHostIds?: string[];
  error: string | null;
  activeHostId?: string | null;
  connectedHostIds?: string[];
  latencyMsByHostId?: Record<string, number | null | undefined>;
  runtimeByHostId?: Record<string, HostRuntimeSummary | undefined>;
  credentialRecovery: CredentialRecoveryStatus;
  credentialRecoveryBusy: boolean;
  onAdd: () => void;
  onConnect: (host: HostProfile) => void;
  onDelete: (host: HostProfile) => void;
  onDisconnect: (host: HostProfile) => void;
  onEdit: (host: HostProfile) => void;
  onUnlockCredentials: () => Promise<boolean>;
}

export function HostsScreen({ hosts, connectingHostIds = [], error, activeHostId, connectedHostIds = [], latencyMsByHostId = {}, runtimeByHostId = {}, credentialRecovery, credentialRecoveryBusy, onAdd, onConnect, onDelete, onDisconnect, onEdit, onUnlockCredentials }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const connectingHostIdSet = new Set(connectingHostIds);
  const connectedHostIdSet = new Set(connectedHostIds);
  const hostsById = new Map(hosts.map(host => [host.id, host]));
  const orderedHosts = orderByConnectionAndAgentStatusPriority(
    hosts,
    host => connectedHostIdSet.has(host.id),
    host => runtimeByHostId[host.id]?.agentStatus ?? 'unknown',
  );
  return (
    <View className="flex-1">
      <ScreenHeader
        title="Whip"
        subtitle={t('hosts.subtitle')}
        left={<WhipMark size={40} />}
        right={<IconButton icon={Plus} accessibilityLabel={t('hosts.add')} onPress={onAdd} />}
      />

      {error ? (
        <View
          accessibilityLiveRegion="polite"
          className="mx-4 mt-4 flex-row items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-3">
          <Icon as={AlertCircle} className="text-destructive" size={18} />
          <View className="min-w-0 flex-1">
            <Text className="text-sm font-semibold text-destructive">{t('hosts.errorTitle')}</Text>
            <Text className="mt-0.5 text-[13px] leading-[18px] text-destructive">{error}</Text>
          </View>
        </View>
      ) : null}

      {Platform.OS === 'android' && credentialRecovery.state === 'locked' ? (
        <GlassSurface className="mx-4 mt-4 flex-row items-center gap-3 rounded-lg border border-white/30 p-3.5 dark:border-white/10">
          <View className="size-10 items-center justify-center rounded-full bg-primary/10"><Icon as={LockKeyhole} className="text-primary" size={19} /></View>
          <View className="min-w-0 flex-1"><Text className="text-sm font-semibold">{t('hosts.recoveryLocked')}</Text><Text className="mt-0.5 text-xs leading-[17px] text-muted-foreground">{t('hosts.recoveryCopy', { count: credentialRecovery.count })}</Text></View>
          <Button className="rounded-full px-3.5" size="sm" disabled={credentialRecoveryBusy} onPress={hapticPress(async () => { await onUnlockCredentials(); })}><Text>{credentialRecoveryBusy ? t('hosts.unlocking') : t('hosts.unlock')}</Text></Button>
        </GlassSurface>
      ) : null}

      {Platform.OS === 'android' && credentialRecovery.state === 'unavailable' ? (
        <View className="mx-4 mt-4 flex-row items-start gap-2 rounded-md bg-destructive/10 p-3">
          <Icon as={AlertCircle} className="text-destructive" size={18} />
          <Text className="flex-1 text-[13px] leading-[18px] text-destructive">{t('hosts.recoveryUnavailable')}</Text>
        </View>
      ) : null}

      <ScrollView className="flex-1">
        <View className="flex-grow p-4 pb-6">
          {hosts.length === 0 ? (
            <View className="min-h-[440px] flex-1 items-center justify-center px-7">
              <View className="size-[72px] items-center justify-center rounded-full bg-muted"><Icon as={Server} size={30} /></View>
              <Text className="mt-5 text-[22px] font-semibold leading-7">{t('hosts.emptyTitle')}</Text>
              <Text className="mt-2 max-w-[310px] text-center text-[15px] leading-[22px] text-muted-foreground">{t('hosts.emptyCopy')}</Text>
              <Button className="mt-6 rounded-full" onPress={hapticPress(onAdd)}><Icon as={Plus} className="text-primary-foreground" size={17} /><Text>{t('hosts.addFirst')}</Text></Button>
            </View>
          ) : (
            <>
              <Text className="mb-3 px-1 text-sm font-semibold text-muted-foreground">{t('hosts.count', { count: hosts.length })}</Text>
              <View className="gap-3">
                {orderedHosts.map(host => {
                  const connecting = connectingHostIdSet.has(host.id);
                  const active = activeHostId === host.id;
                  const connected = connectedHostIdSet.has(host.id);
                  const state = connecting ? 'working' : connected ? 'done' : 'idle';
                  const label = connecting ? t('hosts.opening') : active && connected ? t('hosts.active') : connected ? t('hosts.open') : t('hosts.offline');
                  const displayName = hostDisplayName(host);
                  const jumpHost = host.jumpHostId ? hostsById.get(host.jumpHostId) : undefined;
                  const latencyMs = latencyMsByHostId[host.id];
                  const runtime = connected ? runtimeByHostId[host.id] : undefined;
                  return (
                    <SwipeableHostRow
                      key={host.id}
                      connected={connected}
                      connecting={connecting}
                      displayName={displayName}
                      onConnect={() => onConnect(host)}
                      onDelete={() => onDelete(host)}
                      onDisconnect={() => onDisconnect(host)}>
                      {({ closeActions, actionsOpen }) => (
                        <GlassSurface className="min-h-[88px] flex-row items-center rounded-lg border border-white/30 pr-2 dark:border-white/10">
                          <Button
                            accessibilityLabel={t('hosts.connectTo', { host: displayName })}
                            className="h-auto min-h-[88px] min-w-0 flex-1 self-stretch justify-start gap-3 rounded-none px-3 py-3 sm:h-auto"
                            size="content"
                            variant="ghost"
                            onPress={hapticPress(() => {
                              if (actionsOpen) closeActions();
                              else onConnect(host);
                            })}>
                            <AgentStatusMedallion
                              accessibilityLabel={runtime
                                ? t('hosts.agentStatus', { status: t(`status.${runtime.agentStatus}`) })
                                : t('status.disconnected')}
                              status={runtime?.agentStatus ?? 'unknown'}
                              connected={connected}
                              color={runtime
                                ? statusColor(runtime.agentStatus, colors)
                                : colors.textSecondary}
                              icon={runtime ? undefined : ServerOff}
                            />
                            <View className="min-w-0 flex-1">
                              <View className="flex-row items-center gap-2"><Text className="flex-1 text-base font-semibold" numberOfLines={1}>{displayName}</Text><StatusBadge status={state} label={label} /></View>
                              <View className="mt-1 flex-row items-center gap-2">
                                <Text className="min-w-0 flex-1 text-[13px] leading-[18px] text-muted-foreground" numberOfLines={1}>{host.username}@{host.host}{host.port !== DEFAULT_SSH_PORT ? `:${host.port}` : ''}</Text>
                                <Text accessibilityLabel={latencyMs == null ? t('hosts.latencyUnavailable') : t('hosts.latency', { value: latencyMs })} className="text-[11px] leading-[18px] text-muted-foreground/70">{latencyMs == null ? '— ms' : `${latencyMs} ms`}</Text>
                              </View>
                              <Text className="mt-0.5 text-[11px] leading-[15px] text-muted-foreground/70" numberOfLines={1}>
                                {host.authMode === 'key' ? t('hosts.sshKey') : t('hosts.password')}
                                {!connected && host.lastConnectedAt
                                  ? ` · ${t('hosts.lastConnected', { value: formatLastUsed(host.lastConnectedAt, t) })}`
                                  : ''}
                              </Text>
                              {host.jumpHostId || connected ? (
                                <View className="mt-1.5 flex-row flex-wrap items-center gap-x-2.5 gap-y-1">
                                  {host.jumpHostId ? (
                                    <View
                                      accessible
                                      accessibilityLabel={t('hosts.jumpHost', {
                                        host: jumpHost ? hostDisplayName(jumpHost) : t('hosts.jumpHostUnavailable'),
                                      })}
                                      className="flex-row items-center gap-1">
                                      <Icon as={Network} className="text-muted-foreground" size={11} />
                                      <Text className="text-[10px] font-semibold leading-[15px] text-muted-foreground">
                                        {jumpHost ? hostDisplayName(jumpHost) : t('hosts.jumpHostUnavailable')}
                                      </Text>
                                    </View>
                                  ) : null}
                                  {connected ? (
                                    <>
                                      <View
                                        accessible
                                        accessibilityLabel={t('hosts.agents', { count: runtime?.agentTotal ?? 0 })}
                                        className="flex-row items-center gap-1">
                                        <Icon as={Bot} className="text-muted-foreground" size={20} />
                                        <Text className="text-[10px] font-semibold leading-[15px] text-muted-foreground">
                                          {runtime?.agentTotal ?? 0}
                                        </Text>
                                      </View>
                                      <View
                                        accessible
                                        accessibilityLabel={runtime?.protocol == null
                                          ? t('hosts.herdrProtocolNone')
                                          : t('hosts.herdrProtocol', { version: runtime.protocol })}
                                        className="flex-row items-center gap-1">
                                        <HerdrMark size={13} />
                                        <Text className="text-[10px] font-semibold leading-[15px] text-muted-foreground">
                                          {runtime?.protocol == null
                                            ? t('hosts.herdrProtocolNoneValue')
                                            : t('hosts.herdrProtocolValue', { version: runtime.protocol })}
                                        </Text>
                                      </View>
                                    </>
                                  ) : null}
                                </View>
                              ) : null}
                            </View>
                          </Button>
                          <IconButton icon={Ellipsis} accessibilityLabel={t('hosts.edit', { host: displayName })} onPress={() => {
                            if (actionsOpen) closeActions();
                            else onEdit(host);
                          }} />
                        </GlassSurface>
                      )}
                    </SwipeableHostRow>
                  );
                })}
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function SwipeableHostRow({
  children,
  connected,
  connecting,
  displayName,
  onConnect,
  onDelete,
  onDisconnect,
}: {
  children: (controls: { actionsOpen: boolean; closeActions: () => void }) => React.ReactNode;
  connected: boolean;
  connecting: boolean;
  displayName: string;
  onConnect: () => void;
  onDelete: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  const translateX = useSharedValue(0);
  const openRef = useRef(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const actionRevealStyle = useAnimatedStyle(() => ({
    width: Math.max(0, -translateX.value),
  }));

  useEffect(() => () => cancelAnimation(translateX), [translateX]);

  const settle = (open: boolean) => {
    openRef.current = open;
    setActionsOpen(open);
    translateX.value = withSpring(open ? -HOST_SWIPE_ACTION_WIDTH : 0, DEFAULT_SPRING_CONFIG);
  };

  const panResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponderCapture: (_event, gesture) => (
      shouldClaimHostSwipe(gesture.dx, gesture.dy, openRef.current)
    ),
    onPanResponderGrant: () => cancelAnimation(translateX),
    onPanResponderMove: (_event, gesture) => {
      translateX.value = hostSwipeOffset(gesture.dx, openRef.current);
    },
    onPanResponderRelease: (_event, gesture) => {
      settle(shouldOpenHostSwipe(gesture.dx, gesture.vx, openRef.current));
    },
    onPanResponderTerminate: () => settle(openRef.current),
    onPanResponderTerminationRequest: () => false,
  })).current;

  const runAction = (action: () => void) => {
    settle(false);
    action();
  };

  return (
    <View className="relative min-h-[88px] overflow-hidden rounded-lg">
      <Animated.View
        accessibilityElementsHidden={!actionsOpen}
        className="absolute inset-y-0 right-0 overflow-hidden"
        importantForAccessibility={actionsOpen ? 'auto' : 'no-hide-descendants'}
        style={actionRevealStyle}>
        <View className="absolute inset-y-0 right-0 flex-row" style={{ width: HOST_SWIPE_ACTION_WIDTH }}>
          <Button
            accessibilityLabel={t(connected ? 'hosts.disconnectHost' : 'hosts.connectTo', { host: displayName })}
            className={connected
              ? 'h-full w-[76px] flex-col gap-1 rounded-l-lg rounded-r-none bg-warning'
              : 'h-full w-[76px] flex-col gap-1 rounded-l-lg rounded-r-none bg-primary'}
            disabled={connecting}
            size="content"
            onPress={hapticPress(() => runAction(connected ? onDisconnect : onConnect))}>
            <Icon as={connected ? LogOut : LogIn} className={connected ? 'text-black' : 'text-primary-foreground'} size={19} />
            <Text className={connected ? 'text-[11px] font-semibold text-black' : 'text-[11px] font-semibold text-primary-foreground'}>
              {t(connected ? 'hosts.disconnect' : 'common.connect')}
            </Text>
          </Button>
          <Button
            accessibilityLabel={t('hosts.deleteHost', { host: displayName })}
            className="h-full w-[76px] flex-col gap-1 rounded-none"
            size="content"
            variant="destructive"
            onPress={hapticPress(() => runAction(onDelete))}>
            <Icon as={Trash2} className="text-destructive-foreground" size={19} />
            <Text className="text-[11px] font-semibold">{t('hosts.delete')}</Text>
          </Button>
        </View>
      </Animated.View>
      <Animated.View
        style={animatedStyle}
        {...panResponder.panHandlers}>
        {children({ actionsOpen, closeActions: () => settle(false) })}
      </Animated.View>
    </View>
  );
}

function formatLastUsed(value: string, t: TFunction): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('hosts.usedBefore');
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 60_000) return t('hosts.justNow');
  if (elapsed < 3_600_000) return t('hosts.minutesAgo', { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return t('hosts.hoursAgo', { count: Math.floor(elapsed / 3_600_000) });
  return t('hosts.daysAgo', { count: Math.floor(elapsed / 86_400_000) });
}
