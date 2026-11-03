# Request-specific tips

Whip accepts bug reports and feature requests for free. After the Worker confirms
that a request was submitted, the app can optionally show three consumable
RevenueCat products. Tips are only a signal the maintainer may consider; they do
not guarantee a response, fix, feature, priority, queue position, SLA, or delivery
date.

The app uses RevenueCat's anonymous App User ID. It sends that ID with the request,
creates a short-lived tip intent before opening the store purchase UI, and never
reports a purchase to the backend as authoritative. The RevenueCat webhook is the
only path that creates a `tips` row.

For the initial rollout, the request UI is hidden unless **Developer options**
is enabled under More → Settings → Developer. That setting is off by default;
it also controls the App Logs UI and whether Whip retains launch logs or latency
diagnostics.

## App and store setup

1. In App Store Connect, create these as consumable in-app purchases for Whip:

   - `whip_tip_small`
   - `whip_tip_medium`
   - `whip_tip_large`

2. In Google Play Console, create and activate the same IDs as one-time products.
3. Add the iOS and Android apps to one RevenueCat project and import all six store
   products. Do not attach them to an entitlement. Offerings are not required
   because the app fetches the known non-subscription product IDs directly.
4. Complete RevenueCat's App Store shared-secret/API-key and Google Play service
   credential setup required for normal purchase validation. Those credentials
   belong in RevenueCat, not in this repository or the Whip app.
5. Copy each app's platform-specific **public SDK key** from RevenueCat and expose
   it while bundling Whip:

   ```bash
   export WHIP_REVENUECAT_IOS_PUBLIC_SDK_KEY='appl_...'
   export WHIP_REVENUECAT_ANDROID_PUBLIC_SDK_KEY='goog_...'
   export WHIP_FEEDBACK_API_URL='https://whip-feedback-api.<account>.workers.dev'
   ```

These values are embedded by `app.config.js`. RevenueCat public SDK keys are safe
for client configuration; never put a RevenueCat secret/server API key there.
When a public key is missing or product loading fails, request submission remains
available and the tip controls show an unavailable state.

The native project already includes Android's Billing permission, a purchase-safe
`singleTop` activity launch mode, and the iOS In-App Purchase capability. Run
`pod install` after installing JavaScript dependencies on the macOS build host so
the RevenueCat pod is linked.

## Worker and D1 setup

Enter the Nix development shell from the repository root, then run commands inside the independent Worker package:

```bash
nix develop
cd feedback-worker
npm ci
npx wrangler login
npx wrangler d1 create whip-feedback
```

Replace the placeholder `database_id` in `feedback-worker/wrangler.jsonc` with the
ID printed by `d1 create`, then apply the migration:

```bash
npx wrangler d1 migrations apply whip-feedback \
  --config wrangler.jsonc --local
npx wrangler d1 migrations apply whip-feedback \
  --config wrangler.jsonc --remote
```

Generate a long random webhook authorization value. Store it locally in the
ignored `feedback-worker/.dev.vars` file for `wrangler dev`, and store the same
value in Cloudflare for deployment using the interactive prompt:

```bash
npx wrangler secret put REVENUECAT_WEBHOOK_AUTHORIZATION \
  --config wrangler.jsonc
```

No RevenueCat secret API key is required by this Worker because it does not call
RevenueCat's server API. If a later version adds such calls, that key must be a
Worker secret and must never be embedded in the app.

Start or validate the Worker with:

```bash
npm run dev
npm run check
npm run deploy
```

In RevenueCat, add this HTTPS webhook URL:

```text
https://whip-feedback-api.<account>.workers.dev/api/webhooks/revenuecat
```

Set its Authorization header to exactly the same value stored in
`REVENUECAT_WEBHOOK_AUTHORIZATION`. Enable `NON_RENEWING_PURCHASE` events for the
environments you want to accept. RevenueCat webhooks require a RevenueCat plan
that includes webhook integrations.

## Data and matching behavior

The migration creates:

- `requests`: the request type, title, body, optional RevenueCat anonymous ID,
  creation time, and status.
- `tip_intents`: a 30-minute association between a request, anonymous ID, and one
  of the three allowed products.
- `tips`: verified RevenueCat transaction metadata. `transaction_id` is the
  primary key and `tip_intent_id` is unique.

For a `NON_RENEWING_PURCHASE`, the Worker verifies the configured Authorization
header with a constant-time comparison, validates the product, checks the current
and aliased RevenueCat user IDs, and selects the newest pending intent whose
window contains the store purchase time. It stores RevenueCat's
`price_in_purchased_currency` and `currency` only when supplied. An atomic D1
batch inserts the tip and marks the intent complete. A retry with the same store
transaction ID returns success without adding another tip.

The current association model assumes a user does not initiate two simultaneous
purchases of the same tip product for two different requests. The newest matching
pending intent wins. That is sufficient for the first request-specific flow and
can later be replaced with richer server-side purchase metadata if RevenueCat and
the stores expose an appropriate mechanism.
