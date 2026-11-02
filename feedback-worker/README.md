# Whip feedback Worker

Cloudflare Worker + D1 for feedback requests, tip intents, and verified RevenueCat webhooks.

This directory is an independent Node package. From the repository root:

```sh
nix develop
cd feedback-worker
npm ci
npm run check
```

`check` runs type checking, lint, tests, generated binding validation, and a Wrangler deployment dry run. No root npm installation is needed. Use `npm run dev` for local development and `npm run types` after changing bindings.

See [Worker development and CI](../docs/worker-development.md) and [deployment and webhook setup](../docs/request-tipping.md).
