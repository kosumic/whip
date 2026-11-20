# Third-party artifacts

The source extraction retains Whip's AGPL-3.0-or-later provenance. Downloaded
artifacts and inference runtimes retain their own licenses:

| Component | Exact pin | License |
| --- | --- | --- |
| gradium/phonon-31m-en | 8c64b55ec301728e2d1695bfea87a08a267d0c2d | Apache-2.0 |
| gradium/phonon-voices | 0ee17205f254b5abc43b266c8a0f215565c352f7 | Apache-2.0 |
| ptts CPU runtime | 0.6.0 | Apache-2.0 |
| xn-ptts Core ML runtime / bundle | cf90537f4599fb5ae6b09ac88258ce69e8e2f133 / v0.6.0 | Apache-2.0 |

See `LICENSE-PHONON-APACHE` for the full Apache license and
`DEPENDENCY_NOTICES.txt` for the locked production dependency license texts
(Android/iOS). The host remains responsible for distributing notices with its
binary and downloaded model/voice artifacts. Whip's existing license UI includes
the crate notice and the full production dependency subtree.

Official upstream sources:

- https://huggingface.co/gradium/phonon-31m-en
- https://huggingface.co/gradium/phonon-voices
- https://github.com/gradium-ai/xn-ptts

To refresh the bundled dependency texts after a deliberate lockfile change:

```sh
nix develop -c cargo about generate --locked \
  --manifest-path crates/phonon-local/Cargo.toml \
  --config licenses/cargo/turso-about.toml \
  --target aarch64-linux-android --target aarch64-apple-ios \
  --output-file crates/phonon-local/DEPENDENCY_NOTICES.txt \
  crates/phonon-local/dependency-notices.hbs
```
