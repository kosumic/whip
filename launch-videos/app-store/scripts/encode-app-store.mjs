import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delivery = path.join(project, 'renders');
const input = path.join(delivery, 'whip-app-store-master.mp4');
const output = path.join(delivery, 'whip-app-store-iphone.mp4');
const duration = 30;
const fps = 30;

mkdirSync(delivery, {recursive: true});
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'warning', '-y', '-i', input,
  '-map', '0:v:0', '-map', '0:a:0',
  '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.0',
  '-pix_fmt', 'yuv420p', '-b:v', '10M', '-maxrate', '12M', '-bufsize', '24M',
  '-r', String(fps), '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2',
  '-movflags', '+faststart', '-t', String(duration), output,
], {stdio: 'inherit'});

const probe = JSON.parse(execFileSync('ffprobe', [
  '-v', 'error', '-show_format', '-show_streams', '-of', 'json', output,
], {encoding: 'utf8'}));
const video = probe.streams.find(stream => stream.codec_type === 'video');
const audio = probe.streams.find(stream => stream.codec_type === 'audio');
const checks = {
  dimensions: video?.width === 886 && video?.height === 1920,
  codec: video?.codec_name === 'h264' && video?.profile === 'High' && video?.level === 40,
  pixels: video?.pix_fmt === 'yuv420p' && video?.field_order === 'progressive',
  frameRate: video?.avg_frame_rate === `${fps}/1`,
  duration: Math.abs(Number(probe.format.duration) - duration) < 0.05,
  audio: audio?.codec_name === 'aac' && audio?.channels === 2 && audio?.sample_rate === '48000',
  size: Number(probe.format.size) < 500 * 1024 * 1024,
};
writeFileSync(path.join(delivery, 'app-store-validation.json'), `${JSON.stringify({checks, probe}, null, 2)}\n`);
if (Object.values(checks).some(valid => !valid)) {
  throw new Error(`App Store delivery validation failed: ${JSON.stringify(checks)}`);
}
console.log(`App Store delivery validated: ${output}`);
