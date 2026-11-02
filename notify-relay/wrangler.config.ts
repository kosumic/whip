import { defineWranglerConfig } from 'wrangler/experimental-config';

// cf delegates builds to Wrangler using cloudflare.config.ts.
export default defineWranglerConfig({ tsconfig: 'tsconfig.json' });
