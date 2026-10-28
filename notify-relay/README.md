# Whip push relay

Cloudflare Worker + D1, routing HPKE ciphertext through Expo Push Service. No decryption keys or plaintext agent content.

See [deployment and trust model](../docs/remote-notifications.md). `npm install && npm run types && npm run check` works inside this directory. Configure a separate D1 database and apply its migrations before deploying. Users register automatically: an expiring proof is delivered to their push token and returned by the foreground app before a route becomes active. There is no shared enrollment code or app-wide client secret. Per-device management and host routing capabilities remain isolated. `EXPO_ACCESS_TOKEN` is a server-only credential when the Expo project enables push security.

Protocol 2 uses `PUT /v1/devices/:id` to request verification and `POST` to confirm its single-use proof. `DELETE` revokes both pending and active registration. The encrypted message format remains version 1. Protocol 1 clients must update before creating registrations; existing routes continue to deliver and can be revoked.
