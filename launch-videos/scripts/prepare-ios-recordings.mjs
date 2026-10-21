import {spawnSync} from 'node:child_process';
import {mkdir, readFile, rename} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../source-assets/ios/current');
const source = process.argv[2];
const requested = new Set(process.argv.slice(3));
const FPS = 30;
const ENCODER_THREADS = 2;
const SEEK_INTERVAL_FRAMES = 10;

if (!source) throw new Error('Usage: node prepare-ios-recordings.mjs <raw-recordings-directory> [clip names...]');
const {clips} = JSON.parse(await readFile(resolve(output, 'clips.json'), 'utf8'));
for (const name of requested) {
  if (!clips.some(clip => clip.name === name)) throw new Error(`Unknown recording: ${name}`);
}

await mkdir(output, {recursive: true});
for (const clip of clips) {
  if (requested.size && !requested.has(clip.name)) continue;
  const segments = clip.segments ?? [{start: clip.start, duration: clip.duration, outputDuration: clip.duration}];
  if (!segments.length || segments.some(segment =>
    !Number.isFinite(segment.start) || segment.start < 0 ||
    !Number.isFinite(segment.duration) || segment.duration <= 0 ||
    !Number.isFinite(segment.outputDuration) || segment.outputDuration <= 0)) {
    throw new Error(`${clip.name} has invalid source segments.`);
  }
  const outputDuration = segments.reduce((total, segment) => total + segment.outputDuration, 0);
  if (Math.abs(outputDuration - clip.duration) > 0.001) {
    throw new Error(`${clip.name} segments must cover its ${clip.duration}s timeline slot.`);
  }
  const input = resolve(source, `${clip.source ?? clip.name}.mov`);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', input], {encoding: 'utf8'});
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(probe.stderr);
  const metadata = JSON.parse(probe.stdout);
  const video = metadata.streams.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error(`${clip.name} has no video stream.`);
  if (clip.crop && (
    !['x', 'y', 'width', 'height'].every(key => Number.isInteger(clip.crop[key])) ||
    clip.crop.x < 0 || clip.crop.y < 0 || clip.crop.width <= 0 || clip.crop.height <= 0 ||
    clip.crop.x + clip.crop.width > video.width || clip.crop.y + clip.crop.height > video.height)) {
    throw new Error(`${clip.name} has an invalid notification crop.`);
  }
  const sourceEnd = Math.max(...segments.map(segment => segment.start + segment.duration));
  if (Number(metadata.format.duration) + 1 / FPS < sourceEnd) {
    throw new Error(`${clip.name} is too short for its timeline slot; record a longer take.`);
  }
  const encodedPath = resolve(output, `.${clip.name}.tmp.mp4`);
  // Preserve a short establishing view and the result, while accelerating the
  // intervening real interaction or agent wait. Resample the sparse simulator
  // timestamps before trimming so the frame covering a cut is retained.
  const filters = [
    `[0:v]setpts=PTS-STARTPTS,fps=${FPS},split=${segments.length}${segments.map((_, index) => `[source${index}]`).join('')}`,
    ...segments.map((segment, index) =>
      `[source${index}]trim=start=${segment.start}:duration=${segment.duration},` +
      `setpts=(PTS-STARTPTS)*${segment.outputDuration / segment.duration},fps=${FPS},` +
      `tpad=stop_mode=clone:stop_duration=0.1,trim=duration=${segment.outputDuration},setpts=PTS-STARTPTS[cut${index}]`),
    `${segments.map((_, index) => `[cut${index}]`).join('')}concat=n=${segments.length}:v=1:a=0,` +
      `tpad=stop_mode=clone:stop_duration=0.1,trim=duration=${clip.duration}` +
      (clip.crop ? `,crop=${clip.crop.width}:${clip.crop.height}:${clip.crop.x}:${clip.crop.y}` : '') + '[video]',
  ].join(';');
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '1',
    '-i', input, '-an',
    '-filter_complex', filters, '-map', '[video]',
    '-c:v', 'libx264', '-preset', 'slow', '-threads', String(ENCODER_THREADS),
    // Bound seek history to one third of a second while retaining CRF 18 and
    // full simulator resolution for small UI text.
    '-g', String(SEEK_INTERVAL_FRAMES), '-keyint_min', String(SEEK_INTERVAL_FRAMES),
    '-sc_threshold', '0', '-bf', '0',
    '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    encodedPath,
  ], {stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Encoding ${clip.name} failed`);
  const encoded = spawnSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames',
    '-of', 'csv=p=0', encodedPath,
  ], {encoding: 'utf8'});
  if (encoded.error) throw encoded.error;
  if (encoded.status !== 0 || Number(encoded.stdout.trim()) < Math.floor(clip.duration * FPS)) {
    throw new Error(`${clip.name} does not cover its full timeline slot.`);
  }
  await rename(encodedPath, resolve(output, `${clip.name}.mp4`));
  console.log(`Prepared ${clip.name}.mp4 (${clip.duration}s) from real simulator footage`);
}
