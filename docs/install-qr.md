# Whip install QR code

The QR encodes one permanent address: <https://kosumic.github.io/whip/>.
The page routes Android to Google Play and iPhone, iPod touch and iPad to the
App Store, including iPads that request desktop websites. Desktops and unknown
devices show both store links. The links also work when JavaScript is disabled
or a browser blocks automatic navigation.

- [PNG for sharing](../site/whip-install-qr.png)
- [SVG for printing](../site/whip-install-qr.svg)
- [Page source](../site/index.html)

The generator uses [qr-code-styling](https://github.com/kozakdenys/qr-code-styling)
1.9.2 and adapts the neon palette and extra-rounded patterns from
[QRX](https://github.com/desmond845/QRX). Cyan, purple and pink on a dark background,
soft glow and Whip's center icon create the cyberpunk style. Modules, corner
markers and the background have rounded edges.

The library handles encoding, patterns and the logo's clear area. The margin
exceeds four modules at the current URL length, with H error correction. Keep the
dark margin intact when placing the artwork elsewhere. The light-on-dark symbol
requires a scanner that supports inverted QR codes.

## Publishing

GitHub Pages serves the root of the `gh-pages` branch. Publish local `site/`
changes with:

```bash
nix develop -c bash scripts/publish-store-page.sh
```

This creates a separate temporary checkout, commits only the page files and
pushes normally to `gh-pages`. It preserves other files already on that branch
and leaves the current checkout and index alone. GitHub then builds the page.

For initial setup, select **Settings → Pages → Deploy from a branch → gh-pages →
/(root)** in the GitHub repository.

Store destinations are the two links in `site/index.html`; the redirect script
reads those same links. Updating a destination and republishing does not require
a new QR as long as the page address stays the same.

## Regenerating the QR

```bash
nix develop -c npm run generate:install-qr
```

Install development dependencies with `npm ci` first. Pass an HTTPS address as
the generator's argument to change the encoded URL:

```bash
nix develop -c npm run generate:install-qr -- https://example.com/download
```

If the hosting address changes, regenerate both files and replace any distributed
QR artwork. Changing the hosted page cannot update an address encoded in a QR.
