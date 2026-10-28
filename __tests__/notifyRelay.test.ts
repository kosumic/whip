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
const INVITE = 'invite'.repeat(10);
const HOST = 'host'.repeat(11);
const KEY = 'key'.repeat(15);
const EXPO = 'ExpoPushToken[test-token]';
let database: DatabaseSync;
let env: RelayEnv;
let provider: jest.Mock;
function mockDatabase(): D1Database {
  return {
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
  invite = INVITE,
): Request {
  return new Request(`https://notify.example.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Enrollment-Token': invite },
    body: data ? JSON.stringify(data) : undefined,
  });
}
async function enroll(owner = OWNER): Promise<Response> {
  return handleRequest(
    request(`/v1/devices/${DEVICE}`, 'PUT', owner, {
      expo_token: EXPO,
      route_token: ROUTE,
      host_id: HOST,
      key_id: KEY,
    }),
    env,
  );
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
  env = {
    DB: mockDatabase(),
    LIMITER: { limit: jest.fn().mockResolvedValue({ success: true }) },
    ENROLLMENT_TOKEN: INVITE,
    EXPO_ACCESS_TOKEN: 'provider-secret',
  };
  provider = jest
    .fn()
    .mockResolvedValue(
      Response.json({ data: { status: 'ok', id: 'ticket-1' } }),
    );
  globalThis.fetch = provider;
});
afterEach(() => database.close());
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
test('rejects unauthorized enrollment, substitution and wrong route capabilities', async () => {
  const badInvite = request(
    `/v1/devices/${DEVICE}`,
    'PUT',
    OWNER,
    { expo_token: EXPO, route_token: ROUTE, host_id: HOST, key_id: KEY },
    'wrong',
  );
  expect((await handleRequest(badInvite, env)).status).toBe(403);
  await enroll();
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
test('missing deployment enrollment secret fails closed', async () => {
  env.ENROLLMENT_TOKEN = '';
  expect((await enroll()).status).toBe(503);
  expect(provider).not.toHaveBeenCalled();
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
