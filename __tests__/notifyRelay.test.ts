/** @jest-environment node */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { webcrypto, timingSafeEqual } from 'node:crypto';
import {
  handleRequest,
  checkReceipts,
  type RelayEnv,
} from '../notify-relay/src';

const DEVICE = 'device'.repeat(8);
const OWNER = 'owner'.repeat(12);
const ROUTE = 'route'.repeat(12);
const HOST = 'host'.repeat(11);
const KEY = 'key'.repeat(15);
const EXPO = 'ExpoPushToken[test-token]';
let database: DatabaseSync;
let env: RelayEnv;
let provider: jest.Mock;
function mockDatabase(): D1Database {
  return {
    batch(statements: D1PreparedStatement[]) {
      database.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.run());
        database.exec('COMMIT');
        return Promise.all(results);
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    prepare(sql: string) {
      const statement = database.prepare(sql);
      let args: (string | number | null)[] = [];
      const query = {
        bind(...values: (string | number | null)[]) {
          args = values;
          return query;
        },
        first() {
          return Promise.resolve(statement.get(...args) || null);
        },
        run() {
          const info = statement.run(...args);
          return Promise.resolve({
            success: true,
            meta: { changes: Number(info.changes) },
          });
        },
        all() {
          return Promise.resolve({
            success: true,
            results: statement.all(...args),
          });
        },
      };
      return query;
    },
  } as unknown as D1Database;
}
function request(
  path: string,
  method: string,
  token: string,
  data?: unknown,
): Request {
  return new Request(`https://notify.example.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: data ? JSON.stringify(data) : undefined,
  });
}
async function begin(
  owner = OWNER,
  device = DEVICE,
  expoToken = EXPO,
  routeToken = ROUTE,
): Promise<Response> {
  return handleRequest(
    request(`/v1/devices/${device}`, 'PUT', owner, {
      protocol: 2,
      expo_token: expoToken,
      route_token: routeToken,
      host_id: HOST,
      key_id: KEY,
    }),
    env,
  );
}
function proof(): string {
  const sent = JSON.parse(provider.mock.calls.at(-1)![1].body as string);
  return sent.data.whip_notify_registration.challenge as string;
}
function confirm(
  challenge: string,
  owner = OWNER,
  device = DEVICE,
): Promise<Response> {
  return handleRequest(
    request(`/v1/devices/${device}`, 'POST', owner, { challenge }),
    env,
  );
}
async function enroll(owner = OWNER): Promise<Response> {
  const started = await begin(owner);
  if (started.status !== 202) return started;
  const confirmed = await confirm(proof(), owner);
  provider.mockClear();
  return confirmed;
}
function payload() {
  return {
    header: {
      version: 1,
      host_id: HOST,
      device_id: DEVICE,
      key_id: KEY,
      event_id: 'event'.repeat(8),
      issued_at: Math.floor(Date.now() / 1000),
    },
    enc: 'a'.repeat(43),
    ciphertext: 'b'.repeat(1387),
  };
}
beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: webcrypto,
  });
  if (!('timingSafeEqual' in webcrypto.subtle))
    Object.defineProperty(webcrypto.subtle, 'timingSafeEqual', {
      value: timingSafeEqual,
      configurable: true,
    });
  database = new DatabaseSync(':memory:');
  database.exec(readFileSync('notify-relay/migrations/0001.sql', 'utf8'));
  database.exec(
    readFileSync(
      'notify-relay/migrations/0002_public_registration.sql',
      'utf8',
    ),
  );
  database.exec(readFileSync('notify-relay/migrations/0003_device_message_rate.sql', 'utf8'));
  env = {
    DB: mockDatabase(),
    LIMITER: { limit: jest.fn().mockResolvedValue({ success: true }) },
    EXPO_ACCESS_TOKEN: 'provider-secret',
  };
  provider = jest
    .fn()
    .mockImplementation(async () =>
      Response.json({ data: { status: 'ok', id: 'ticket-1' } }),
    );
  globalThis.fetch = provider;
});
afterEach(() => database.close());
test('a device gets at most ten sends in any rolling minute, including setup, with no fixed-window burst', async () => {
  const now = 1_000_000;
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  try {
    await enroll(); // The setup verification is the first send.
    const send = (id: number) => handleRequest(request('/v1/push', 'POST', ROUTE, {
      ...payload(), header: { ...payload().header, event_id: `budget-event-${String(id).padStart(16, '0')}` },
    }), env);
    for (let i = 0; i < 9; i++) expect((await send(i)).status).toBe(202);
    expect(provider).toHaveBeenCalledTimes(9);
    expect((await send(9)).status).toBe(429);
    // The same accepted event is deduplicated without consuming another slot.
    expect((await send(0)).status).toBe(200);
    clock.mockReturnValue(now + 59_999);
    expect((await send(9)).status).toBe(429);
    clock.mockReturnValue(now + 60_000);
    expect((await send(9)).status).toBe(202);
    expect(provider).toHaveBeenCalledTimes(10);
    expect(database.prepare('SELECT COUNT(*) AS count FROM device_message_attempts').get()?.count).toBe(11);
    await checkReceipts(env);
    expect(database.prepare('SELECT COUNT(*) AS count FROM device_message_attempts').get()?.count).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

test('host registrations share the receiving device budget and other devices stay independent', async () => {
  await enroll();
  const secondDevice = 'second-device-00000000001';
  const secondRoute = 'second-route'.repeat(5);
  expect((await begin(OWNER, secondDevice, EXPO, secondRoute)).status).toBe(202);
  expect((await confirm(proof(), OWNER, secondDevice)).status).toBe(200);
  provider.mockClear();
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => handleRequest(request('/v1/push', 'POST', i % 2 ? ROUTE : secondRoute, {
    ...payload(), header: { ...payload().header, device_id: i % 2 ? DEVICE : secondDevice, event_id: `shared-event-${String(i).padStart(16, '0')}` },
  }), env)));
  expect(burst.filter(response => response.status === 202)).toHaveLength(8);
  expect(burst.filter(response => response.status === 429)).toHaveLength(2);
  expect(provider).toHaveBeenCalledTimes(8);
  const independentDevice = 'independent-device-000001';
  const independentRoute = 'independent-route'.repeat(3);
  expect((await begin(OWNER, independentDevice, 'ExpoPushToken[other-device]', independentRoute)).status).toBe(202);
  expect((await confirm(proof(), OWNER, independentDevice)).status).toBe(200);
  expect((await handleRequest(request('/v1/push', 'POST', independentRoute, {
    ...payload(), header: { ...payload().header, device_id: independentDevice },
  }), env)).status).toBe(202);
});

test('failed provider attempts consume the device budget and cannot be retried past ten sends', async () => {
  await enroll();
  provider.mockRejectedValue(new Error('ambiguous network response'));
  for (let i = 0; i < 9; i++)
    expect((await handleRequest(request('/v1/push', 'POST', ROUTE, payload()), env)).status).toBe(503);
  expect((await handleRequest(request('/v1/push', 'POST', ROUTE, payload()), env)).status).toBe(429);
  expect(provider).toHaveBeenCalledTimes(9);
});

test('readable previews expose agent details while retaining only authenticated routing in data', async () => {
  await enroll();
  const envelope = payload();
  const preview = { title: 'Checkout · codex needs you', body: 'Review the checkout fix' };
  expect((await handleRequest(request('/v1/push', 'POST', ROUTE, {
    ...envelope, preview: { ...preview, url: 'https://unexpected.example' },
    hostId: 'forged-host', paneId: 'forged-pane',
  }), env)).status).toBe(202);
  const sent = JSON.parse(provider.mock.calls[0][1].body);
  expect(sent).toMatchObject(preview);
  expect(sent.data).toEqual({ whip_notify: envelope });
});

test.each([
  { title: '', body: 'Task' },
  { title: 'codex needs you' },
  { title: '🦀'.repeat(41), body: 'Task' },
  { title: 'codex needs you', body: 'x'.repeat(321) },
  { title: 'codex\nneeds you', body: 'Task' },
])('invalid or oversized preview is rejected: %j', async preview => {
  await enroll();
  expect((await handleRequest(request('/v1/push', 'POST', ROUTE, { ...payload(), preview }), env)).status).toBe(400);
  expect(provider).not.toHaveBeenCalled();
});

test('authenticated enrollment, generic ciphertext routing, duplicate suppression and revocation', async () => {
  expect((await enroll()).status).toBe(200);
  expect(
    (await handleRequest(request('/v1/push', 'POST', ROUTE, payload()), env))
      .status,
  ).toBe(202);
  const sent = JSON.parse(
    (provider.mock.calls[0][1] as RequestInit).body as string,
  ) as { title: string; body: string; data: unknown; to: string };
  expect(sent.to).toBe(EXPO);
  expect(sent.title).toBe('Whip');
  expect(sent.body).not.toMatch(/blocked|done|pane/);
  expect(sent.data).toEqual({ whip_notify: payload() });
  expect(
    (await handleRequest(request('/v1/push', 'POST', ROUTE, payload()), env))
      .status,
  ).toBe(200);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(
    (
      await handleRequest(
        request(`/v1/devices/${DEVICE}`, 'DELETE', OWNER),
        env,
      )
    ).status,
  ).toBe(200);
  expect(
    (await handleRequest(request('/v1/push', 'POST', ROUTE, payload()), env))
      .status,
  ).toBe(403);
  expect((await enroll('attacker'.repeat(8))).status).toBe(403);
});
test('rejects ownership takeover, substitution and wrong route capabilities', async () => {
  await enroll();
  expect((await begin('attacker'.repeat(8))).status).toBe(403);
  expect(
    (
      await handleRequest(
        request('/v1/push', 'POST', 'wrong'.repeat(12), payload()),
        env,
      )
    ).status,
  ).toBe(403);
  for (const field of ['host_id', 'device_id', 'key_id'] as const) {
    const changed = payload();
    changed.header[field] = 'attacker'.repeat(6);
    expect(
      (await handleRequest(request('/v1/push', 'POST', ROUTE, changed), env))
        .status,
    ).toBe(403);
  }
});
test('network and provider errors are retryable without retaining plaintext', async () => {
  await enroll();
  provider.mockRejectedValueOnce(new Error('network failed'));
  expect(
    (await handleRequest(request('/v1/push', 'POST', ROUTE, payload()), env))
      .status,
  ).toBe(503);
  expect(
    (await handleRequest(request('/v1/push', 'POST', ROUTE, payload()), env))
      .status,
  ).toBe(202);
  expect(provider).toHaveBeenCalledTimes(2);
  const row = database.prepare('SELECT * FROM devices').get();
  expect(row).not.toHaveProperty('private_key');
  expect(row).not.toHaveProperty('route_token');
});
test('provider token revocation and asynchronous receipts stop future delivery', async () => {
  await enroll();
  provider.mockResolvedValueOnce(
    Response.json({
      data: { status: 'error', details: { error: 'DeviceNotRegistered' } },
    }),
  );
  expect(
    (await handleRequest(request('/v1/push', 'POST', ROUTE, payload()), env))
      .status,
  ).toBe(410);
  await enroll();
  const next = payload();
  next.header.event_id = 'next'.repeat(8);
  await handleRequest(request('/v1/push', 'POST', ROUTE, next), env);
  provider.mockResolvedValueOnce(
    Response.json({
      data: {
        'ticket-1': {
          status: 'error',
          details: { error: 'DeviceNotRegistered' },
        },
      },
    }),
  );
  await checkReceipts(env);
  expect(
    database.prepare('SELECT expo_token FROM devices').get()?.expo_token,
  ).toBeNull();
});
test('enforces rate and body bounds before sending to Expo', async () => {
  (env.LIMITER.limit as jest.Mock).mockResolvedValue({ success: false });
  expect((await enroll()).status).toBe(429);
  (env.LIMITER.limit as jest.Mock).mockResolvedValue({ success: true });
  expect(
    (
      await handleRequest(
        request('/v1/push', 'POST', ROUTE, { ciphertext: 'a'.repeat(4000) }),
        env,
      )
    ).status,
  ).toBe(413);
  expect(provider).not.toHaveBeenCalled();
});

test('stale provider receipt cannot revoke a rotated push token', async () => {
  await enroll();
  await handleRequest(request('/v1/push', 'POST', ROUTE, payload()), env);
  database
    .prepare('UPDATE devices SET expo_token = ?')
    .run('ExpoPushToken[rotated]');
  provider.mockResolvedValueOnce(
    Response.json({
      data: {
        'ticket-1': {
          status: 'error',
          details: { error: 'DeviceNotRegistered' },
        },
      },
    }),
  );
  await checkReceipts(env);
  expect(
    database.prepare('SELECT expo_token FROM devices').get()?.expo_token,
  ).toBe('ExpoPushToken[rotated]');
});
test('legacy apps must update instead of enabling an unverified route', async () => {
  const result = await handleRequest(
    request(`/v1/devices/${DEVICE}`, 'PUT', OWNER, {
      expo_token: EXPO,
      route_token: ROUTE,
      host_id: HOST,
      key_id: KEY,
    }),
    env,
  );
  expect(result.status).toBe(426);
  expect(provider).not.toHaveBeenCalled();
});

test('public registration requires a proof delivered only to the receiving push token', async () => {
  const response = await begin();
  expect(response.status).toBe(202);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(JSON.parse(provider.mock.calls[0][1].body as string)).toMatchObject({
    title: 'Whip',
    body: 'Setting up push notifications.',
    data: {
      whip_notify_registration: {
        device_id: DEVICE,
        challenge: expect.any(String),
      },
    },
  });
  const challenge = proof();
  expect(JSON.stringify(await response.json())).not.toContain(challenge);
  expect(database.prepare('SELECT * FROM devices').all()).toHaveLength(0);
  expect(
    (await handleRequest(request('/v1/push', 'POST', ROUTE, payload()), env))
      .status,
  ).toBe(403);
  expect((await confirm('wrong'.repeat(10))).status).toBe(403);
  expect((await confirm(challenge, 'attacker'.repeat(8))).status).toBe(403);
  expect((await confirm(challenge, OWNER, 'other'.repeat(8))).status).toBe(403);
  expect((await confirm(challenge)).status).toBe(200);
  expect((await confirm(challenge)).status).toBe(403);
  expect(
    database.prepare('SELECT * FROM pending_registrations').all(),
  ).toHaveLength(0);
});

test.each(['expired', 'revoked'])(
  '%s registration proofs cannot activate a route',
  async reason => {
    await begin();
    const challenge = proof();
    if (reason === 'expired')
      database
        .prepare('UPDATE pending_registrations SET expires_at = ?')
        .run(Math.floor(Date.now() / 1000));
    else
      await handleRequest(
        request(`/v1/devices/${DEVICE}`, 'DELETE', OWNER),
        env,
      );
    expect((await confirm(challenge)).status).toBe(403);
    expect(database.prepare('SELECT * FROM devices').all()).toHaveLength(0);
  },
);

test('concurrent confirmations consume the proof exactly once', async () => {
  await begin();
  const challenge = proof();
  const responses = await Promise.all([confirm(challenge), confirm(challenge)]);
  expect(responses.map(response => response.status).sort()).toEqual([200, 403]);
});

test('concurrent revocation and confirmation cannot reactivate a route', async () => {
  await begin();
  const challenge = proof();
  await Promise.all([
    confirm(challenge),
    handleRequest(request(`/v1/devices/${DEVICE}`, 'DELETE', OWNER), env),
  ]);
  const device = database
    .prepare('SELECT expo_token FROM devices WHERE id = ?')
    .get(DEVICE);
  expect(device?.expo_token ?? null).toBeNull();
  expect(
    database.prepare('SELECT * FROM pending_registrations').all(),
  ).toHaveLength(0);
});

test('confirmation uses the parameters bound before push verification', async () => {
  await begin();
  const response = await handleRequest(
    request(`/v1/devices/${DEVICE}`, 'POST', OWNER, {
      challenge: proof(),
      expo_token: 'ExpoPushToken[victim]',
      host_id: 'attacker'.repeat(8),
    }),
    env,
  );
  expect(response.status).toBe(200);
  expect(
    database.prepare('SELECT expo_token, host_id FROM devices').get(),
  ).toEqual({ expo_token: EXPO, host_id: HOST });
});

test('registration push limits apply across device IDs and cannot be reset by changing IPs', async () => {
  for (let index = 0; index < 6; index++) {
    expect(
      (await begin(OWNER, `device-${String(index).padStart(20, '0')}`)).status,
    ).toBe(202);
  }
  const registration = request(
    '/v1/devices/' + 'other'.repeat(8),
    'PUT',
    OWNER,
    {
      protocol: 2,
      expo_token: EXPO,
      route_token: ROUTE,
      host_id: HOST,
      key_id: KEY,
    },
  );
  registration.headers.set('CF-Connecting-IP', '192.0.2.2');
  expect((await handleRequest(registration, env)).status).toBe(429);
  expect(provider).toHaveBeenCalledTimes(6);
});

test('failed provider verification leaves no route and can be retried', async () => {
  provider.mockRejectedValueOnce(new Error('offline'));
  expect((await begin()).status).toBe(503);
  expect(
    database.prepare('SELECT * FROM pending_registrations').all(),
  ).toHaveLength(0);
  expect(database.prepare('SELECT * FROM devices').all()).toHaveLength(0);
  expect((await enroll()).status).toBe(200);
});

test.each([401, 403])('provider HTTP %s identifies relay credentials without exposing provider details', async status => {
  provider.mockResolvedValueOnce(Response.json({ errors: [{ message: 'private-provider-detail' }] }, { status }));
  const response = await begin();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Request rejected', code: 'PUSH_PROVIDER_AUTH_FAILED' });
  expect(database.prepare('SELECT * FROM pending_registrations').all()).toHaveLength(0);
  expect(database.prepare('SELECT * FROM devices').all()).toHaveLength(0);
  expect((await enroll()).status).toBe(200);
});

test('unregister is idempotent after an interrupted enrollment', async () => {
  expect(
    (
      await handleRequest(
        request('/v1/devices/' + DEVICE, 'DELETE', OWNER),
        env,
      )
    ).status,
  ).toBe(200);
  expect(provider).not.toHaveBeenCalled();
});
