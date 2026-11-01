jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 'default', HIGH: 'high' },
  AndroidNotificationPriority: { DEFAULT: 'default', MAX: 'max' },
  dismissNotificationAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
}));
// Exercise the real generated enums/records; only the native coordinator is
// scripted here. Its actual lifecycle and race policy is tested in Rust.
jest.mock(
  '../packages/react-native-whip-ssh/src/generated/whip_ssh-ffi',
  () => ({
    __esModule: true,
    default: () => ({}),
  }),
);
const mockNative = {
  alert: jest.fn(),
  transition: jest.fn(),
  dismiss: jest.fn(),
  setRuntime: jest.fn(),
  beginEffect: jest.fn(),
  completeEffect: jest.fn(),
};
jest.mock('react-native-whip-ssh', () => ({
  ...jest.requireActual(
    '../packages/react-native-whip-ssh/src/generated/whip_ssh',
  ),
  LocalAlertCoordinator: jest.fn(() => mockNative),
}));
const mockPlayback = {
  speakAnnouncement: jest.fn<
    Promise<SpeechEndReason>,
    [string, string, string]
  >(),
  stopAnnouncement: jest.fn<Promise<void>, [string]>(),
};
jest.mock('../src/services/speechPlayback', () => ({
  getSpeechPlayback: () => mockPlayback,
}));
jest.mock('../src/services/NativeTranscriptService', () => ({
  agentTranscriptService: {
    titles:
      new (require('../src/lib/transcriptTabTitles').TranscriptTabTitles)(),
  },
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Vibration: { vibrate: jest.fn() },
}));
jest.mock('../src/services/backgroundMonitoring', () => ({
  armPersistentAgentAlert: jest.fn(),
  dismissPersistentAgentAlert: jest.fn(),
}));
jest.mock('../src/i18n', () => ({
  __esModule: true,
  default: {
    resolvedLanguage: 'en',
    t: (key: string, options?: { name?: string; status?: string }) => {
      if (key === 'alerts.needsAttention') return `${options?.name} needs attention`;
      if (key === 'alerts.finished') return `${options?.name} finished`;
      if (key === 'alerts.agentState') return `Agent is ${options?.status}`;
      return key;
    },
  },
}));

import * as Notifications from 'expo-notifications';
import { Platform, Vibration } from 'react-native';
import {
  HerdrAgentStatus,
  LocalAlertAction,
  LocalAlertDelivery,
  LocalAlertEffectAdmission,
  LocalAlertOutcome,
  LocalAlertSpeechEnd,
  type LocalAlertRequest,
  type LocalAlertEffect,
} from 'react-native-whip-ssh';
import type { SpeechEndReason } from '../src/services/speechPlayback';
import type { AgentInfo } from '../src/types';
import {
  alertAgent,
  transitionAgentAlert,
  dismissAgentAlerts,
  dismissAgentAlertsForPane,
  dismissAgentAlertsForTab,
  prepareAlerts,
} from '../src/services/alerts';
import {
  armPersistentAgentAlert,
  dismissPersistentAgentAlert,
} from '../src/services/backgroundMonitoring';
import { setChatSpeechFocus } from '../src/services/chatSpeechFocus';
import { agentTranscriptService } from '../src/services/NativeTranscriptService';
import {
  notificationDeliveryAvailable,
  setNotificationDeliveryAvailable,
} from '../src/services/notificationPipelineHealth';
import {
  bindNotificationRuntime,
  unbindNotificationRuntime,
  notificationRuntimes,
} from '../src/services/notificationRuntimeRegistry';
import i18n from '../src/i18n';

const agent: AgentInfo = {
  terminal_id: 'terminal-1',
  agent: 'codex',
  agent_status: 'blocked',
  workspace_id: 'workspace-1',
  tab_id: 'tab-1',
  pane_id: 'pane-1',
  focused: false,
  revision: 1,
};
const target = { hostId: 'host-1', paneId: agent.pane_id };
const notificationHandler = jest.mocked(Notifications.setNotificationHandler)
  .mock.calls[0][0]!;
const effect = (
  id: string,
  action: LocalAlertEffect['action'],
): LocalAlertEffect => ({ id, action });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function speak(request: LocalAlertRequest): LocalAlertEffect[] {
  return [
    effect(
      'speech',
      new LocalAlertAction.Speak({
        token: 'native-token',
        text: request.announcement!,
        language: request.language,
      }),
    ),
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  setChatSpeechFocus(null);
  setNotificationDeliveryAvailable(true);
  notificationRuntimes.clear();
  agentTranscriptService.titles.clear();
  i18n.resolvedLanguage = 'en';
  mockNative.alert.mockImplementation((request: LocalAlertRequest) => [
    effect('schedule', new LocalAlertAction.Schedule({ request })),
  ]);
  mockNative.transition.mockReturnValue([]);
  mockNative.dismiss.mockReturnValue([]);
  mockNative.setRuntime.mockReturnValue([]);
  mockNative.beginEffect.mockReturnValue(LocalAlertEffectAdmission.Run);
  mockNative.completeEffect.mockReturnValue([]);
  mockPlayback.speakAnnouncement.mockResolvedValue('completed');
  mockPlayback.stopAnnouncement.mockResolvedValue();
  jest
    .mocked(Notifications.scheduleNotificationAsync)
    .mockResolvedValue('notification-1');
  jest.mocked(Notifications.dismissNotificationAsync).mockResolvedValue();
  jest.mocked(armPersistentAgentAlert).mockResolvedValue();
  jest.mocked(dismissPersistentAgentAlert).mockResolvedValue();
});

test('registration proofs are silent and local notifications retain foreground presentation', async () => {
  const notification = {
    request: {
      content: {
        data: {
          whip_notify_registration: {
            device_id: 'device'.repeat(8),
            challenge: 'c'.repeat(43),
          },
        },
      },
    },
  } as unknown as Notifications.Notification;
  expect(
    await notificationHandler.handleNotification(notification),
  ).toMatchObject({ shouldPlaySound: false, shouldShowBanner: false });
  notification.request.content.data = { agentAlertLevel: 'regular' };
  expect(
    await notificationHandler.handleNotification(notification),
  ).toMatchObject({
    shouldPlaySound: true,
    shouldShowBanner: true,
    priority: Notifications.AndroidNotificationPriority.DEFAULT,
  });
});

test('shows the real Herdr agent kind even when its managed name matches the tab', async () => {
  await alertAgent({ ...agent, name: 'rev', display_agent: 'rev', agent_status: 'done' }, false, target, 'rev');
  expect(jest.mocked(Notifications.scheduleNotificationAsync).mock.calls[0][0].content.title)
    .toBe('rev · codex finished');
});

test.each(['persistent', 'brief', 'regular'] as const)(
  '%s mode retains channel, text, sound and vibration',
  async delivery => {
    await alertAgent(agent, false, target, 'work', delivery, 45_000);
    const request = jest.mocked(Notifications.scheduleNotificationAsync).mock
      .calls[0][0];
    expect(request.content).toMatchObject({
      title: 'work · codex needs attention',
      body: 'Agent is blocked',
      data: { ...target, agentAlertLevel: delivery },
    });
    expect(request.trigger).toEqual({
      channelId:
        delivery === 'persistent'
          ? 'agent-state-v3'
          : `agent-state-${delivery}-v1`,
    });
    if (delivery === 'regular') {
      expect(request.content).not.toHaveProperty('sound');
      expect(request.content).not.toHaveProperty('vibrate');
    } else {
      expect(request.content.sound).toBe('default');
      expect(request.content.vibrate).toEqual(
        delivery === 'brief'
          ? [0, 200]
          : expect.arrayContaining([300, 100, 2000]),
      );
    }
    expect(mockNative.alert).toHaveBeenCalledWith(
      expect.objectContaining({ persistentTimeoutMs: 45_000 }),
    );
    expect(mockNative.completeEffect).toHaveBeenCalledWith(
      'schedule',
      new LocalAlertOutcome.Scheduled({ notificationId: 'notification-1' }),
    );
    // Arming is a separate Rust decision, never inferred from scheduling in JS.
    expect(armPersistentAgentAlert).not.toHaveBeenCalled();
  },
);

test.each(['brief', 'regular'] as const)(
  'iOS %s mode preserves platform vibration',
  async delivery => {
    Platform.OS = 'ios';
    await alertAgent(agent, false, target, undefined, delivery);
    expect(Vibration.vibrate).toHaveBeenCalledTimes(
      delivery === 'brief' ? 1 : 0,
    );
    expect(mockNative.alert).toHaveBeenCalledWith(
      expect.objectContaining({ android: false }),
    );
  },
);

test('dispatches status, preferences and foreground state for Rust admission', async () => {
  await transitionAgentAlert(agent, 'blocked', target, {
    enabled: true,
    speak: true,
    foreground: true,
    delivery: 'persistent',
    timeoutMs: 60_000,
    tabName: 'work',
  });
  expect(mockNative.transition).toHaveBeenCalledWith(
    expect.objectContaining({
      ...target,
      status: HerdrAgentStatus.Blocked,
      foreground: true,
      enabled: true,
      request: expect.objectContaining({
        delivery: LocalAlertDelivery.Persistent,
        persistentTimeoutMs: 60_000,
        announcement: 'work · codex needs attention',
      }),
    }),
  );
  await transitionAgentAlert(undefined, null, target, {
    enabled: false,
    speak: false,
    foreground: false,
    delivery: 'regular',
    timeoutMs: 30_000,
  });
  expect(mockNative.transition).toHaveBeenLastCalledWith(
    expect.objectContaining({
      ...target,
      status: undefined,
      request: undefined,
      enabled: false,
    }),
  );
});

test.each([
  ['completed', LocalAlertSpeechEnd.Completed],
  ['stopped', LocalAlertSpeechEnd.Stopped],
  ['shake', LocalAlertSpeechEnd.Shake],
  ['replaced', LocalAlertSpeechEnd.Replaced],
  ['interrupted', LocalAlertSpeechEnd.Interrupted],
  ['busy', LocalAlertSpeechEnd.Busy],
] as const)(
  'acknowledges %s speech without inventing lifecycle decisions',
  async (reason, nativeReason) => {
    mockNative.alert.mockImplementation(speak);
    mockPlayback.speakAnnouncement.mockResolvedValue(reason);
    await alertAgent(agent, true, target, 'work');
    expect(mockPlayback.speakAnnouncement).toHaveBeenCalledWith(
      'native-token',
      'work · codex needs attention',
      'en-US',
    );
    expect(mockNative.completeEffect).toHaveBeenCalledWith(
      'speech',
      new LocalAlertOutcome.SpeechEnded({ reason: nativeReason }),
    );
    expect(mockNative.dismiss).not.toHaveBeenCalled();
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  },
);

test('chat speech claims playback between dispatch and platform admission', async () => {
  mockNative.alert.mockImplementation(speak);
  const pending = alertAgent(agent, true, target);
  setChatSpeechFocus(target);
  await pending;
  expect(mockPlayback.speakAnnouncement).not.toHaveBeenCalled();
  expect(mockNative.completeEffect).toHaveBeenCalledWith(
    'speech',
    new LocalAlertOutcome.SpeechEnded({ reason: LocalAlertSpeechEnd.Busy }),
  );
});

test('preserves conversation title and language and rejects the prior session title', async () => {
  mockNative.alert.mockImplementation(speak);
  i18n.resolvedLanguage = 'zh-Hant';
  agentTranscriptService.titles.observeBinding(
    'host-1',
    {
      paneId: agent.pane_id,
      terminalId: agent.terminal_id,
      agent: 'codex',
      sessionId: 'conversation',
    },
    {
      sessionId: 'conversation',
      status: 'live',
      transcript: {
        sessionId: 'conversation',
        info: { id: 'conversation', title: 'Fix keyboard latency' },
        messages: [],
        turns: [],
      },
    },
  );
  await alertAgent(
    {
      ...agent,
      agent_session: {
        agent: 'codex',
        source: 'herdr',
        kind: 'id',
        value: 'conversation',
      },
    },
    true,
    target,
    'work',
  );
  expect(mockPlayback.speakAnnouncement).toHaveBeenLastCalledWith(
    'native-token',
    'Fix keyboard latency needs attention',
    'zh-TW',
  );
  await alertAgent(
    {
      ...agent,
      agent_session: {
        agent: 'codex',
        source: 'herdr',
        kind: 'id',
        value: 'resumed',
      },
    },
    true,
    target,
    'work',
  );
  expect(mockPlayback.speakAnnouncement).toHaveBeenLastCalledWith(
    'native-token',
    'work · codex needs attention',
    'zh-TW',
  );
});

test('waits for speech completion before executing Rust scheduling effects', async () => {
  const playback = deferred<SpeechEndReason>();
  let request!: LocalAlertRequest;
  mockNative.alert.mockImplementation(value => {
    request = value;
    return speak(value);
  });
  mockPlayback.speakAnnouncement.mockReturnValue(playback.promise);
  mockNative.completeEffect.mockImplementation(id =>
    id === 'speech'
      ? [effect('schedule', new LocalAlertAction.Schedule({ request }))]
      : [],
  );
  const pending = alertAgent(agent, true, target);
  await Promise.resolve();
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  playback.resolve('completed');
  await pending;
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
});

test.each(['all', 'pane', 'tab'] as const)(
  '%s dismissal forwards a late scheduling result for Rust cleanup',
  async scope => {
    const scheduled = deferred<string>();
    jest
      .mocked(Notifications.scheduleNotificationAsync)
      .mockReturnValue(scheduled.promise);
    mockNative.completeEffect.mockImplementation(id =>
      id === 'schedule'
        ? [
            effect(
              'cleanup',
              new LocalAlertAction.DismissNotification({
                notificationId: 'late',
              }),
            ),
          ]
        : [],
    );
    const pending = alertAgent(agent, false, target);
    if (scope === 'all') await dismissAgentAlerts();
    else if (scope === 'pane')
      await dismissAgentAlertsForPane(target.hostId, target.paneId);
    else await dismissAgentAlertsForTab(target.hostId, agent.tab_id);
    scheduled.resolve('late');
    await pending;
    expect(mockNative.dismiss).toHaveBeenCalledWith(
      expect.objectContaining({
        tag: scope === 'all' ? 'All' : scope === 'pane' ? 'Pane' : 'Tab',
      }),
    );
    expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith('late');
    expect(armPersistentAgentAlert).not.toHaveBeenCalled();
  },
);

test.each(['all', 'pane', 'tab'] as const)(
  '%s dismissal stops a pending announcement by its Rust token',
  async scope => {
    const playback = deferred<SpeechEndReason>();
    mockNative.alert.mockImplementation(speak);
    mockPlayback.speakAnnouncement.mockReturnValue(playback.promise);
    mockPlayback.stopAnnouncement.mockImplementation(async () => {
      playback.resolve('stopped');
    });
    mockNative.dismiss.mockReturnValue([
      effect(
        'stop',
        new LocalAlertAction.StopSpeech({ token: 'native-token' }),
      ),
    ]);
    const pending = alertAgent(agent, true, target);
    await Promise.resolve();
    if (scope === 'all') await dismissAgentAlerts();
    else if (scope === 'pane')
      await dismissAgentAlertsForPane(target.hostId, target.paneId);
    else await dismissAgentAlertsForTab(target.hostId, agent.tab_id);
    await pending;
    expect(mockPlayback.stopAnnouncement).toHaveBeenCalledWith('native-token');
    expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  },
);

test('honors cancelled admission before starting TTS and ignores duplicate effects', async () => {
  mockNative.alert.mockImplementation(speak);
  mockNative.beginEffect.mockReturnValueOnce(LocalAlertEffectAdmission.Skip);
  await alertAgent(agent, true, target);
  expect(mockPlayback.speakAnnouncement).not.toHaveBeenCalled();
  expect(mockNative.completeEffect).toHaveBeenCalledWith(
    'speech',
    new LocalAlertOutcome.Skipped(),
  );
  mockNative.completeEffect.mockClear();
  mockNative.beginEffect.mockReturnValueOnce(
    LocalAlertEffectAdmission.Duplicate,
  );
  await alertAgent(agent, true, target);
  expect(mockNative.completeEffect).not.toHaveBeenCalled();
});

test('out-of-order schedules retain their effect and host identities', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  mockNative.alert.mockImplementation(request => [
    effect(request.hostId, new LocalAlertAction.Schedule({ request })),
  ]);
  jest
    .mocked(Notifications.scheduleNotificationAsync)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const pendingFirst = alertAgent(agent, false, target);
  const pendingSecond = alertAgent(agent, false, {
    ...target,
    hostId: 'other',
  });
  second.resolve('second');
  await pendingSecond;
  first.resolve('first');
  await pendingFirst;
  expect(mockNative.completeEffect).toHaveBeenNthCalledWith(
    1,
    'other',
    new LocalAlertOutcome.Scheduled({ notificationId: 'second' }),
  );
  expect(mockNative.completeEffect).toHaveBeenNthCalledWith(
    2,
    'host-1',
    new LocalAlertOutcome.Scheduled({ notificationId: 'first' }),
  );
});

test('acknowledges persistent arming and executes targeted cleanup from a late completion', async () => {
  const armed = deferred<undefined>();
  jest.mocked(armPersistentAgentAlert).mockReturnValue(armed.promise);
  mockNative.alert.mockReturnValue([
    effect(
      'arm',
      new LocalAlertAction.ArmPersistent({
        notificationId: 'old',
        timeoutMs: 45_000,
      }),
    ),
  ]);
  mockNative.completeEffect.mockImplementation(id =>
    id === 'arm'
      ? [
          effect(
            'dismiss-persistent',
            new LocalAlertAction.DismissPersistent({ notificationId: 'old' }),
          ),
        ]
      : [],
  );
  const pending = alertAgent(agent, false, target);
  await dismissAgentAlerts();
  armed.resolve(undefined);
  await pending;
  expect(armPersistentAgentAlert).toHaveBeenCalledWith(
    'old',
    'agent-state-v3',
    45_000,
  );
  expect(dismissPersistentAgentAlert).toHaveBeenCalledWith('old');
});

test('runtime replacement and detachment reach Rust with incarnation identity', async () => {
  await dismissAgentAlerts(); // Initialize the application coordinator.
  const old = { runtimeId: 'runtime', runtimeIncarnation: 1 };
  const next = { runtimeId: 'runtime', runtimeIncarnation: 2 };
  bindNotificationRuntime(target.hostId, old);
  bindNotificationRuntime(target.hostId, next);
  unbindNotificationRuntime(target.hostId, old);
  await alertAgent(agent, false, target);
  expect(mockNative.alert).toHaveBeenCalledWith(
    expect.objectContaining({
      runtime: { runtimeId: 'runtime', incarnation: 2n },
    }),
  );
  unbindNotificationRuntime(target.hostId, next);
  expect(mockNative.setRuntime.mock.calls).toEqual([
    [target.hostId, { runtimeId: 'runtime', incarnation: 1n }],
    [target.hostId, { runtimeId: 'runtime', incarnation: 2n }],
    [target.hostId, undefined],
  ]);
});

test.each(['schedule', 'speech', 'arm'] as const)(
  '%s failures are acknowledged and preserve backend readiness semantics',
  async stage => {
    const error = new Error('backend unavailable');
    const log = jest
      .spyOn(console, stage === 'speech' ? 'warn' : 'error')
      .mockImplementation();
    if (stage === 'schedule')
      jest
        .mocked(Notifications.scheduleNotificationAsync)
        .mockRejectedValue(error);
    else if (stage === 'speech') {
      mockNative.alert.mockImplementation(speak);
      mockPlayback.speakAnnouncement.mockRejectedValue(error);
    } else {
      mockNative.alert.mockReturnValue([
        effect(
          'arm',
          new LocalAlertAction.ArmPersistent({
            notificationId: 'id',
            timeoutMs: 30_000,
          }),
        ),
      ]);
      jest.mocked(armPersistentAgentAlert).mockRejectedValue(error);
    }
    const pending = alertAgent(agent, stage === 'speech', target);
    if (stage === 'schedule') await expect(pending).rejects.toThrow(error);
    else await pending;
    expect(mockNative.completeEffect).toHaveBeenCalledWith(
      stage,
      new LocalAlertOutcome.Failed({ message: error.message }),
    );
    expect(notificationDeliveryAvailable()).toBe(stage === 'speech');
    log.mockRestore();
  },
);

test('expected platform dismissal races stay quiet and still complete their effects', async () => {
  mockNative.dismiss.mockReturnValue([
    effect(
      'dismiss',
      new LocalAlertAction.DismissNotification({ notificationId: 'removed' }),
    ),
  ]);
  jest.mocked(Notifications.dismissNotificationAsync).mockRejectedValue(
    Object.assign(new Error('already dismissed'), {
      code: 'ERR_NOTIFICATION_NOT_FOUND',
    }),
  );
  const log = jest.spyOn(console, 'warn').mockImplementation();
  await dismissAgentAlerts();
  expect(log).not.toHaveBeenCalled();
  expect(mockNative.completeEffect).toHaveBeenCalledWith(
    'dismiss',
    new LocalAlertOutcome.Failed({ message: 'already dismissed' }),
  );
  log.mockRestore();
});

test('prepares Android channels and permissions and keeps iOS channel setup platform-specific', async () => {
  await prepareAlerts();
  expect(Notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
    'agent-state-regular-v1',
    { name: 'alerts.regularChannelName', importance: 'default' },
  );
  expect(Notifications.requestPermissionsAsync).toHaveBeenCalled();
  jest.mocked(Notifications.setNotificationChannelAsync).mockClear();
  Platform.OS = 'ios';
  await prepareAlerts();
  expect(Notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
});

test('initialization rejection is diagnosed and disables delivery', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation();
  jest
    .mocked(Notifications.setNotificationChannelAsync)
    .mockRejectedValueOnce(new Error('unavailable'));
  await expect(prepareAlerts()).rejects.toThrow('unavailable');
  expect(notificationDeliveryAvailable()).toBe(false);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining('notification-setup-failed'),
  );
  log.mockRestore();
});

test('a failed speech stop does not block unrelated notification cleanup', async () => {
  mockNative.dismiss.mockReturnValue([
    effect('stop', new LocalAlertAction.StopSpeech({ token: 'old-token' })),
    effect(
      'cleanup',
      new LocalAlertAction.DismissNotification({
        notificationId: 'old-notification',
      }),
    ),
  ]);
  mockPlayback.stopAnnouncement.mockRejectedValueOnce(
    new Error('player stopped responding'),
  );
  const log = jest.spyOn(console, 'warn').mockImplementation();
  await dismissAgentAlerts();
  expect(mockNative.completeEffect).toHaveBeenCalledWith(
    'stop',
    new LocalAlertOutcome.Failed({ message: 'player stopped responding' }),
  );
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledWith(
    'old-notification',
  );
  expect(mockNative.completeEffect).toHaveBeenCalledWith(
    'cleanup',
    new LocalAlertOutcome.Done(),
  );
  log.mockRestore();
});
