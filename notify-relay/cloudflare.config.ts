import { bindings, defineConfig, triggers } from 'cf/config';

export default defineConfig({
  accountId: '6347d293a37734d7acd6fabc1a432da4',
  worker: {
    name: 'whip-notify',
    compatibilityDate: '2026-10-28',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint: 'src/index.ts',
    domains: ['whip-notify.kosumi.dev'],
    observability: { enabled: true, headSamplingRate: 0.1 },
    triggers: [triggers.scheduled({ schedule: '*/15 * * * *' })],
    env: {
      DB: bindings.d1({
        name: 'whip-notify',
        id: '1d31450e-7d93-4f05-95d5-ead25c1dff03',
      }),
      LIMITER: bindings.rateLimit({
        namespace: '1001',
        simple: { limit: 60, period: 60 },
      }),
    },
  },
});
