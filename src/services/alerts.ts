import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import { Platform, Vibration } from 'react-native';

import type { AgentInfo } from '../types';
import type { AgentNotificationTarget } from '../lib/notificationNavigation';
import { agentNotificationTitle } from '../lib/agentStatusEvents';
import type { AgentAlertLevel } from './devicePreferences';
import { armPersistentAgentAlert, dismissPersistentAgentAlert } from './backgroundMonitoring';
import i18n from '../i18n';
import { isChatSpeechActive, isChatSpeechTarget } from './chatSpeechFocus';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';

const PERSISTENT_CHANNEL_ID = 'agent-state-v3';
const BRIEF_CHANNEL_ID = 'agent-state-brief-v1';
const REGULAR_CHANNEL_ID = 'agent-state-regular-v1';
const ALERT_LEVEL_DATA_KEY = 'agentAlertLevel';
const ALERT_VIBRATION_PATTERN = [
  300, 100, 300, 100, 300, 100, 300, 2000,
  300, 100, 300, 100, 300, 100, 300, 2000,
  300, 100, 300, 100, 300, 100, 300, 2000,
];
const BRIEF_VIBRATION_PATTERN = [0, 200];
const SPEECH_TIMEOUT_MS = 10_000;
const DEFAULT_PERSISTENT_ALERT_TIMEOUT_MS = 30_000;
type ActiveAgentNotification = {
  paneTargetKey: string;
  tabTargetKey: string;
  persistent: boolean;
};
type AgentAlertTargets = Pick<ActiveAgentNotification, 'paneTargetKey' | 'tabTargetKey'>;

const activeAgentNotifications = new Map<string, ActiveAgentNotification>();
const pendingPaneAlertCounts = new Map<string, number>();
const pendingTabAlertCounts = new Map<string, number>();
const paneDismissalGenerations = new Map<string, number>();
const tabDismissalGenerations = new Map<string, number>();
let alertDismissalGeneration = 0;
let persistentAgentNotificationId: string | null = null;
let speakingAgentAlertTargets: AgentAlertTargets | null = null;

export type AgentAlertDelivery = AgentAlertLevel | 'brief';

Notifications.setNotificationHandler({
  handleNotification: notification => {
    const regular = notification.request.content.data?.[ALERT_LEVEL_DATA_KEY] === 'regular';
    return Promise.resolve({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
      priority: regular
        ? Notifications.AndroidNotificationPriority.DEFAULT
        : Notifications.AndroidNotificationPriority.MAX,
    });
  },
});

export async function prepareAlerts(): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync(PERSISTENT_CHANNEL_ID, {
        name: i18n.t('alerts.channelName'),
        importance: Notifications.AndroidImportance.HIGH,
        bypassDnd: true,
        enableLights: true,
        enableVibrate: true,
        vibrationPattern: ALERT_VIBRATION_PATTERN,
      });
      await Notifications.setNotificationChannelAsync(BRIEF_CHANNEL_ID, {
        name: i18n.t('alerts.channelName'),
        importance: Notifications.AndroidImportance.HIGH,
        enableLights: true,
        enableVibrate: true,
        vibrationPattern: BRIEF_VIBRATION_PATTERN,
      });
      await Notifications.setNotificationChannelAsync(REGULAR_CHANNEL_ID, {
        name: i18n.t('alerts.regularChannelName'),
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    } catch (error) {
      recordNotificationFailure('error', 'notification-setup-failed', error, {
        stage: 'android-channels',
      });
      throw error;
    }
  }
  try {
    await Notifications.requestPermissionsAsync();
  } catch (error) {
    recordNotificationFailure('error', 'notification-setup-failed', error, {
      stage: 'permissions',
    });
    throw error;
  }
}

export async function alertAgent(
  agent: AgentInfo,
  speak: boolean,
  target: Pick<AgentNotificationTarget, 'hostId' | 'paneId'>,
  tabName?: string,
  delivery: AgentAlertDelivery = 'persistent',
  persistentAlertTimeoutMs: number = DEFAULT_PERSISTENT_ALERT_TIMEOUT_MS,
): Promise<void> {
  if (isChatSpeechTarget(target.hostId, target.paneId)) return;
  const dismissalGeneration = alertDismissalGeneration;
  const paneTargetKey = agentAlertTargetKey(target.hostId, target.paneId);
  const tabTargetKey = agentAlertTargetKey(target.hostId, agent.tab_id);
  const targets = { paneTargetKey, tabTargetKey };
  const paneDismissalGeneration = paneDismissalGenerations.get(paneTargetKey) ?? 0;
  const tabDismissalGeneration = tabDismissalGenerations.get(tabTargetKey) ?? 0;
  const wasDismissed = () => (
    isChatSpeechTarget(target.hostId, target.paneId)
    || dismissalGeneration !== alertDismissalGeneration
    || paneDismissalGeneration !== (paneDismissalGenerations.get(paneTargetKey) ?? 0)
    || tabDismissalGeneration !== (tabDismissalGenerations.get(tabTargetKey) ?? 0)
  );
  const title = agentNotificationTitle(agent, tabName, {
    needsYou: name => i18n.t('alerts.needsYou', { name }),
    finished: name => i18n.t('alerts.finished', { name }),
  });
  const body = agent.title || i18n.t('alerts.agentState', { status: agent.agent_status });

  incrementAlertCount(pendingPaneAlertCounts, paneTargetKey);
  incrementAlertCount(pendingTabAlertCounts, tabTargetKey);
  try {
    if (speak && !isChatSpeechActive()) {
      speakingAgentAlertTargets = targets;
      try {
        await speakBeforeAlert(title);
      } finally {
        if (speakingAgentAlertTargets === targets) speakingAgentAlertTargets = null;
      }
    }
    if (wasDismissed()) return;
    const regular = delivery === 'regular';
    if (Platform.OS !== 'android' && !regular) Vibration.vibrate();
    const persistent = delivery === 'persistent';
    const channelId = regular
      ? REGULAR_CHANNEL_ID
      : persistent ? PERSISTENT_CHANNEL_ID : BRIEF_CHANNEL_ID;
    const content: Notifications.NotificationContentInput = {
      title,
      body,
      priority: regular
        ? Notifications.AndroidNotificationPriority.DEFAULT
        : Notifications.AndroidNotificationPriority.MAX,
      data: { ...target, [ALERT_LEVEL_DATA_KEY]: delivery },
    };
    if (!regular) {
      content.sound = 'default';
      content.vibrate = persistent ? ALERT_VIBRATION_PATTERN : BRIEF_VIBRATION_PATTERN;
    }
    let notificationIdentifier: string;
    try {
      notificationIdentifier = await Notifications.scheduleNotificationAsync({
        content,
        trigger: { channelId },
      });
    } catch (error) {
      recordNotificationFailure('error', 'agent-notification-schedule-failed', error, {
        stage: 'schedule',
      });
      throw error;
    }
    if (wasDismissed()) {
      await dismissScheduledNotification(notificationIdentifier, 'stale-generation-cleanup');
      return;
    }
    activeAgentNotifications.set(notificationIdentifier, { ...targets, persistent });
    if (Platform.OS === 'android' && persistent) {
      persistentAgentNotificationId = notificationIdentifier;
      armPersistentAgentAlert(
        notificationIdentifier,
        PERSISTENT_CHANNEL_ID,
        persistentAlertTimeoutMs,
      ).catch(error => {
        recordNotificationFailure('error', 'persistent-agent-alert-arm-failed', error, {
          stage: 'background-monitoring',
        });
        if (persistentAgentNotificationId === notificationIdentifier) {
          persistentAgentNotificationId = null;
        }
      });
    }
  } finally {
    decrementAlertCount(pendingPaneAlertCounts, paneTargetKey);
    decrementAlertCount(pendingTabAlertCounts, tabTargetKey);
  }
}

export async function dismissAgentAlerts(): Promise<void> {
  alertDismissalGeneration += 1;
  const notificationIds = [...activeAgentNotifications.keys()];
  activeAgentNotifications.clear();
  persistentAgentNotificationId = null;
  speakingAgentAlertTargets = null;
  await stopSpeech('dismiss-all');
  await Promise.all(notificationIds.map(identifier => (
    dismissScheduledNotification(identifier, 'dismiss-all')
  )));
  await dismissPersistentAlert('dismiss-all');
}

export async function dismissAgentAlertsForTab(hostId: string, tabId: string): Promise<void> {
  const targetKey = agentAlertTargetKey(hostId, tabId);
  const notificationIds = [...activeAgentNotifications]
    .filter(([, alert]) => alert.tabTargetKey === targetKey)
    .map(([identifier]) => identifier);
  const pending = pendingTabAlertCounts.has(targetKey);
  if (!pending && notificationIds.length === 0) return;

  tabDismissalGenerations.set(targetKey, (tabDismissalGenerations.get(targetKey) ?? 0) + 1);
  for (const identifier of notificationIds) activeAgentNotifications.delete(identifier);

  if (speakingAgentAlertTargets?.tabTargetKey === targetKey) {
    speakingAgentAlertTargets = null;
    await stopSpeech('dismiss-tab');
  }
  await Promise.all(notificationIds.map(identifier => (
    dismissScheduledNotification(identifier, 'dismiss-tab')
  )));
  if (persistentAgentNotificationId && notificationIds.includes(persistentAgentNotificationId)) {
    persistentAgentNotificationId = null;
    await dismissPersistentAlert('dismiss-tab');
  }
}

export async function dismissAgentAlertsForPane(hostId: string, paneId: string): Promise<void> {
  const targetKey = agentAlertTargetKey(hostId, paneId);
  const notificationIds = [...activeAgentNotifications]
    .filter(([, alert]) => alert.paneTargetKey === targetKey)
    .map(([identifier]) => identifier);
  const pending = pendingPaneAlertCounts.has(targetKey);
  if (!pending && notificationIds.length === 0) return;

  paneDismissalGenerations.set(targetKey, (paneDismissalGenerations.get(targetKey) ?? 0) + 1);
  for (const identifier of notificationIds) activeAgentNotifications.delete(identifier);

  if (speakingAgentAlertTargets?.paneTargetKey === targetKey) {
    speakingAgentAlertTargets = null;
    await stopSpeech('dismiss-pane');
  }
  await Promise.all(notificationIds.map(identifier => (
    dismissScheduledNotification(identifier, 'dismiss-pane')
  )));
  if (persistentAgentNotificationId && notificationIds.includes(persistentAgentNotificationId)) {
    persistentAgentNotificationId = null;
    await dismissPersistentAlert('dismiss-pane');
  }
}

function agentAlertTargetKey(hostId: string, targetId: string): string {
  return JSON.stringify([hostId, targetId]);
}

function incrementAlertCount(counts: Map<string, number>, targetKey: string): void {
  counts.set(targetKey, (counts.get(targetKey) ?? 0) + 1);
}

function decrementAlertCount(counts: Map<string, number>, targetKey: string): void {
  const remaining = (counts.get(targetKey) ?? 1) - 1;
  if (remaining > 0) counts.set(targetKey, remaining);
  else counts.delete(targetKey);
}

async function speakBeforeAlert(title: string): Promise<void> {
  await stopSpeech('before-speak');
  if (isChatSpeechActive()) return;
  await new Promise<void>(resolve => {
    let completed = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (completed) return;
      completed = true;
      if (timeout) clearTimeout(timeout);
      resolve();
    };

    timeout = setTimeout(() => {
      stopSpeech('speech-timeout').then(finish, finish);
    }, SPEECH_TIMEOUT_MS);
    try {
      Speech.speak(title, {
        language: {
          'zh-Hant': 'zh-TW',
          'zh-Hans': 'zh-CN',
          ja: 'ja-JP',
          es: 'es-ES',
          en: 'en-US',
        }[i18n.resolvedLanguage || 'en'] || 'en-US',
        onDone: finish,
        onStopped: finish,
        onError: error => {
          recordNotificationFailure('warn', 'agent-alert-speech-failed', error, {
            stage: 'speech-callback',
          });
          finish();
        },
      });
    } catch (error) {
      recordNotificationFailure('warn', 'agent-alert-speech-failed', error, {
        stage: 'speech-start',
      });
      finish();
    }
  });
}

async function dismissScheduledNotification(identifier: string, stage: string): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(identifier);
  } catch (error) {
    if (isExpectedDismissalRace(error)) return;
    recordNotificationFailure('warn', 'notification-dismiss-failed', error, { stage });
  }
}

async function dismissPersistentAlert(stage: string): Promise<void> {
  try {
    await dismissPersistentAgentAlert();
  } catch (error) {
    if (isExpectedDismissalRace(error)) return;
    recordNotificationFailure('warn', 'persistent-agent-alert-dismiss-failed', error, { stage });
  }
}

async function stopSpeech(stage: string): Promise<void> {
  try {
    await Speech.stop();
  } catch (error) {
    recordNotificationFailure('warn', 'agent-alert-speech-stop-failed', error, { stage });
  }
}

function isExpectedDismissalRace(error: unknown): boolean {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown }
    : null;
  if (
    candidate?.code === 'ERR_NOTIFICATION_NOT_FOUND'
    || candidate?.code === 'E_NOTIFICATION_NOT_FOUND'
  ) return true;
  return typeof candidate?.message === 'string'
    && /already (?:dismissed|removed)|not found|does not exist/i.test(candidate.message);
}

function recordNotificationFailure(
  level: 'warn' | 'error',
  event: string,
  error: unknown,
  details: Readonly<Record<string, string>>,
): void {
  recordOperationalDiagnostic(level, 'Notification', event, {
    ...details,
    ...operationalErrorDetails(error),
  });
}
