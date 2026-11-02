# Worker development and CI

`feedback-worker/` and `notify-relay/` are independent npm packages with separate lockfiles. They do not use npm workspaces or the app's dependency installation, Babel, Jest, ESLint, TypeScript configuration, or helper scripts.

From the repository root, enter `nix develop`, then run the following in either Worker directory:

```sh
npm ci
npm run check
```

The relay's existing cf CLI declares support for Node 24.22 or newer in the Node 24 line. If the pinned Nix shell supplies an older patch, run its checks with a temporary supported runtime: `npm exec --yes --package=node@24.22.0 -- npm run check` from `notify-relay/`.

Individual commands are `npm run typecheck`, `npm run lint`, `npm test`, `npm run types`, `npm run types:check`, and `npm run build`. `build` packages with Wrangler's deployment dry run. The relay also runs `npm run build:cf` to validate its production cf configuration. Both Wrangler JSON configs explicitly select their local `tsconfig.json`; the relay's `wrangler.config.ts` does the same for builds delegated by cf. Neither packaging command deploys a Worker. Tests live in each package's `__tests__/`; the relay retains its real Miniflare runtime test and D1 migration coverage.

Root `worker:*`, `notify:*`, and `test:workers` scripts forward to the installed Worker packages. Install each Worker's dependencies before using them; root `npm ci` does not install either Worker. App lint, tests, and type checking exclude the Worker directories.

## CI selection

Each Worker workflow watches only its package directory and its own workflow file. Changes to a Worker's manifest, lockfile, source, tests, migrations, configuration, or documentation start its workflow. No root tooling or manifests are shared inputs.

| Changed paths | Feedback Worker CI | Notify Relay CI |
| --- | --- | --- |
| Root `package.json` / `package-lock.json` only (for example #301) | Not started | Not started |
| `feedback-worker/**` or its workflow | Started | Not started |
| `notify-relay/**` or its workflow | Not started | Started |
| Both packages | Started | Started |

Dependabot has separate npm entries for both Worker directories. Its auto-merge workflow listens for completion of each project CI and queries the CI runs present for the tested PR head. It does not wait for workflows omitted by path filtering. App-only, feedback-only, relay-only, and combined updates remain eligible once every CI workflow that started succeeds. Pending, failed, or cancelled CI runs prevent merging; a changed PR head is rejected. The workflow never checks out or executes PR code.

## Required checks

Repository settings checked for kosumic/whip on 2026-11-02: `main` has no classic branch protection, no active branch rules, and no required status checks. The existing repository ruleset is disabled. No repository setting changes are needed for this isolation.

Do not make either path-filtered Worker check globally required: GitHub leaves a required workflow pending when path filters prevent it from starting. If required checks are enabled later, use an always-running aggregate gate that requires the relevant project checks and accepts intentionally skipped projects. See [GitHub's required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks).
