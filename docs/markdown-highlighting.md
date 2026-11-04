# Native Markdown highlighting

Fenced code uses the same Rust Syntect and `two-face` grammar set as file previews
and Git diffs. The shared `SYNTAXES` instance lives in Whip's Rust library.
Markdown no longer compiles its own Tree-sitter runtime or language tables.

`enriched-markdown.enableCodeHighlight` is false in `package.json` to exclude the
upstream Tree-sitter implementation. Whip's adapter still supplies syntax colors:

- Android's Markdown adapter calls `WhipSyntaxHighlighter`, which marshals UTF-8
  bytes through JNI into `whip_syntax_highlight`.
- Apple's C++ adapter calls the same C ABI through the `WhipSsh` pod dependency.
- Rust returns semantic token kinds and UTF-16 ranges. Both renderers keep their
  existing token palettes, fonts, layout, selection, and copy behavior.

The 12 previously configured languages remain supported. Other grammars already
in the shared set, including TOML, Nix, and SQL, also work. JSX fences use the TSX
grammar because `two-face` excludes Babel's grammar with the pure Rust regex
backend. Unknown languages retain plain text.

## Rendering and limits

GitHub-flavor blocks display their plain styled text immediately. Completed
fences are highlighted on a serial background worker; results return to the UI
thread. Source changes, pending fences, detached views, and recycled views cancel
queued work and invalidate old results. Reattaching a view restarts its highlight.
Only foreground colors change, so highlighting does not change block metrics.

The native adapter accepts at most 50 KiB, 2,000 lines, and 4 KiB per line. Parse
errors, invalid UTF-8, and over-limit input fall back to the original plain text.
The app's CommonMark component encodes user text as literal entities and does not
interpret code fences.

## Validation

Rust tests exercise the supported languages, additional grammars, multiline
comments, emoji and CJK offsets, plain-text fallbacks, and the C ABI. Existing
Markdown parser and UI tests cover the surrounding rendering behavior.

```sh
nix develop -c cargo test --locked \
  --manifest-path packages/react-native-whip-ssh/rust/Cargo.toml \
  syntax_highlighting --lib

WHIP_DISTRIBUTION_CHANNEL=github nix develop -c android/gradlew -p android \
  :react-native-whip-ssh:compileReleaseKotlin \
  :react-native-enriched-markdown:compileReleaseKotlin \
  :app:externalNativeBuildRelease \
  -PreactNativeArchitectures=arm64-v8a
```

Compare both `libreact-native-whip-ssh.so` and
`libreact_codegen_EnrichedMarkdownTextSpec.so` after stripping them with the same
NDK `llvm-strip --strip-unneeded` command. Counting both includes the adapter's
cost in Whip's library. These targets stop before APK packaging.

The measured arm64 release comparison against the Smart Turn-disabled baseline:

| Library | Before | After |
| --- | ---: | ---: |
| Markdown | 12,028,624 bytes | 830,376 bytes |
| Whip Rust/React Native bridge | 45,311,336 bytes | 45,319,048 bytes |

The combined saving is **11,190,536 bytes (10.67 MiB)**. The unstripped Markdown
library contains no Tree-sitter parser or table symbols. The Kotlin native-method
descriptor and exported JNI entrypoint also match.

An Android native build does not validate the Apple build or on-device rendering.
Those checks are required before treating this experiment as release ready.
