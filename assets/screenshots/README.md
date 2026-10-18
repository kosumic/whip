# README screenshots

The current gallery uses [iOS simulator captures](ios/README.md) inside iPhone
mockups, including the original glass mode and custom background configured on
`mini`. The older Android mockups remain available below. Both device frames
come from [`@sneas/telephone`](https://github.com/sneas/telephone) under the MIT
license reproduced below.

## Earlier Android mockups

The WebP files in this directory are Pixel 9 Pro screenshots wrapped in the
front-facing Pixel 9 Pro frame from
[`@sneas/telephone`](https://github.com/sneas/telephone). The frame is used
under the MIT License:

> Copyright (c) 2024 Dimah Snisarenko

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

To replace the screenshots, capture each screen at 960×2142, place it in this
directory with the corresponding `.png` name, then run:

```sh
nix develop -c npm run generate:readme-phone-mockups
```

If you are replacing one screen, pass its base name after `--`, for example:

```sh
nix develop -c npm run generate:readme-phone-mockups -- hosts
```

The generator creates a 706×1490 WebP at quality 92 with lossless alpha, then
removes the source PNG. It rejects screenshots at any other size so an
accidental second run cannot nested-frame the output.
