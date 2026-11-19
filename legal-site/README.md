# Whip website

Product homepage: <https://whip.kosumi.dev/>.
Terms of Service: <https://whip.kosumi.dev/terms>.

The HTML and CSS in `public/` are served directly by Cloudflare Workers Static
Assets. The site requires no app build. A small optional script refreshes the
GitHub star count from GitHub's public API and caches it in localStorage for an
hour; a server-rendered count remains visible if JavaScript, storage, or the API
is unavailable. The light/dark theme follows the system initially; the header
toggle saves an explicit choice in localStorage and applies it before the CSS
loads to avoid a theme flash. The launch video uses YouTube's privacy-enhanced embedded player.
These third-party resources make requests to their respective providers. The
site adds no first-party cookies or analytics.
Only `public/` is uploaded. The homepage includes product information, store
links, setup, FAQs, canonical and social metadata, and SoftwareApplication
structured data. `/robots.txt` allows crawling and advertises `/sitemap.xml`.
`/download` redirects to the existing GitHub Pages store chooser so printed
QR codes continue working. `/terms` remains at its existing address.

Homepage assets are committed. After updating the source screenshots or icon,
regenerate them and the social preview from the repository root:

```sh
nix develop --command npm run generate:site-assets
```

This uses the root package's existing Sharp dependency. The website itself
needs no root package dependencies to deploy.
The official App Store and Google Play badges are copied from `site/` by the
same generator; their source URLs are documented in `docs/install-qr.md`.
The generator also copies the permanent install QR in SVG format.

From the repository root, validate and deploy with the logged-in `cf` CLI:

```sh
nix develop --command npm ci --prefix legal-site
nix develop --command npm --prefix legal-site run check
nix develop --command npm --prefix legal-site run deploy
curl --fail --head https://whip.kosumi.dev/terms
curl --fail --head https://whip.kosumi.dev/
curl --fail https://whip.kosumi.dev/sitemap.xml
```

This is an independent package. The `cf` CLI uses its Wrangler adapter to build
the static assets.

`cloudflare.config.ts` keeps the existing `whip-legal` Worker bound to
`whip.kosumi.dev`; Cloudflare manages its DNS and TLS certificate. Edit
`public/terms.html` and its effective date when updating the terms, then deploy
again. The privacy link points to the existing policy in the source repository.

## Search indexing and listing maintenance

Use `https://whip.kosumi.dev/` as the product website in GitHub and both app
stores. Keep the store-specific name (currently Whip Herd on iOS) and historical
aliases in the homepage FAQ and structured data accurate. The pairing helper's
PyPI and npm metadata points to this website; those changes become public on
the next package release.
The checked-in store descriptions and iOS marketing URL also point here; publish
them through the normal store metadata release process.

In Google Search Console, verify the `https://whip.kosumi.dev/` URL-prefix
property (or its parent domain), submit `https://whip.kosumi.dev/sitemap.xml`,
and inspect/request indexing for the homepage. In Bing Webmaster Tools, import
the verified property or verify it separately and submit the same sitemap.
Verification requires the site owner's search-console account; never invent
verification tokens or publish placeholder verification records.

The sitemap and metadata support discovery but do not guarantee indexing or
inclusion in an AI answer. Use Search Console/Bing reports and repeat the same
branded searches to check progress after deployment.
