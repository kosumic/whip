# Whip App Store preview

A 30-second, 886×1920 native-footage adaptation for the iOS 1.9.1 listing.
Source recordings and music are the frozen TikTok assets; that film is separate.

```sh
nix develop
npm --prefix launch-videos/app-store ci --ignore-scripts
npm --prefix launch-videos/app-store run prepare
npm --prefix launch-videos/app-store run check
npm --prefix launch-videos/app-store run snapshot
npm --prefix launch-videos/app-store run preview
```

Every scene shows complete native app footage with plain cuts. The final copy
identifies free core features and paid appearance options. The hidden tip
product is not promoted. Preparation records hashes in `.media/assets.json`.
The final SFTP shot holds the last stable file-list frame before a file opens,
so the preview ends on readable content rather than a loading indicator.

Apple specifications: [app previews](https://developer.apple.com/app-store/app-previews/)
and [encoding and dimensions](https://developer.apple.com/help/app-store-connect/reference/app-information/app-preview-specifications/).
Delivery: progressive H.264 High Level 4.0, 30fps, 10Mbps target (12Mbps peak), stereo AAC at
256kbps/48kHz, fast-start MP4 and 30-second duration.
After final-preview approval, run `npm run render` and `npm run encode` from this
directory. The upload file is `renders/whip-app-store-iphone.mp4`; encoding also
records stream and format checks in `renders/app-store-validation.json`.

Music: Tech House vibes by Alejandro Magaña (A. M.), Mixkit catalog 130.
See [the license](../source-assets/music/TIKTOK-MUSIC-LICENSE.md).
Inter retains its SIL Open Font License.

The account holder approved the final preview on 2026-10-21. The exported
30-second file passed stream checks and a complete decode, with the completed
composer draft and final disclosure inspected again in decoded frames.
