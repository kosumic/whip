const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const source = resolve(root, 'launch-videos/source-assets/ios');
const output = resolve(root, 'fastlane/metadata/ios/en-US/screenshots');
// Crop the tiny aspect-ratio difference after scaling so the recorded
// interface is never stretched. These cover both existing iPhone media sets.
const sizes = [
  { name: 'iphone-6.5', width: 1242, height: 2688 },
  { name: 'iphone-6.9', width: 1290, height: 2796 },
];
const frames = [
  ['01-herd.png', 'herd-final.mp4', 1],
  ['02-hosts.png', 'hosts.mp4', 0.8],
  ['03-agent-chat.png', 'chat-view.mp4', 0.8],
  ['04-remote-files.png', 'files.mp4', 0.8],
  ['05-git-changes.png', 'files-changes.mp4', 0.8],
  ['06-code-diff.png', 'files-diff.mp4', 0.8],
];
for (const size of sizes) {
  const directory = resolve(output, size.name);
  mkdirSync(directory, { recursive: true });
  for (const [name, video, time] of frames) {
    const result = spawnSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(time),
        '-i',
        resolve(source, video),
        '-frames:v',
        '1',
        '-vf',
        `scale=${size.width}:${size.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${size.width}:${size.height},setsar=1,format=rgb24`,
        resolve(directory, name),
      ],
      { stdio: 'inherit' },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log(`Generated ${name} from ${video} at ${time}s`);
  }
}
