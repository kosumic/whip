import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, '..');
const args = process.argv.slice(2);
const ios = args[0] === '--ios';
if (ios) args.shift();
const screenshotsDirectory = ios
  ? resolve(projectRoot, args.shift() ?? '.codex-readme-raw')
  : join(projectRoot, 'assets', 'screenshots');
const outputDirectory = join(
  projectRoot,
  'assets',
  'screenshots',
  ...(ios ? ['ios'] : []),
);
const deviceTag = ios ? 'iphone-16-max' : 'pixel-9-pro';
const frameModule = join(
  projectRoot,
  'node_modules',
  '@sneas',
  'telephone',
  `${deviceTag}.js`,
);

const knownScreenshotNames = [
  'hosts',
  'herd',
  'terminal',
  'chat-view',
  'chat-composer',
  'remote-files',
  'jump-host-agent-forwarding',
  'settings',
  ...(ios
    ? [
        'browser',
        'git-diff',
        'markdown-preview',
        'reverse-control',
        'chat-details',
      ]
    : []),
];

const RAW_SCREENSHOT = Object.freeze(
  ios ? { width: 1206, height: 2622 } : { width: 960, height: 2142 },
);
const IPHONE_FRAME = Object.freeze({
  width: 415,
  height: 843,
  insetX: 15,
  insetY: 12,
});
const FRAME_WIDTH = 706;
// Fit the frame to the capture's aspect ratio; never stretch the app screen.
const FRAME = Object.freeze(
  ios
    ? {
        width: FRAME_WIDTH,
        height: Math.round(
          (FRAME_WIDTH *
            (1 - (2 * IPHONE_FRAME.insetX) / IPHONE_FRAME.width) *
            (RAW_SCREENSHOT.height / RAW_SCREENSHOT.width)) /
            (1 - (2 * IPHONE_FRAME.insetY) / IPHONE_FRAME.height),
        ),
      }
    : { width: FRAME_WIDTH, height: 1490 },
);
const PNG_SIGNATURE = '89504e470d0a1a0a';
const WEBP_QUALITY = 92;

function pngDimensions(buffer: Buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new Error('Expected a PNG image');
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function commandExists(command: string, versionFlag = '-version') {
  return (
    spawnSync(command, [versionFlag], { stdio: 'ignore', timeout: 15_000 })
      .status === 0
  );
}

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    'google-chrome',
    'brave',
    'chromium',
    'chromium-browser',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (commandExists(candidate, '--version')) return candidate;
  }

  throw new Error(
    'Chrome was not found. Set CHROME_BIN or enter a shell that provides Google Chrome, Brave, or Chromium.',
  );
}

function mockupHtml(screenshot: Buffer, frameModuleUrl: string) {
  const screenshotUrl = `data:image/png;base64,${screenshot.toString('base64')}`;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html,
      body {
        width: ${FRAME.width}px;
        height: ${FRAME.height}px;
        margin: 0;
        overflow: hidden;
        background: transparent;
      }

      ${deviceTag} {
        display: block;
        width: ${FRAME.width}px;
      }

      ${deviceTag} img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: fill;
      }
    </style>
    <script defer src="${frameModuleUrl}"></script>
  </head>
  <body>
    <${deviceTag} mode="dark">
      <img src="${screenshotUrl}" alt="">
    </${deviceTag}>
    <script>
      customElements.whenDefined('${deviceTag}').then(() => {
        const phone = document.querySelector('${deviceTag}');
        const svg = phone.shadowRoot.querySelector('svg');
        const children = Array.from(svg.children);
        const statusStart = ${ios} ? children.findIndex((element) =>
          element.tagName === 'rect' && element.getAttribute('x') === '152',
        ) : children.findIndex((element) =>
          element.getAttribute('d')?.startsWith('M40.294'),
        );
        const cameraStart = ${ios} ? children.findIndex((element) =>
          element.tagName === 'defs',
        ) : children.findIndex((element) =>
          element.getAttribute('filter')?.includes('filter0_di_2202_14'),
        );

        if (statusStart < 0 || cameraStart <= statusStart) {
          throw new Error('The pinned phone frame markup changed unexpectedly');
        }

        for (const element of children.slice(statusStart, cameraStart)) {
          element.remove();
        }

        if (${ios}) {
          // Keep the captured Dynamic Island and status UI, with only the
          // physical device frame supplied by @sneas/telephone.
          svg.setAttribute('preserveAspectRatio', 'none');
          svg.setAttribute('height', '${FRAME.height}');
          const style = document.createElement('style');
          style.textContent = '.screenshot { left: ${(100 * IPHONE_FRAME.insetX) / IPHONE_FRAME.width}%; right: ${(100 * IPHONE_FRAME.insetX) / IPHONE_FRAME.width}%; top: ${(100 * IPHONE_FRAME.insetY) / IPHONE_FRAME.height}%; bottom: ${(100 * IPHONE_FRAME.insetY) / IPHONE_FRAME.height}%; }';
          phone.shadowRoot.appendChild(style);
        }

        phone.setAttribute('frame-ready', '');
      });
    </script>
  </body>
</html>`;
}

async function main() {
  const chrome = findChrome();
  if (!commandExists('cwebp')) {
    throw new Error(
      'cwebp was not found. Run the generator through nix develop.',
    );
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), `whip-${deviceTag}-`),
  );
  const stagedMockups = [];

  try {
    await readFile(frameModule);
    const frameModuleUrl = pathToFileURL(frameModule).href;
    const requestedNames = args.map(name => basename(name, '.png'));
    const unknownNames = requestedNames.filter(
      name => !knownScreenshotNames.includes(name),
    );

    if (unknownNames.length > 0) {
      throw new Error(`Unknown README screenshot: ${unknownNames.join(', ')}`);
    }

    const directoryEntries = new Set(await readdir(screenshotsDirectory));
    const screenshotNames = (
      requestedNames.length > 0 ? requestedNames : knownScreenshotNames
    ).filter(name => directoryEntries.has(`${name}.png`));

    if (screenshotNames.length === 0) {
      throw new Error(
        `No unframed README screenshot PNGs were found. Add a ${RAW_SCREENSHOT.width}x${RAW_SCREENSHOT.height} capture or pass its name.`,
      );
    }

    for (const screenshotName of screenshotNames) {
      const screenshotFilename = `${screenshotName}.png`;
      const screenshotPath = join(screenshotsDirectory, screenshotFilename);
      const screenshot = await readFile(screenshotPath);
      const dimensions = pngDimensions(screenshot);

      if (
        dimensions.width !== RAW_SCREENSHOT.width ||
        dimensions.height !== RAW_SCREENSHOT.height
      ) {
        throw new Error(
          `${screenshotFilename} is ${dimensions.width}x${dimensions.height}; expected an unframed ` +
            `${RAW_SCREENSHOT.width}x${RAW_SCREENSHOT.height} ${deviceTag} capture`,
        );
      }

      const htmlPath = join(
        temporaryDirectory,
        `${basename(screenshotName)}.html`,
      );
      const pngOutputPath = join(
        temporaryDirectory,
        `${screenshotName}.framed.png`,
      );
      const webpOutputPath = join(temporaryDirectory, `${screenshotName}.webp`);
      await writeFile(htmlPath, mockupHtml(screenshot, frameModuleUrl));

      const result = spawnSync(
        chrome,
        [
          '--headless=new',
          '--no-sandbox',
          '--disable-gpu',
          '--hide-scrollbars',
          '--allow-file-access-from-files',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-data-dir=${join(temporaryDirectory, 'browser')}`,
          '--run-all-compositor-stages-before-draw',
          '--virtual-time-budget=1000',
          '--force-device-scale-factor=1',
          '--default-background-color=00000000',
          `--window-size=${FRAME.width},${FRAME.height}`,
          `--screenshot=${pngOutputPath}`,
          pathToFileURL(htmlPath).href,
        ],
        { encoding: 'utf8' },
      );

      if (result.status !== 0) {
        throw new Error(
          `Chrome failed while framing ${screenshotFilename}:\n${result.stderr || result.stdout}`,
        );
      }

      const mockup = await readFile(pngOutputPath);
      const mockupDimensions = pngDimensions(mockup);
      if (
        mockupDimensions.width !== FRAME.width ||
        mockupDimensions.height !== FRAME.height
      ) {
        throw new Error(
          `${screenshotFilename} rendered at ${mockupDimensions.width}x${mockupDimensions.height}; ` +
            `expected ${FRAME.width}x${FRAME.height}`,
        );
      }

      const compression = spawnSync(
        'cwebp',
        [
          '-quiet',
          '-q',
          String(WEBP_QUALITY),
          '-alpha_q',
          '100',
          '-m',
          '6',
          '-sharp_yuv',
          pngOutputPath,
          '-o',
          webpOutputPath,
        ],
        { encoding: 'utf8' },
      );

      if (compression.status !== 0) {
        throw new Error(
          `cwebp failed while compressing ${screenshotFilename}:\n` +
            (compression.stderr || compression.stdout),
        );
      }

      stagedMockups.push({
        outputPath: webpOutputPath,
        screenshotPath,
        targetPath: join(outputDirectory, `${screenshotName}.webp`),
      });
    }

    await mkdir(outputDirectory, { recursive: true });
    for (const { outputPath, screenshotPath, targetPath } of stagedMockups) {
      await rename(outputPath, targetPath);
      if (!ios) await unlink(screenshotPath);
      console.log(
        `Framed and compressed ${targetPath.slice(projectRoot.length + 1)}`,
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

await main();
