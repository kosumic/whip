/// <reference types="@cloudflare/workers-types" />

// Use the Worker runtime's crypto type when checked alongside Node-based tests.
declare const crypto: import('@cloudflare/workers-types').Crypto;

const TIP_PRODUCT_IDS = new Set([
  'whip_tip_small',
  'whip_tip_medium',
  'whip_tip_large',
]);
const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 24_576;
const TIP_INTENT_TTL_MS = 30 * 60 * 1_000;
const PURCHASE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

type RequestType = 'bug' | 'feature';

interface FeedbackRequestRecord {
  id: string;
  type: RequestType;
  title: string;
  body: string;
  revenueCatUserId: string | null;
  createdAt: string;
  status: 'open';
}

interface TipIntentRecord {
  id: string;
  requestId: string;
  revenueCatUserId: string;
  productId: string;
  createdAt: string;
  expiresAt: string;
  completed: boolean;
}

interface VerifiedTip {
  transactionId: string;
  requestId: string;
  tipIntentId: string;
  revenueCatUserId: string;
  productId: string;
  amount: number | null;
  currency: string | null;
  store: string | null;
  environment: string | null;
  createdAt: string;
}

export interface FeedbackRepository {
  createRequest(record: FeedbackRequestRecord): Promise<void>;
  requestBelongsToRevenueCatUser(
    id: string,
    revenueCatUserId: string,
  ): Promise<boolean>;
  createTipIntent(record: TipIntentRecord): Promise<void>;
  findTipByTransactionId(transactionId: string): Promise<VerifiedTip | null>;
  findPendingTipIntent(input: {
    revenueCatUserIds: readonly string[];
    productId: string;
    purchasedAt: string;
    latestCreatedAt: string;
  }): Promise<TipIntentRecord | null>;
  recordTip(tip: VerifiedTip): Promise<boolean>;
}

interface HandlerBindings {
  repository: FeedbackRepository;
  webhookAuthorization: string;
  now: () => Date;
}

export async function handleFeedbackRequest(
  request: Request,
  bindings: HandlerBindings,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/requests') {
      return await createRequest(request, bindings);
    }
    const intentMatch = url.pathname.match(
      /^\/api\/requests\/([^/]+)\/tip-intent$/,
    );
    if (request.method === 'POST' && intentMatch) {
      return await createIntent(
        request,
        decodeRequestId(intentMatch[1]),
        bindings,
      );
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/api/webhooks/revenuecat'
    ) {
      return await receiveRevenueCatWebhook(request, bindings);
    }
    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    if (error instanceof ApiError)
      return json({ error: error.message }, error.status);
    console.error(
      JSON.stringify({ event: 'feedback-worker-error', error: String(error) }),
    );
    return json({ error: 'Internal server error.' }, 500);
  }
}

async function createRequest(
  request: Request,
  bindings: HandlerBindings,
): Promise<Response> {
  const body = await readJson(request);
  const type = body.type;
  const title = cleanText(body.title);
  const details = cleanText(body.body);
  const revenueCatUserId = optionalRevenueCatUserId(body.revenuecatUserId);
  if (type !== 'bug' && type !== 'feature')
    throw new ApiError(400, 'Type must be bug or feature.');
  if (!title || title.length > 120)
    throw new ApiError(400, 'Title must be between 1 and 120 characters.');
  if (!details || details.length > 5000)
    throw new ApiError(400, 'Body must be between 1 and 5000 characters.');

  const record: FeedbackRequestRecord = {
    id: crypto.randomUUID(),
    type,
    title,
    body: details,
    revenueCatUserId,
    createdAt: bindings.now().toISOString(),
    status: 'open',
  };
  await bindings.repository.createRequest(record);
  return json(
    { id: record.id, status: record.status, createdAt: record.createdAt },
    201,
  );
}

async function createIntent(
  request: Request,
  requestId: string,
  bindings: HandlerBindings,
): Promise<Response> {
  if (!REQUEST_ID_PATTERN.test(requestId))
    throw new ApiError(400, 'Invalid request ID.');
  const body = await readJson(request);
  const revenueCatUserId = requiredRevenueCatUserId(body.revenuecatUserId);
  const productId = typeof body.productId === 'string' ? body.productId : '';
  if (!TIP_PRODUCT_IDS.has(productId))
    throw new ApiError(400, 'Invalid tip product ID.');
  if (
    !(await bindings.repository.requestBelongsToRevenueCatUser(
      requestId,
      revenueCatUserId,
    ))
  )
    throw new ApiError(404, 'Request not found.');

  const createdAt = bindings.now();
  const record: TipIntentRecord = {
    id: crypto.randomUUID(),
    requestId,
    revenueCatUserId,
    productId,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + TIP_INTENT_TTL_MS).toISOString(),
    completed: false,
  };
  await bindings.repository.createTipIntent(record);
  return json({ id: record.id, expiresAt: record.expiresAt }, 201);
}

async function receiveRevenueCatWebhook(
  request: Request,
  bindings: HandlerBindings,
): Promise<Response> {
  if (!bindings.webhookAuthorization)
    throw new ApiError(503, 'Webhook authorization is not configured.');
  const authorized = await secureEqual(
    request.headers.get('Authorization') || '',
    bindings.webhookAuthorization,
  );
  if (!authorized) throw new ApiError(401, 'Unauthorized.');

  const payload = await readJson(request);
  const event = isObject(payload.event) ? payload.event : null;
  if (event?.type !== 'NON_RENEWING_PURCHASE') {
    return json({ received: true, ignored: true });
  }

  const productId = stringField(event.product_id, 'product_id', 200);
  if (!TIP_PRODUCT_IDS.has(productId))
    return json({ received: true, ignored: true });
  const transactionId = stringField(
    event.transaction_id,
    'transaction_id',
    256,
  );
  const purchasedAtMs = finiteNumber(event.purchased_at_ms, 'purchased_at_ms');
  const primaryUserId = requiredRevenueCatUserId(event.app_user_id);
  const revenueCatUserIds = revenueCatAliases(event, primaryUserId);

  if (await bindings.repository.findTipByTransactionId(transactionId)) {
    return json({ received: true, duplicate: true });
  }

  const purchasedAt = new Date(purchasedAtMs);
  if (Number.isNaN(purchasedAt.getTime()))
    throw new ApiError(400, 'Invalid purchased_at_ms.');
  const intent = await bindings.repository.findPendingTipIntent({
    revenueCatUserIds,
    productId,
    purchasedAt: purchasedAt.toISOString(),
    latestCreatedAt: new Date(
      purchasedAtMs + PURCHASE_CLOCK_SKEW_MS,
    ).toISOString(),
  });
  if (!intent) {
    console.warn(
      JSON.stringify({
        event: 'revenuecat-tip-intent-not-found',
        productId,
        transactionId,
      }),
    );
    return json({ received: true, matched: false });
  }

  const tip: VerifiedTip = {
    transactionId,
    requestId: intent.requestId,
    tipIntentId: intent.id,
    revenueCatUserId: primaryUserId,
    productId,
    amount: optionalFiniteNumber(event.price_in_purchased_currency),
    currency: optionalString(event.currency, 3),
    store: optionalString(event.store, 40),
    environment: optionalString(event.environment, 20),
    createdAt: purchasedAt.toISOString(),
  };
  const recorded = await bindings.repository.recordTip(tip);
  return json({ received: true, matched: true, recorded });
}

class D1FeedbackRepository implements FeedbackRepository {
  constructor(private readonly db: D1Database) {}

  async createRequest(record: FeedbackRequestRecord): Promise<void> {
    await this.db
      .prepare(
        `
      INSERT INTO requests (id, type, title, body, revenuecat_user_id, created_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .bind(
        record.id,
        record.type,
        record.title,
        record.body,
        record.revenueCatUserId,
        record.createdAt,
        record.status,
      )
      .run();
  }

  async requestBelongsToRevenueCatUser(
    id: string,
    revenueCatUserId: string,
  ): Promise<boolean> {
    return Boolean(
      await this.db
        .prepare(
          'SELECT id FROM requests WHERE id = ? AND revenuecat_user_id = ?',
        )
        .bind(id, revenueCatUserId)
        .first(),
    );
  }

  async createTipIntent(record: TipIntentRecord): Promise<void> {
    await this.db
      .prepare(
        `
      INSERT INTO tip_intents
        (id, request_id, revenuecat_user_id, product_id, created_at, expires_at, completed)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `,
      )
      .bind(
        record.id,
        record.requestId,
        record.revenueCatUserId,
        record.productId,
        record.createdAt,
        record.expiresAt,
      )
      .run();
  }

  async findTipByTransactionId(
    transactionId: string,
  ): Promise<VerifiedTip | null> {
    const row = await this.db
      .prepare(
        `
      SELECT transaction_id, tip_intent_id, request_id, revenuecat_user_id,
             product_id, amount, currency, store, environment, created_at
      FROM tips WHERE transaction_id = ?
    `,
      )
      .bind(transactionId)
      .first<TipRow>();
    return row ? tipFromRow(row) : null;
  }

  async findPendingTipIntent(input: {
    revenueCatUserIds: readonly string[];
    productId: string;
    purchasedAt: string;
    latestCreatedAt: string;
  }): Promise<TipIntentRecord | null> {
    const placeholders = input.revenueCatUserIds.map(() => '?').join(', ');
    const row = await this.db
      .prepare(
        `
      SELECT id, request_id, revenuecat_user_id, product_id, created_at, expires_at, completed
      FROM tip_intents
      WHERE revenuecat_user_id IN (${placeholders})
        AND product_id = ?
        AND completed = 0
        AND created_at <= ?
        AND expires_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
      )
      .bind(
        ...input.revenueCatUserIds,
        input.productId,
        input.latestCreatedAt,
        input.purchasedAt,
      )
      .first<TipIntentRow>();
    return row ? tipIntentFromRow(row) : null;
  }

  async recordTip(tip: VerifiedTip): Promise<boolean> {
    const results = await this.db.batch([
      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO tips
          (transaction_id, tip_intent_id, request_id, revenuecat_user_id, product_id,
           amount, currency, store, environment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .bind(
          tip.transactionId,
          tip.tipIntentId,
          tip.requestId,
          tip.revenueCatUserId,
          tip.productId,
          tip.amount,
          tip.currency,
          tip.store,
          tip.environment,
          tip.createdAt,
        ),
      this.db
        .prepare(
          `
        UPDATE tip_intents
        SET completed = 1, completed_transaction_id = ?
        WHERE id = ? AND completed = 0
          AND EXISTS (
            SELECT 1 FROM tips
            WHERE transaction_id = ? AND request_id = ? AND tip_intent_id = ?
          )
      `,
        )
        .bind(
          tip.transactionId,
          tip.tipIntentId,
          tip.transactionId,
          tip.requestId,
          tip.tipIntentId,
        ),
    ]);
    return results[0].meta.changes === 1;
  }
}

interface TipIntentRow {
  id: string;
  request_id: string;
  revenuecat_user_id: string;
  product_id: string;
  created_at: string;
  expires_at: string;
  completed: number;
}

interface TipRow {
  transaction_id: string;
  tip_intent_id: string;
  request_id: string;
  revenuecat_user_id: string;
  product_id: string;
  amount: number | null;
  currency: string | null;
  store: string | null;
  environment: string | null;
  created_at: string;
}

function tipIntentFromRow(row: TipIntentRow): TipIntentRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    revenueCatUserId: row.revenuecat_user_id,
    productId: row.product_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    completed: row.completed === 1,
  };
}

function tipFromRow(row: TipRow): VerifiedTip {
  return {
    transactionId: row.transaction_id,
    tipIntentId: row.tip_intent_id,
    requestId: row.request_id,
    revenueCatUserId: row.revenuecat_user_id,
    productId: row.product_id,
    amount: row.amount,
    currency: row.currency,
    store: row.store,
    environment: row.environment,
    createdAt: row.created_at,
  };
}

function revenueCatAliases(
  event: Record<string, unknown>,
  primary: string,
): string[] {
  const values: unknown[] = [primary, event.original_app_user_id];
  if (Array.isArray(event.aliases)) {
    for (const alias of event.aliases) values.push(alias);
  }
  return [
    ...new Set(
      values.flatMap(value => {
        try {
          return [requiredRevenueCatUserId(value)];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    throw new ApiError(413, 'Request body is too large.');
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new ApiError(400, 'Invalid JSON body.');
  }
  if (!isObject(payload))
    throw new ApiError(400, 'JSON body must be an object.');
  return payload;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function decodeRequestId(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'Invalid request ID.');
  }
}

function optionalRevenueCatUserId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return requiredRevenueCatUserId(value);
}

function requiredRevenueCatUserId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 100 ||
    Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    throw new ApiError(400, 'Invalid RevenueCat App User ID.');
  return value;
}

function stringField(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.length > maxLength) {
    throw new ApiError(400, `Invalid ${name}.`);
  }
  return value;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(400, `Invalid ${name}.`);
  }
  return value;
}

function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function secureEqual(
  provided: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFeedbackRequest(request, {
      repository: new D1FeedbackRepository(env.DB),
      webhookAuthorization: env.REVENUECAT_WEBHOOK_AUTHORIZATION,
      now: () => new Date(),
    });
  },
} satisfies ExportedHandler<Env>;
