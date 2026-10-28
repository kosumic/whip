/// <reference types="@cloudflare/workers-types" />
export type RelayEnv = NotifyEnv & { EXPO_ACCESS_TOKEN?: string };
declare const crypto: import('@cloudflare/workers-types').Crypto;

const ID = /^[a-zA-Z0-9_-]{16,64}$/;
const TOKEN = /^[a-zA-Z0-9_-]{43,64}$/;
const EXPO_TOKEN = /^(?:ExponentPushToken|ExpoPushToken)\[[a-zA-Z0-9_-]+\]$/;
const MAX_BYTES = 3072;
const EXPO_ORIGIN = 'https://exp.host/--/api/v2/push';
const DAY = 86_400;
interface Device {
  id: string;
  owner_hash: string;
  route_hash: string | null;
  expo_token: string | null;
  host_id: string;
  key_id: string;
}
interface Header {
  version: number;
  host_id: string;
  device_id: string;
  key_id: string;
  event_id: string;
  issued_at: number;
}
interface Envelope {
  header: Header;
  enc: string;
  ciphertext: string;
}
interface Ticket {
  status: string;
  id?: string;
  details?: { error?: string };
}

function providerTicket(value: unknown): Ticket {
  const fields = object(value);
  if (typeof fields.status !== 'string')
    throw new Error('Invalid push response');
  const details = fields.details ? object(fields.details) : {};
  return {
    status: fields.status,
    id: typeof fields.id === 'string' ? fields.id : undefined,
    details:
      typeof details.error === 'string' ? { error: details.error } : undefined,
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
class HttpError extends Error {
  constructor(readonly status: number) {
    super('Request rejected');
  }
}
function reject(status: number): never {
  throw new HttpError(status);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(400);
  return value as Record<string, unknown>;
}
function string(value: unknown, pattern = ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) reject(400);
  return value;
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) reject(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        reject(413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return reject(400);
  }
}
async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  )
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
function bearer(request: Request): string {
  const value = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  return string(value, TOKEN);
}
async function equalSecret(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([hash(a), hash(b)]);
  return crypto.subtle.timingSafeEqual(
    new TextEncoder().encode(left),
    new TextEncoder().encode(right),
  );
}
function envelope(value: Record<string, unknown>): Envelope {
  const h = object(value.header);
  const now = Math.floor(Date.now() / 1000);
  if (
    h.version !== 1 ||
    typeof h.issued_at !== 'number' ||
    !Number.isSafeInteger(h.issued_at) ||
    h.issued_at < now - DAY ||
    h.issued_at > now + 300
  )
    reject(400);
  return {
    header: {
      version: 1,
      host_id: string(h.host_id),
      device_id: string(h.device_id),
      key_id: string(h.key_id),
      event_id: string(h.event_id),
      issued_at: h.issued_at,
    },
    enc: string(value.enc, /^[a-zA-Z0-9_-]{43}$/),
    ciphertext: string(value.ciphertext, /^[a-zA-Z0-9_-]{1387}$/),
  };
}
async function expo(
  env: RelayEnv,
  endpoint: string,
  value: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${EXPO_ORIGIN}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.EXPO_ACCESS_TOKEN
        ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(value),
    signal: AbortSignal.timeout(2500),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('Push provider unavailable');
  return object(await response.json());
}
async function register(
  request: Request,
  env: RelayEnv,
  id: string,
): Promise<Response> {
  const ownerHash = await hash(bearer(request));
  const existing = await env.DB.prepare('SELECT * FROM devices WHERE id = ?')
    .bind(id)
    .first<Device>();
  if (request.method === 'DELETE') {
    if (!existing) return json({ ok: true });
    if (!(await equalSecret(existing.owner_hash, ownerHash))) reject(403);
    // Tombstone retains ownership; an old enrollment invite cannot resurrect a revoked route.
    await env.DB.prepare(
      'UPDATE devices SET route_hash = NULL, expo_token = NULL WHERE id = ? AND owner_hash = ?',
    )
      .bind(id, ownerHash)
      .run();
    await env.DB.prepare('DELETE FROM deliveries WHERE device_id = ?')
      .bind(id)
      .run();
    return json({ ok: true });
  }
  if (
    existing
      ? !(await equalSecret(existing.owner_hash, ownerHash))
      : !(await equalSecret(
          request.headers.get('X-Enrollment-Token') || '',
          env.ENROLLMENT_TOKEN,
        ))
  )
    reject(403);
  const input = await body(request);
  const token = string(input.expo_token, EXPO_TOKEN);
  const routeHash = await hash(string(input.route_token, TOKEN));
  const hostId = string(input.host_id);
  const keyId = string(input.key_id);
  await env.DB.prepare(
    `INSERT INTO devices(id, owner_hash, route_hash, expo_token, host_id, key_id) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET route_hash = excluded.route_hash, expo_token = excluded.expo_token, host_id = excluded.host_id, key_id = excluded.key_id WHERE devices.owner_hash = excluded.owner_hash`,
  )
    .bind(id, ownerHash, routeHash, token, hostId, keyId)
    .run();
  return json({ ok: true });
}
async function push(request: Request, env: RelayEnv): Promise<Response> {
  const payload = envelope(await body(request));
  const h = payload.header;
  const routeHash = await hash(bearer(request));
  const device = await env.DB.prepare(
    'SELECT * FROM devices WHERE id = ? AND route_hash = ?',
  )
    .bind(h.device_id, routeHash)
    .first<Device>();
  if (
    !device?.expo_token ||
    device.host_id !== h.host_id ||
    device.key_id !== h.key_id
  )
    reject(403);
  if (!(await env.LIMITER.limit({ key: `device:${device.id}` })).success)
    reject(429);
  const reservation = await env.DB.prepare(
    'INSERT OR IGNORE INTO deliveries(device_id, event_id, expires_at, token_hash) VALUES (?, ?, ?, ?)',
  )
    .bind(
      device.id,
      h.event_id,
      h.issued_at + DAY + 300,
      await hash(device.expo_token),
    )
    .run();
  if (!reservation.meta.changes) return json({ ok: true, duplicate: true });
  try {
    const reply = await expo(env, 'send', {
      to: device.expo_token,
      title: 'Whip',
      body: 'An agent has an update. Open Whip to view it.',
      sound: 'default',
      priority: 'high',
      channelId: 'agent-state-regular-v1',
      ttl: Math.max(
        1,
        Math.min(DAY, h.issued_at + DAY - Math.floor(Date.now() / 1000)),
      ),
      data: { whip_notify: payload },
    });
    const ticket = providerTicket(reply.data);
    if (ticket.status !== 'ok' || typeof ticket.id !== 'string') {
      if (ticket.details?.error === 'DeviceNotRegistered') {
        await env.DB.prepare(
          'UPDATE devices SET expo_token = NULL WHERE id = ? AND expo_token = ?',
        )
          .bind(device.id, device.expo_token)
          .run();
        return json({ error: 'Device unregistered' }, 410);
      }
      throw new Error('Push provider rejected message');
    }
    await env.DB.prepare(
      'UPDATE deliveries SET ticket = ? WHERE device_id = ? AND event_id = ?',
    )
      .bind(ticket.id, device.id, h.event_id)
      .run();
    return json({ ok: true }, 202);
  } catch {
    await env.DB.prepare(
      'DELETE FROM deliveries WHERE device_id = ? AND event_id = ?',
    )
      .bind(device.id, h.event_id)
      .run();
    return json({ error: 'Push provider unavailable' }, 503);
  }
}
export async function handleRequest(
  request: Request,
  env: RelayEnv,
): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/health')
      return json({ ok: true, protocol: 1 });
    if (!env.ENROLLMENT_TOKEN || !TOKEN.test(env.ENROLLMENT_TOKEN))
      return json({ error: 'Relay unavailable' }, 503);
    if (
      !(
        await env.LIMITER.limit({
          key: `ip:${request.headers.get('CF-Connecting-IP') || 'unknown'}`,
        })
      ).success
    )
      reject(429);
    if (request.method === 'POST' && path === '/v1/push')
      return await push(request, env);
    const match = /^\/v1\/devices\/([a-zA-Z0-9_-]{16,64})$/.exec(path);
    if (match && ['PUT', 'DELETE'].includes(request.method))
      return await register(request, env, match[1]);
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    return error instanceof HttpError
      ? json({ error: 'Request rejected' }, error.status)
      : json({ error: 'Relay unavailable' }, 503);
  }
}
export async function checkReceipts(env: RelayEnv): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM deliveries WHERE expires_at < ?')
    .bind(now)
    .run();
  const pending = await env.DB.prepare(
    'SELECT deliveries.device_id, deliveries.event_id, deliveries.ticket, deliveries.token_hash, devices.expo_token FROM deliveries JOIN devices ON devices.id = deliveries.device_id WHERE ticket IS NOT NULL LIMIT 1000',
  ).all<{
    device_id: string;
    event_id: string;
    ticket: string;
    token_hash: string;
    expo_token: string | null;
  }>();
  if (!pending.results.length) return;
  const reply = await expo(env, 'getReceipts', {
    ids: pending.results.map(r => r.ticket),
  });
  const receipts = object(reply.data);
  for (const row of pending.results) {
    if (!receipts[row.ticket]) continue;
    const ticket = providerTicket(receipts[row.ticket]);
    if (
      ticket.details?.error === 'DeviceNotRegistered' &&
      row.expo_token &&
      (await hash(row.expo_token)) === row.token_hash
    )
      await env.DB.prepare(
        'UPDATE devices SET expo_token = NULL WHERE id = ? AND expo_token = ?',
      )
        .bind(row.device_id, row.expo_token)
        .run();
    await env.DB.prepare(
      'UPDATE deliveries SET ticket = NULL WHERE device_id = ? AND event_id = ?',
    )
      .bind(row.device_id, row.event_id)
      .run();
  }
}
export default {
  fetch: handleRequest,
  async scheduled(
    _controller: ScheduledController,
    env: RelayEnv,
  ): Promise<void> {
    await checkReceipts(env);
  },
} satisfies ExportedHandler<RelayEnv>;
