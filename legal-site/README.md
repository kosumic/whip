# Whip legal page

Public Terms of Service: <https://whip.kosumi.dev/terms>.

The HTML and CSS in `public/` are served directly by Cloudflare Workers Static
Assets. The site requires no app build, client JavaScript, cookies, or analytics.
Only `public/` is uploaded. The root URL redirects to `/terms`.

From the repository root, validate and deploy with the logged-in `cf` CLI:

```sh
nix develop --command npm ci --prefix legal-site
nix develop --command bash -c 'cd legal-site && cf deploy --dry-run'
nix develop --command bash -c 'cd legal-site && cf deploy'
curl --fail --head https://whip.kosumi.dev/terms
```

This is an independent package. The `cf` CLI uses its Wrangler adapter to build
the static assets.

`cloudflare.config.ts` binds the dedicated `whip-legal` Worker to
`whip.kosumi.dev`; Cloudflare manages its DNS and TLS certificate. Edit
`public/terms.html` and its effective date when updating the terms, then deploy
again. The privacy link points to the existing policy in the source repository.
