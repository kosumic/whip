import {
  HerdrAgentStatus,
  LocalAlertCoordinator,
  LocalAlertDelivery,
  LocalAlertEffectAdmission,
  LocalAlertScope,
  LocalAlertAction_Tags,
  LocalAlertOutcome,
  LocalAlertSpeechEnd,
  type LocalAlertEffect,
  type LocalAlertRequest,
  type LocalAlertRuntime,
} from 'react-native-whip-ssh';
import * as Notifications from 'expo-notifications';
import { Platform, Vibration } from 'react-native';

import type { AgentInfo, AgentStatus } from '../types';
import type { AgentNotificationTarget } from '../lib/notificationNavigation';
import { agentNotificationTitle } from '../lib/agentStatusEvents';
import { transcriptTitleKey } from '../lib/transcriptTabTitles';
import { notificationRegistrationProof } from '../lib/notificationRegistration';
import type { AgentAlertLevel } from './devicePreferences';
import { agentTranscriptService } from './NativeTranscriptService';
import {
  armPersistentAgentAlert,
  dismissPersistentAgentAlert,
} from './backgroundMonitoring';
import i18n from '../i18n';
import { isChatSpeechActive } from './chatSpeechFocus';
import { getSpeechPlayback, type SpeechEndReason } from './speechPlayback';
import { setNotificationDeliveryAvailable } from './notificationPipelineHealth';
import {
  notificationRuntimes,
  subscribeNotificationRuntimeChanges,
} from './notificationRuntimeRegistry';
import { reportBackgroundFailure } from './backgroundOperations';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';

const PERSISTENT_CHANNEL_ID = 'agent-state-v3';
const BRIEF_CHANNEL_ID = 'agent-state-brief-v1';
const REGULAR_CHANNEL_ID = 'agent-state-regular-v1';
const ALERT_LEVEL_DATA_KEY = 'agentAlertLevel';
const ALERT_VIBRATION_PATTERN = [
  300, 100, 300, 100, 300, 100, 300, 2000, 300, 100, 300, 100, 300, 100, 300,
  2000, 300, 100, 300, 100, 300, 100, 300, 2000,
];
const BRIEF_VIBRATION_PATTERN = [0, 200];
const DEFAULT_PERSISTENT_ALERT_TIMEOUT_MS = 30_000;
const DELIVERY = {
  persistent: LocalAlertDelivery.Persistent,
  brief: LocalAlertDelivery.Brief,
  regular: LocalAlertDelivery.Regular,
};
const STATUS: Record<AgentStatus, HerdrAgentStatus> = {
  idle: HerdrAgentStatus.Idle,
  working: HerdrAgentStatus.Working,
  blocked: HerdrAgentStatus.Blocked,
  done: HerdrAgentStatus.Done,
  unknown: HerdrAgentStatus.Unknown,
};
const SPEECH_END: Record<SpeechEndReason, LocalAlertSpeechEnd> = {
  completed: LocalAlertSpeechEnd.Completed,
  stopped: LocalAlertSpeechEnd.Stopped,
  shake: LocalAlertSpeechEnd.Shake,
  replaced: LocalAlertSpeechEnd.Replaced,
  interrupted: LocalAlertSpeechEnd.Interrupted,
  busy: LocalAlertSpeechEnd.Busy,
};

export type AgentAlertDelivery = AgentAlertLevel | 'brief';
type AlertTarget = Pick<AgentNotificationTarget, 'hostId' | 'paneId'>;
let coordinator: LocalAlertCoordinator | undefined;

function runtimeFor(hostId: string): LocalAlertRuntime | undefined {
  const runtime = notificationRuntimes.get(hostId);
  return (
    runtime && {
      runtimeId: runtime.runtimeId,
      incarnation: BigInt(runtime.runtimeIncarnation),
    }
  );
}

function native(): LocalAlertCoordinator {
  if (!coordinator) {
    coordinator = new LocalAlertCoordinator();
    for (const hostId of notificationRuntimes.keys())
      reportBackgroundFailure(
        runEffects(
          coordinator,
          coordinator.setRuntime(hostId, runtimeFor(hostId)),
        ),
        'local-alert-runtime-attach',
      );
  }
  return coordinator;
}

subscribeNotificationRuntimeChanges(hostId => {
  if (coordinator)
    reportBackgroundFailure(
      runEffects(
        coordinator,
        coordinator.setRuntime(hostId, runtimeFor(hostId)),
      ),
      'local-alert-runtime-change',
    );
});

Notifications.setNotificationHandler({
  handleNotification: notification => {
    if (notificationRegistrationProof(notification.request.content.data)) {
      return Promise.resolve({
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      });
    }
    const regular =
      notification.request.content.data?.[ALERT_LEVEL_DATA_KEY] === 'regular';
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
  setNotificationDeliveryAvailable(false);
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
    setNotificationDeliveryAvailable(true);
  } catch (error) {
    recordNotificationFailure('error', 'notification-setup-failed', error, {
      stage: 'permissions',
    });
    throw error;
  }
}

function alertRequest(
  agent: AgentInfo,
  speak: boolean,
  target: AlertTarget,
  tabName: string | undefined,
  delivery: AgentAlertDelivery,
  persistentAlertTimeoutMs: number,
): LocalAlertRequest {
  const labels = {
    needsYou: (name: string) => i18n.t('alerts.needsYou', { name }),
    finished: (name: string) => i18n.t('alerts.finished', { name }),
  };
  const title = agentNotificationTitle(agent, tabName, labels);
  const sessionTitle = speak
    ? agentTranscriptService.titles.title(
        transcriptTitleKey(target.hostId, agent),
      )
    : undefined;
  return {
    ...target,
    tabId: agent.tab_id,
    runtime: runtimeFor(target.hostId),
    title,
    body:
      agent.title ||
      i18n.t('alerts.agentState', { status: agent.agent_status }),
    announcement: speak
      ? sessionTitle
        ? agentNotificationTitle(
            { ...agent, display_agent: sessionTitle },
            undefined,
            labels,
          )
        : title
      : undefined,
    language:
      {
        'zh-Hant': 'zh-TW',
        'zh-Hans': 'zh-CN',
        ja: 'ja-JP',
        es: 'es-ES',
        en: 'en-US',
      }[i18n.resolvedLanguage || 'en'] || 'en-US',
    delivery: DELIVERY[delivery],
    persistentTimeoutMs: persistentAlertTimeoutMs,
    android: Platform.OS === 'android',
  };
}

export function alertAgent(
  agent: AgentInfo,
  speak: boolean,
  target: AlertTarget,
  tabName?: string,
  delivery: AgentAlertDelivery = 'persistent',
  persistentAlertTimeoutMs = DEFAULT_PERSISTENT_ALERT_TIMEOUT_MS,
): Promise<void> {
  const owner = native();
  return runEffects(
    owner,
    owner.alert(
      alertRequest(
        agent,
        speak,
        target,
        tabName,
        delivery,
        persistentAlertTimeoutMs,
      ),
    ),
  );
}

/** Forward a native status transition; Rust decides admission, dismissal and mode. */
export function transitionAgentAlert(
  agent: AgentInfo | undefined,
  status: AgentStatus | null | undefined,
  target: AlertTarget,
  options: {
    enabled: boolean;
    speak: boolean;
    foreground: boolean;
    delivery: AgentAlertLevel;
    timeoutMs: number;
    tabName?: string;
  },
): Promise<void> {
  const owner = native();
  return runEffects(
    owner,
    owner.transition({
      ...target,
      runtime: runtimeFor(target.hostId),
      status: status ? STATUS[status] : undefined,
      enabled: options.enabled,
      foreground: options.foreground,
      request: agent
        ? alertRequest(
            agent,
            options.speak,
            target,
            options.tabName,
            options.delivery,
            options.timeoutMs,
          )
        : undefined,
    }),
  );
}

export function dismissAgentAlerts(): Promise<void> {
  const owner = native();
  return runEffects(owner, owner.dismiss(new LocalAlertScope.All()));
}

export function dismissAgentAlertsForTab(
  hostId: string,
  tabId: string,
): Promise<void> {
  const owner = native();
  return runEffects(
    owner,
    owner.dismiss(new LocalAlertScope.Tab({ hostId, tabId })),
  );
}

export function dismissAgentAlertsForPane(
  hostId: string,
  paneId: string,
): Promise<void> {
  const owner = native();
  return runEffects(
    owner,
    owner.dismiss(new LocalAlertScope.Pane({ hostId, paneId })),
  );
}

async function runEffects(
  owner: LocalAlertCoordinator,
  effects: LocalAlertEffect[],
): Promise<void> {
  await Promise.all(
    effects.map(async effect => {
      // Yield before native TTS admission so an immediate dismissal can fence it.
      if (effect.action.tag === LocalAlertAction_Tags.Speak)
        await Promise.resolve();
      const admission = owner.beginEffect(effect.id);
      if (admission === LocalAlertEffectAdmission.Duplicate) return;
      let outcome: LocalAlertOutcome;
      let scheduleFailure: { error: unknown } | undefined;
      if (admission === LocalAlertEffectAdmission.Skip)
        outcome = new LocalAlertOutcome.Skipped();
      else {
        try {
          outcome = await performEffect(effect);
        } catch (error) {
          outcome = new LocalAlertOutcome.Failed({
            message: error instanceof Error ? error.message : String(error),
          });
          recordEffectFailure(effect, error);
          if (effect.action.tag === LocalAlertAction_Tags.Schedule)
            scheduleFailure = { error };
        }
      }
      await runEffects(owner, owner.completeEffect(effect.id, outcome));
      if (scheduleFailure) throw scheduleFailure.error;
    }),
  );
}

async function performEffect({
  action,
}: LocalAlertEffect): Promise<LocalAlertOutcome> {
  switch (action.tag) {
    case LocalAlertAction_Tags.Speak: {
      const { token, text, language } = action.inner;
      const reason = isChatSpeechActive()
        ? 'busy'
        : await getSpeechPlayback().speakAnnouncement(token, text, language);
      return new LocalAlertOutcome.SpeechEnded({ reason: SPEECH_END[reason] });
    }
    case LocalAlertAction_Tags.StopSpeech:
      await getSpeechPlayback().stopAnnouncement(action.inner.token);
      break;
    case LocalAlertAction_Tags.Schedule: {
      const request = action.inner.request;
      const regular = request.delivery === LocalAlertDelivery.Regular;
      const persistent = request.delivery === LocalAlertDelivery.Persistent;
      if (Platform.OS !== 'android' && !regular) Vibration.vibrate();
      const delivery: AgentAlertDelivery = regular
        ? 'regular'
        : persistent
          ? 'persistent'
          : 'brief';
      const content: Notifications.NotificationContentInput = {
        title: request.title,
        body: request.body,
        priority: regular
          ? Notifications.AndroidNotificationPriority.DEFAULT
          : Notifications.AndroidNotificationPriority.MAX,
        data: {
          hostId: request.hostId,
          paneId: request.paneId,
          [ALERT_LEVEL_DATA_KEY]: delivery,
        },
      };
      if (!regular) {
        content.sound = 'default';
        content.vibrate = persistent
          ? ALERT_VIBRATION_PATTERN
          : BRIEF_VIBRATION_PATTERN;
      }
      const notificationId = await Notifications.scheduleNotificationAsync({
        content,
        trigger: {
          channelId: regular
            ? REGULAR_CHANNEL_ID
            : persistent
              ? PERSISTENT_CHANNEL_ID
              : BRIEF_CHANNEL_ID,
        },
      });
      setNotificationDeliveryAvailable(true);
      return new LocalAlertOutcome.Scheduled({ notificationId });
    }
    case LocalAlertAction_Tags.DismissNotification:
      await Notifications.dismissNotificationAsync(action.inner.notificationId);
      break;
    case LocalAlertAction_Tags.ArmPersistent:
      await armPersistentAgentAlert(
        action.inner.notificationId,
        PERSISTENT_CHANNEL_ID,
        action.inner.timeoutMs,
      );
      break;
    case LocalAlertAction_Tags.DismissPersistent:
      await dismissPersistentAgentAlert(action.inner.notificationId);
      break;
  }
  return new LocalAlertOutcome.Done();
}

function recordEffectFailure(effect: LocalAlertEffect, error: unknown): void {
  switch (effect.action.tag) {
    case LocalAlertAction_Tags.Schedule:
      setNotificationDeliveryAvailable(false);
      recordNotificationFailure(
        'error',
        'agent-notification-schedule-failed',
        error,
        { stage: 'schedule' },
      );
      break;
    case LocalAlertAction_Tags.ArmPersistent:
      setNotificationDeliveryAvailable(false);
      recordNotificationFailure(
        'error',
        'persistent-agent-alert-arm-failed',
        error,
        { stage: 'background-monitoring' },
      );
      break;
    case LocalAlertAction_Tags.Speak:
      recordNotificationFailure('warn', 'agent-alert-speech-failed', error, {
        stage: 'speech-playback',
      });
      break;
    case LocalAlertAction_Tags.StopSpeech:
      recordNotificationFailure(
        'warn',
        'agent-alert-speech-stop-failed',
        error,
        { stage: 'speech-playback' },
      );
      break;
    case LocalAlertAction_Tags.DismissNotification:
      if (!isExpectedDismissalRace(error))
        recordNotificationFailure(
          'warn',
          'notification-dismiss-failed',
          error,
          { stage: 'dismiss' },
        );
      break;
    case LocalAlertAction_Tags.DismissPersistent:
      if (!isExpectedDismissalRace(error))
        recordNotificationFailure(
          'warn',
          'persistent-agent-alert-dismiss-failed',
          error,
          { stage: 'dismiss' },
        );
      break;
  }
}

function isExpectedDismissalRace(error: unknown): boolean {
  const candidate =
    error && typeof error === 'object'
      ? (error as { code?: unknown; message?: unknown })
      : null;
  if (
    candidate?.code === 'ERR_NOTIFICATION_NOT_FOUND' ||
    candidate?.code === 'E_NOTIFICATION_NOT_FOUND'
  )
    return true;
  return (
    typeof candidate?.message === 'string' &&
    /already (?:dismissed|removed)|not found|does not exist/i.test(
      candidate.message,
    )
  );
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
