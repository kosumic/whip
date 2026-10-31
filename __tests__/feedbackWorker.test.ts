import { timingSafeEqual } from 'node:crypto';

import {
  handleFeedbackRequest,
  type FeedbackRepository,
} from '../feedback-worker/src';

type RequestRecord = Parameters<FeedbackRepository['createRequest']>[0];
type IntentRecord = Parameters<FeedbackRepository['createTipIntent']>[0];
type TipRecord = Parameters<FeedbackRepository['recordTip']>[0];
type FindIntentInput = Parameters<
  FeedbackRepository['findPendingTipIntent']
>[0];

const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (left: ArrayBuffer, right: ArrayBuffer) => boolean;
};
if (!subtle.timingSafeEqual) {
  Object.defineProperty(subtle, 'timingSafeEqual', {
    value: (left: ArrayBuffer, right: ArrayBuffer) =>
      left.byteLength === right.byteLength &&
      timingSafeEqual(new Uint8Array(left), new Uint8Array(right)),
  });
}

class MemoryFeedbackRepository implements FeedbackRepository {
  readonly requests: RequestRecord[] = [];
  readonly intents: IntentRecord[] = [];
  readonly tips: TipRecord[] = [];

  async createRequest(record: RequestRecord): Promise<void> {
    this.requests.push(record);
  }

  async requestBelongsToRevenueCatUser(
    id: string,
    revenueCatUserId: string,
  ): Promise<boolean> {
    return this.requests.some(
      request =>
        request.id === id && request.revenueCatUserId === revenueCatUserId,
    );
  }

  async createTipIntent(record: IntentRecord): Promise<void> {
    this.intents.push(record);
  }

  async findTipByTransactionId(
    transactionId: string,
  ): Promise<TipRecord | null> {
    return this.tips.find(tip => tip.transactionId === transactionId) || null;
  }

  async findPendingTipIntent(
    input: FindIntentInput,
  ): Promise<IntentRecord | null> {
    return (
      this.intents
        .filter(
          intent =>
            !intent.completed &&
            input.revenueCatUserIds.includes(intent.revenueCatUserId) &&
            intent.productId === input.productId &&
            intent.createdAt <= input.latestCreatedAt &&
            intent.expiresAt >= input.purchasedAt,
        )
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        )[0] || null
    );
  }

  async recordTip(tip: TipRecord): Promise<boolean> {
    if (
      this.tips.some(existing => existing.transactionId === tip.transactionId)
    )
      return false;
    this.tips.push(tip);
    const intent = this.intents.find(
      candidate => candidate.id === tip.tipIntentId,
    );
    if (intent) intent.completed = true;
    return true;
  }
}

const NOW = new Date('2026-08-25T12:00:00.000Z');
const WEBHOOK_AUTHORIZATION = 'Bearer local-webhook-test-secret';

function post(path: string, body: unknown, authorization?: string): Request {
  return new Request(`https://feedback.example.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify(body),
  });
}

function handler(
  repository: MemoryFeedbackRepository,
  request: Request,
): Promise<Response> {
  return handleFeedbackRequest(request, {
    repository,
    webhookAuthorization: WEBHOOK_AUTHORIZATION,
    now: () => new Date(NOW),
  });
}

async function createRequest(
  repository: MemoryFeedbackRepository,
): Promise<string> {
  const response = await handler(
    repository,
    post('/api/requests', {
      type: 'feature',
      title: 'Add a compact host switcher',
      body: 'It would help on smaller screens.',
      revenuecatUserId: '$RCAnonymousID:device-a',
    }),
  );
  expect(response.status).toBe(201);
  const body: { id: string } = await response.json();
  return body.id;
}

async function createIntent(
  repository: MemoryFeedbackRepository,
  requestId: string,
): Promise<void> {
  const response = await handler(
    repository,
    post(`/api/requests/${requestId}/tip-intent`, {
      revenuecatUserId: '$RCAnonymousID:device-a',
      productId: 'whip_tip_medium',
    }),
  );
  expect(response.status).toBe(201);
}

function purchaseWebhook(
  transactionId = 'transaction-123',
): Record<string, unknown> {
  return {
    api_version: '1.0',
    event: {
      type: 'NON_RENEWING_PURCHASE',
      id: 'event-123',
      app_user_id: '$RCAnonymousID:device-a',
      original_app_user_id: '$RCAnonymousID:device-a',
      aliases: [],
      product_id: 'whip_tip_medium',
      transaction_id: transactionId,
      purchased_at_ms: NOW.getTime() + 60_000,
      price_in_purchased_currency: 4.99,
      currency: 'USD',
      store: 'PLAY_STORE',
      environment: 'SANDBOX',
    },
  };
}

describe('feedback Worker', () => {
  test('creates a bounded free request with the RevenueCat anonymous ID', async () => {
    const repository = new MemoryFeedbackRepository();
    const requestId = await createRequest(repository);

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(repository.requests).toHaveLength(1);
    expect(repository.requests[0]).toMatchObject({
      type: 'feature',
      title: 'Add a compact host switcher',
      revenueCatUserId: '$RCAnonymousID:device-a',
      status: 'open',
    });
  });

  test('creates a pending tip intent only for an existing request and known product', async () => {
    const repository = new MemoryFeedbackRepository();
    const requestId = await createRequest(repository);
    await createIntent(repository, requestId);

    expect(repository.intents).toHaveLength(1);
    expect(repository.intents[0]).toMatchObject({
      requestId,
      productId: 'whip_tip_medium',
      revenueCatUserId: '$RCAnonymousID:device-a',
      completed: false,
    });
    expect(
      new Date(repository.intents[0].expiresAt).getTime() - NOW.getTime(),
    ).toBe(30 * 60 * 1000);

    const invalid = await handler(
      repository,
      post(`/api/requests/${requestId}/tip-intent`, {
        revenuecatUserId: '$RCAnonymousID:device-a',
        productId: 'not-a-tip',
      }),
    );
    expect(invalid.status).toBe(400);
    expect(repository.intents).toHaveLength(1);

    const wrongUser = await handler(
      repository,
      post(`/api/requests/${requestId}/tip-intent`, {
        revenuecatUserId: '$RCAnonymousID:someone-else',
        productId: 'whip_tip_small',
      }),
    );
    expect(wrongUser.status).toBe(404);
    expect(repository.intents).toHaveLength(1);
  });

  test('rejects a RevenueCat webhook without the configured Authorization value', async () => {
    const repository = new MemoryFeedbackRepository();
    const response = await handler(
      repository,
      post(
        '/api/webhooks/revenuecat',
        purchaseWebhook(),
        'Bearer wrong-secret',
      ),
    );
    expect(response.status).toBe(401);
  });

  test('matches a purchase webhook to its intent and records authoritative price metadata', async () => {
    const repository = new MemoryFeedbackRepository();
    const requestId = await createRequest(repository);
    await createIntent(repository, requestId);

    const response = await handler(
      repository,
      post(
        '/api/webhooks/revenuecat',
        purchaseWebhook(),
        WEBHOOK_AUTHORIZATION,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      received: true,
      matched: true,
      recorded: true,
    });
    expect(repository.intents[0].completed).toBe(true);
    expect(repository.tips).toEqual([
      expect.objectContaining({
        transactionId: 'transaction-123',
        requestId,
        productId: 'whip_tip_medium',
        amount: 4.99,
        currency: 'USD',
        store: 'PLAY_STORE',
        environment: 'SANDBOX',
      }),
    ]);
  });

  test('treats a replayed transaction as idempotent and never records a second tip', async () => {
    const repository = new MemoryFeedbackRepository();
    const requestId = await createRequest(repository);
    await createIntent(repository, requestId);
    const webhook = () =>
      handler(
        repository,
        post(
          '/api/webhooks/revenuecat',
          purchaseWebhook(),
          WEBHOOK_AUTHORIZATION,
        ),
      );

    expect((await webhook()).status).toBe(200);
    const replay = await webhook();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ received: true, duplicate: true });
    expect(repository.tips).toHaveLength(1);
  });
});
