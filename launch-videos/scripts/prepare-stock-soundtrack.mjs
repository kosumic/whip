import {mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../source-assets/music/mixkit-techno-fights-171.mp3');
const duration = 40;
const fadeDuration = 0.65;
const output = resolve(here, '../shared/audio/whip-launch.wav');

await mkdir(dirname(output), {recursive: true});

const result = spawnSync('ffmpeg', [
  '-y',
  '-i', source,
  '-af', [
    // The source is 140 BPM. Conform it to the video's 128 BPM motion grid.
    'atempo=0.9142857143',
    `atrim=duration=${duration}`,
    'afade=t=in:st=0:d=0.15',
    `afade=t=out:st=${duration - fadeDuration}:d=${fadeDuration}`,
    'asetpts=N/SR/TB',
  ].join(','),
  '-ar', '48000',
  '-ac', '2',
  '-c:a', 'pcm_s16le',
  output,
], {stdio: 'inherit'});

if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Prepared ${duration}s Mixkit soundtrack: ${output}`);
