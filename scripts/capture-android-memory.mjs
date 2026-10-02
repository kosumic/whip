#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const PACKAGE = 'io.github.kaminarios.whip';
const DEFAULT_SAMPLES = 3;
const SAMPLE_INTERVAL_MS = 2_000;
const [label, outputArgument, samplesArgument = String(DEFAULT_SAMPLES)] = process.argv.slice(2);
const sampleCount = Number(samplesArgument);

if (!label || !/^[a-zA-Z0-9_-]+$/.test(label)
  || !Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 60) {
  console.error('Usage: nix develop -c node scripts/capture-android-memory.mjs <label> [new-output-directory] [samples:1-60]');
  process.exit(2);
}

async function command(executable, args) {
  const { stdout } = await exec(executable, args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

function parseProcesses(text) {
  const sections = [...text.matchAll(/^\*\* MEMINFO in pid (\d+) \[([^\]]+)\] \*\*$/gm)];
  if (!sections.some(section => section[2] === PACKAGE)) {
    throw new Error('Whip is not running or Android did not return per-process memory data.');
  }
  return sections.map((section, index) => {
    const body = text.slice(section.index, sections[index + 1]?.index);
    const field = expression => {
      const value = expression.exec(body)?.[1];
      return value === undefined ? null : Number(value);
    };
    const allocation = heap => {
      const columns = new RegExp(`^\\s*${heap} Heap\\s+([\\d ]+)$`, 'm')
        .exec(body)?.[1].trim().split(/\s+/).map(Number);
      // The final three columns are heap size, allocated, and free.
      return columns?.length >= 7 ? columns.at(-2) : null;
    };
    const totals = {
      reportedPssKb: field(/TOTAL PSS:\s+(\d+)/),
      rssKb: field(/TOTAL RSS:\s+(\d+)/),
      swapPssKb: field(/TOTAL SWAP PSS:\s+(\d+)/),
    };
    if (Object.values(totals).some(value => value === null)) {
      throw new Error(`Missing memory totals for ${section[2]}; inspect the raw meminfo file.`);
    }
    return {
      pid: Number(section[1]), name: section[2], ...totals,
      nativeHeapAllocatedKb: allocation('Native'),
      javaHeapAllocatedKb: allocation('Dalvik'),
      views: field(/Views:\s+(\d+)/),
      webViews: field(/WebViews:\s+(\d+)/),
    };
  });
}

try {
  const devices = (await command('adb', ['devices']))
    .split('\n').map(line => /^(\S+)\s+device$/.exec(line.trim()))
    .filter(Boolean).map(match => match[1]);
  const serial = process.env.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : undefined);
  if (!serial || !devices.includes(serial)) {
    throw new Error('Select one authorized device with ANDROID_SERIAL, or connect exactly one device.');
  }
  const adb = args => command('adb', ['-s', serial, ...args]);
  const startedAt = new Date().toISOString();
  const output = resolve(outputArgument || `artifacts/memory/${startedAt.replaceAll(':', '-')}-${label}`);
  // Refuse to overwrite an earlier capture.
  await mkdir(resolve(output, '..'), { recursive: true });
  await mkdir(output);

  const [device, version, systemMemory, storage, exitInfo] = await Promise.all([
    adb(['shell', 'getprop', 'ro.build.fingerprint']),
    adb(['shell', 'dumpsys', 'package', PACKAGE]),
    adb(['shell', 'cat', '/proc/meminfo']),
    adb(['shell', 'df', '-k', '/data']),
    adb(['shell', 'dumpsys', 'activity', 'exit-info', PACKAGE]),
  ]);
  const summary = {
    label, startedAt, device: device.trim(), package: PACKAGE,
    installedBuild: version.split('\n').filter(line =>
      /versionCode=|versionName=|lastUpdateTime=|primaryCpuAbi=/.test(line)).map(line => line.trim()),
    notes: 'Values are KiB. Reported PSS and SwapPSS can overlap; do not add them. Native heap allocations include Hermes and native libraries, not just Rust. Compare the same PID and workload. dumpsys may request GC.',
    samples: [],
  };
  await Promise.all([
    writeFile(resolve(output, 'system-memory.txt'), systemMemory),
    writeFile(resolve(output, 'storage.txt'), storage),
    writeFile(resolve(output, 'exit-info.txt'), exitInfo),
  ]);

  for (let index = 0; index < sampleCount; index += 1) {
    if (index > 0) await delay(SAMPLE_INTERVAL_MS);
    const timestamp = new Date().toISOString();
    // --package includes associated isolated WebView processes as well as Whip.
    const memory = await adb(['shell', 'dumpsys', 'meminfo', '--package', PACKAGE]);
    await writeFile(resolve(output, `meminfo-${index + 1}.txt`), memory);
    const processes = parseProcesses(memory);
    summary.samples.push({ timestamp, processes });
    await writeFile(resolve(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    for (const process of processes) {
      console.log(`${index + 1}/${sampleCount} pid=${process.pid} ${process.name}: native allocated=${process.nativeHeapAllocatedKb} KiB, RSS=${process.rssKb} KiB, swap=${process.swapPssKb} KiB`);
    }
  }
  console.log(`Saved ${output}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
