/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { performance as nodePerformance } from 'node:perf_hooks';
import { build } from 'esbuild';

// The React Native Jest preset replaces performance with an incomplete mock.
// Undici captures markResourceTiming when Miniflare is first imported.
Object.defineProperty(globalThis, 'performance', { configurable: true, value: nodePerformance });
const { Miniflare, Response: WorkerResponse, convertV4MiniflareOptions } = require('miniflare') as typeof import('miniflare');

const DEVICE = 'runtime-device-0000000001';
const OWNER = 'owner'.repeat(12);
const ROUTE = 'route'.repeat(12);
const HOST = 'host'.repeat(11);
const KEY = 'key'.repeat(15);

test('real Workers runtime enrolls, routes ciphertext, revokes, and rejects provider redirects', async () => {
  const output = await build({
    entryPoints: ['notify-relay/src/index.ts'],
    bundle: true,
    format: 'esm',
    write: false,
  });
  const messages: Record<string, unknown>[] = [];
  let redirect = false;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: output.outputFiles[0].text,
    // Stay within the runtime bundled with Wrangler; no newer APIs are used.
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'],
    ratelimits: { LIMITER: { namespace_id: '1001', simple: { limit: 60, period: 60 } } },
    outboundService: async request => {
      expect(new URL(request.url).origin).toBe('https://exp.host');
      messages.push(await request.json() as Record<string, unknown>);
      return redirect
        ? new WorkerResponse(null, { status: 307, headers: { Location: 'https://unexpected.example/' } })
        : WorkerResponse.json({ data: { status: 'ok', id: `ticket-${messages.length}` } });
    },
  }));
  try {
    const database = await runtime.getD1Database('DB');
    for (const file of ['0001.sql', '0002_public_registration.sql', '0003_device_message_rate.sql']) {
      const sql = readFileSync(`notify-relay/migrations/${file}`, 'utf8').replace(/^--.*$/gm, '');
      for (const statement of sql.split(';').filter(part => part.trim())) {
        await database.prepare(statement).run();
      }
    }
    const call = (path: string, method: string, token: string, value?: unknown) => runtime.dispatchFetch(
      `https://notify.example${path}`,
      { method, headers: { Authorization: `Bearer ${token}` }, ...(value ? { body: JSON.stringify(value) } : {}) },
    );
    const registration = { protocol: 2, expo_token: 'ExpoPushToken[runtime]', route_token: ROUTE, host_id: HOST, key_id: KEY };
    const path = `/v1/devices/${DEVICE}`;
    expect((await call(path, 'PUT', OWNER, registration)).status).toBe(202);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe('Setting up push notifications.');
    const verification = messages[0].data as { whip_notify_registration: { challenge: string } };
    expect((await call(path, 'POST', OWNER, { challenge: verification.whip_notify_registration.challenge })).status).toBe(200);
    const envelope = {
      header: { version: 1, host_id: HOST, device_id: DEVICE, key_id: KEY, event_id: 'runtime-event-000000001', issued_at: Math.floor(Date.now() / 1000) },
      enc: 'a'.repeat(43), ciphertext: 'b'.repeat(1387),
    };
    expect((await call('/v1/push', 'POST', ROUTE, envelope)).status).toBe(202);
    expect(messages[1].data).toEqual({ whip_notify: envelope });
    const readable = { ...envelope, header: { ...envelope.header, event_id: 'runtime-readable-0000001' } };
    const preview = { title: 'Checkout · codex finished', body: 'Updated checkout tests' };
    expect((await call('/v1/push', 'POST', ROUTE, { ...readable, preview })).status).toBe(202);
    expect(messages[2]).toMatchObject(preview);
    expect(messages[2].data).toEqual({ whip_notify: readable });
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => call('/v1/push', 'POST', ROUTE, {
      ...envelope, header: { ...envelope.header, event_id: `runtime-burst-${String(i).padStart(10, '0')}` },
    })));
    // One setup push and two agent messages already consumed three slots.
    expect(burst.filter(response => response.status === 202)).toHaveLength(7);
    expect(burst.filter(response => response.status === 429)).toHaveLength(1);
    expect((await call(path, 'DELETE', OWNER)).status).toBe(200);
    expect((await call('/v1/push', 'POST', ROUTE, envelope)).status).toBe(403);
    redirect = true;
    expect((await call(path, 'PUT', OWNER, { ...registration, expo_token: 'ExpoPushToken[redirect]' })).status).toBe(503);
    expect(messages).toHaveLength(11);
    expect((await database.prepare('SELECT COUNT(*) AS count FROM pending_registrations').first<{count: number}>())?.count).toBe(0);
  } finally {
    await runtime.dispose();
  }
}, 30_000);
