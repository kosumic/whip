# Third-Party Notices

Whip includes or adapts work from the projects listed below. Those portions
remain subject to their original licenses.

## OpenCode Web

Whip's Chat View is inspired by and adapted from the conversation design of
[OpenCode Web](https://github.com/anomalyco/opencode). Whip's git diff viewer
is also inspired by OpenCode v2. OpenCode is not responsible for, and does
not endorse, Whip or its adaptations.

MIT License

Copyright (c) 2025 opencode

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

## Bundled fonts

- [Inter](https://github.com/rsms/inter), copyright (c) 2016 The Inter
  Project Authors, is distributed under the [SIL Open Font License
  1.1](assets/licenses/inter-OFL-1.1.txt).
- [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), copyright 2020
  The JetBrains Mono Project Authors, is distributed under the [SIL Open Font
  License 1.1](assets/licenses/jetbrains-mono-OFL-1.1.txt).
- [AR PL UKai HK](https://www.freedesktop.org/wiki/Software/CJKUnifonts/),
  copyright (C) 1999 Arphic Technology Co., Ltd., is distributed under the
  [Arphic Public License](assets/licenses/arphic-public-license.txt).
- [Symbols Nerd Font Mono](https://github.com/ryanoasis/nerd-fonts),
  copyright (c) 2014 Ryan L McIntyre, is distributed under the [MIT
  License](assets/licenses/nerd-fonts-MIT.txt).

## Merman

Whip uses [Merman](https://github.com/Latias94/merman) to render Mermaid diagrams
in Rust for file and Markdown previews. Merman is copyright (c) 2026 merman
contributors and distributed under the MIT License. Its
[bundled notices](assets/licenses/merman-and-third-party.txt) include the licenses
for the translated renderer components and embedded math fonts used by Whip.

## xterm.js

Whip's terminal renderer uses [xterm.js](https://github.com/xtermjs/xterm.js)
and its addons. The complete copyright notice and [MIT
License](assets/licenses/xterm-MIT.txt) are included with Whip.

## Turso

Whip embeds the official [Turso Rust database](https://docs.rs/turso/0.8.3),
distributed under the MIT License, for local conversation checkpoints and durable application data. The FTS
crate feature is enabled for future indexing; current persistence operations use
ordinary tables. Turso's MIT notice and the Android/iOS production transitive
dependency notices, including Tantivy, are bundled in Whip's generated license
registry. `npm run generate:license-notices` audits that graph against the exact
Cargo lockfile using `licenses/cargo/turso-about.toml`. The audit chooses
permissive alternatives where dependencies offer multiple licenses; it also
includes the Unicode and Zlib licenses required by the resolved graph.

## Lucide Icons

Whip uses [Lucide Icons](https://github.com/lucide-icons/lucide), including
icons derived from the Feather project. The complete Lucide ISC and Feather
MIT notices are included in the [Lucide license
file](assets/licenses/lucide-ISC-and-Feather-MIT.txt).
