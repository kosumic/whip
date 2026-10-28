# Whip push relay

Cloudflare Worker + D1, routing HPKE ciphertext through Expo Push Service. No decryption keys or plaintext agent content.

See [deployment and trust model](../docs/remote-notifications.md). `npm install && npm run types && npm run check` works inside this directory. Configure a separate D1 database and a private `ENROLLMENT_TOKEN` secret before deploying. `EXPO_ACCESS_TOKEN` is optional when the Expo project enables push security.
