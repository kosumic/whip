import { defineConfig } from 'cf/config';

export default defineConfig({
  accountId: '6347d293a37734d7acd6fabc1a432da4',
  worker: {
    name: 'whip-legal',
    compatibilityDate: '2026-11-07',
    domains: ['whip.kosumi.dev'],
  },
});
