import { copyFile, mkdir, readFile, writeFile as writeAsset } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import androidImeBridge from './android-ime-bridge.cjs';
import terminalClipboardPaste from './terminal-clipboard-paste.cjs';
import terminalOfflineCache from './terminal-offline-cache.cjs';
import terminalLinkExtraction from './terminal-link-extraction.cjs';
import terminalTouchBehavior from './terminal-touch-behavior.cjs';
import terminalBoundaryScrollModel from '../src/lib/terminalBoundaryScroll.cjs';
import terminalControlCharacter from '../src/lib/terminalControlCharacter.cjs';

const { legacyControlCharacter } = terminalControlCharacter;
const { installAndroidImeBridge, terminalInputDelta } = androidImeBridge;
const { createTerminalPasteBridge } = terminalClipboardPaste;
const { createTerminalOfflineCache } = terminalOfflineCache;
const {
  handleKeyboardClosedStationaryTap,
  setTerminalKeyboardInputEnabled,
  terminalMouseClickInput,
  terminalMouseInputSequence,
  terminalMouseWheelInput,
} = terminalTouchBehavior;
// This pure model is the authoritative implementation. The same functions are
// imported by TypeScript callers/tests and stringified into both WebView assets.
const {
  reconcileTerminalBoundaryScroll,
  terminalAtVisualBottom,
  terminalBoundaryClamp,
  terminalBoundaryFiniteNumber,
  terminalBoundaryScroll,
  terminalBoundaryScrollToVisualBottom,
  terminalBoundaryVisualOffset,
} = terminalBoundaryScrollModel;
const {
  extractTerminalLinks,
  mergeTerminalLinks,
  osc8LinkAt,
  osc8LinkFromData,
  terminalLinkAt,
  terminalLinkCandidates,
  trimTerminalUrl,
} = terminalLinkExtraction;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Validate every generated or copied asset without rewriting files.
const checkOnly = process.argv.includes('--check');
const writeFile = async (path, content, encoding) => {
  if (checkOnly) {
    if (await readFile(path, encoding) !== content) {
      throw new Error('Generated asset is stale: ' + path);
    }
    return;
  }
  await writeAsset(path, content, encoding);
};
const assets = resolve(root, 'android/app/src/main/assets');
const iosAssets = resolve(
  root,
  'modules/whip-terminal-assets/ios/TerminalAssets',
);
const terminalFonts = resolve(root, 'assets/terminal-fonts');
const fontManifest = JSON.parse(
  await readFile(resolve(terminalFonts, 'manifest.json'), 'utf8'),
);
const jetBrainsMonoRegular = resolve(
  terminalFonts,
  fontManifest.text.regularFile,
);
const jetBrainsMonoBold = resolve(terminalFonts, fontManifest.text.boldFile);
const jetBrainsMonoLicense = resolve(
  terminalFonts,
  fontManifest.text.licenseFile,
);
const cjkRegular = resolve(terminalFonts, fontManifest.cjk.regularFile);
const cjkLicense = resolve(terminalFonts, fontManifest.cjk.licenseFile);
const nerdSymbolsRegular = resolve(
  terminalFonts,
  fontManifest.symbols.regularFile,
);
const nerdSymbolsLicense = resolve(
  terminalFonts,
  fontManifest.symbols.licenseFile,
);
const terminalFontFormat = 'woff2';
const terminalFontFamily = fallback => [
  fontManifest.text.cssFamily,
  fontManifest.emoji.cssFamily,
  fontManifest.symbols.cssFamily,
  fontManifest.cjk.cssFamily,
  fallback.cssFamily,
].map(family => family.endsWith('monospace') ? family : `"${family}"`).join(', ');
const androidTerminalFontFamily = terminalFontFamily(fontManifest.fallback.android);
const iosTerminalFontFamily = terminalFontFamily(fontManifest.fallback.ios);
if (!checkOnly) {
  await mkdir(assets, { recursive: true });
  await mkdir(iosAssets, { recursive: true });
}
const copyTerminalAsset = async (source, bundledName) => {
  const expected = checkOnly ? await readFile(source) : null;
  await Promise.all([assets, iosAssets].map(async directory => {
    const destination = resolve(directory, bundledName);
    if (checkOnly) {
      if (!(await readFile(destination)).equals(expected)) {
        throw new Error('Copied asset is stale: ' + destination);
      }
    } else {
      await copyFile(source, destination);
    }
  }));
};
await Promise.all([
  copyTerminalAsset(
    resolve(root, 'node_modules/@xterm/xterm/lib/xterm.js'),
    'xterm.js',
  ),
  copyTerminalAsset(
    resolve(root, 'node_modules/@xterm/xterm/css/xterm.css'),
    'xterm.css',
  ),
  copyTerminalAsset(
    resolve(root, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'),
    'addon-fit.js',
  ),
  copyTerminalAsset(
    resolve(root, 'node_modules/@xterm/addon-image/lib/addon-image.js'),
    'addon-image.js',
  ),
  copyTerminalAsset(
    resolve(root, 'node_modules/@xterm/addon-serialize/lib/addon-serialize.js'),
    'addon-serialize.js',
  ),
  copyTerminalAsset(
    resolve(root, 'node_modules/mermaid/dist/mermaid.min.js'),
    'mermaid.min.js',
  ),
  copyTerminalAsset(
    resolve(root, 'node_modules/mermaid/LICENSE'),
    'mermaid-LICENSE.txt',
  ),
  copyTerminalAsset(
    resolve(root, 'scripts/mermaid-preview-runtime.js'),
    'mermaid-preview.js',
  ),
  copyTerminalAsset(
    jetBrainsMonoRegular,
    fontManifest.text.bundledRegularFile,
  ),
  copyTerminalAsset(
    jetBrainsMonoBold,
    fontManifest.text.bundledBoldFile,
  ),
  copyTerminalAsset(
    jetBrainsMonoLicense,
    fontManifest.text.bundledLicenseFile,
  ),
  copyTerminalAsset(cjkRegular, fontManifest.cjk.bundledRegularFile),
  copyTerminalAsset(cjkLicense, fontManifest.cjk.bundledLicenseFile),
  copyTerminalAsset(
    nerdSymbolsRegular,
    fontManifest.symbols.bundledRegularFile,
  ),
  copyTerminalAsset(
    nerdSymbolsLicense,
    fontManifest.symbols.bundledLicenseFile,
  ),
]);

const mermaidPreviewHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <base href="file:///android_asset/">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: https:; font-src data:">
  <style>
    :root { color-scheme: dark; }
    :root[data-appearance='light'] { color-scheme: light; }
    html, body { width: 100%; min-height: 100%; margin: 0; background: transparent; }
    body { box-sizing: border-box; overflow: auto; padding: 16px; }
    #diagram { display: flex; min-width: 100%; min-height: calc(100vh - 32px); align-items: center; justify-content: center; }
    #diagram svg { display: block; width: auto; max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <main id="diagram" aria-live="polite"></main>
  <script src="mermaid.min.js"></script>
  <script src="mermaid-preview.js"></script>
</body>
</html>`;

await writeFile(
  resolve(assets, 'mermaid-preview.html'),
  mermaidPreviewHtml,
  'utf8',
);
await writeFile(
  resolve(iosAssets, 'mermaid-preview.html'),
  mermaidPreviewHtml.replace('  <base href="file:///android_asset/">\n', ''),
  'utf8',
);

const terminalSessionHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <base href="file:///android_asset/">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <link rel="stylesheet" href="xterm.css">
  <style>
    @font-face {
      font-family: '${fontManifest.text.cssFamily}';
      src: url('${fontManifest.text.bundledRegularFile}') format('${terminalFontFormat}');
      font-style: normal;
      font-weight: 400;
      font-display: block;
    }
    @font-face {
      font-family: '${fontManifest.text.cssFamily}';
      src: url('${fontManifest.text.bundledBoldFile}') format('${terminalFontFormat}');
      font-style: normal;
      font-weight: 700;
      font-display: block;
    }
    @font-face {
      font-family: '${fontManifest.symbols.cssFamily}';
      src: url('${fontManifest.symbols.bundledRegularFile}') format('${terminalFontFormat}');
      font-style: normal;
      font-weight: 400;
      font-display: block;
    }
    @font-face {
      font-family: '${fontManifest.cjk.cssFamily}';
      src: url('${fontManifest.cjk.bundledRegularFile}') format('${terminalFontFormat}');
      font-style: normal;
      font-weight: 400;
      font-display: block;
    }
    html, body, #terminal-geometry, #terminal { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    html { -webkit-text-size-adjust: none; text-size-adjust: none; }
    #terminal-background-layer { position: fixed; inset: 0; z-index: 2; display: none; mix-blend-mode: screen; pointer-events: none; }
    #terminal-background-image { width: 100%; height: 100%; object-fit: cover; }
    #terminal-background-glass { position: absolute; inset: 0; }
    #terminal-geometry { position: relative; z-index: 1; box-sizing: border-box; height: calc(100% - var(--terminal-geometry-bottom, 0px)); overflow: visible; transform: translateY(var(--terminal-visual-offset, 0px)); will-change: transform; }
    #terminal { position: relative; box-sizing: border-box; }
    #terminal-visual-debug { position: fixed; z-index: 30; top: 104px; right: 8px; display: none; max-width: calc(100% - 16px); padding: 5px 7px; border: 1px solid #7aa2f7aa; border-radius: 7px; background: #16161ed9; color: #c0caf5; font: 700 9px/1.35 monospace; white-space: pre-wrap; pointer-events: none; }
    .xterm { height: 100%; }
    .xterm-viewport { overflow-y: hidden !important; scrollbar-width: none !important; background-color: transparent !important; }
    .xterm-viewport::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
    .xterm .scrollbar { display: none !important; }
    #selection-toolbar { position: fixed; z-index: 20; display: none; gap: 1px; padding: 3px; background: #24283b; border: 1px solid #414868; border-radius: 10px; box-shadow: 0 4px 16px #0008; }
    #selection-toolbar button { appearance: none; border: 0; border-radius: 7px; background: transparent; color: #c0caf5; padding: 8px 10px; font: 700 10px '${fontManifest.text.cssFamily}', monospace; }
    #selection-toolbar button:active { background: #7aa2f7; color: #16161e; }
    #selection-handles { position: fixed; inset: 0; z-index: 19; pointer-events: none; }
    .selection-handle { position: fixed; display: none; width: 22px; height: 22px; box-sizing: border-box; border: 2px solid #16161e; border-radius: 50%; background: #7aa2f7; box-shadow: 0 2px 6px #0009; pointer-events: auto; touch-action: none; transform: translate(-50%, 3px); }
    .selection-handle::before { content: ''; position: absolute; left: 50%; top: -6px; width: 4px; height: 7px; border-radius: 2px 2px 0 0; background: #7aa2f7; transform: translateX(-50%); }
    .selection-handle.dragging { width: 26px; height: 26px; background: #9ab8ff; }
  </style>
</head>
<body>
  <div id="terminal-background-layer">
    <img id="terminal-background-image" alt="" />
    <div id="terminal-background-glass"></div>
  </div>
  <div id="terminal-geometry"><div id="terminal"></div></div>
  <pre id="terminal-visual-debug" aria-hidden="true"></pre>
  <div id="selection-handles" aria-hidden="true">
    <div id="selection-start-handle" class="selection-handle"></div>
    <div id="selection-end-handle" class="selection-handle"></div>
  </div>
  <div id="selection-toolbar"><button id="copy-selection">COPY</button><button id="select-all-selection">SELECT ALL</button><button id="paste-selection">PASTE</button></div>
  <script src="xterm.js"></script>
  <script src="addon-fit.js"></script>
  <script src="addon-image.js"></script>
  <script src="addon-serialize.js"></script>
  <script>
    ${terminalInputDelta.toString()}
    ${installAndroidImeBridge.toString()}
    ${createTerminalPasteBridge.toString()}
    ${createTerminalOfflineCache.toString()}
    ${handleKeyboardClosedStationaryTap.toString()}
    ${setTerminalKeyboardInputEnabled.toString()}
    ${terminalMouseInputSequence.toString()}
    ${terminalMouseClickInput.toString()}
    ${terminalMouseWheelInput.toString()}
    ${terminalBoundaryFiniteNumber.toString()}
    ${terminalBoundaryClamp.toString()}
    ${terminalBoundaryVisualOffset.toString()}
    ${terminalAtVisualBottom.toString()}
    ${terminalBoundaryScrollToVisualBottom.toString()}
    ${reconcileTerminalBoundaryScroll.toString()}
    ${terminalBoundaryScroll.toString()}
    const terminalFontFamily = '${androidTerminalFontFamily}';
    const fontReady = document.fonts?.load
      ? Promise.all([
          document.fonts.load('400 8px "${fontManifest.text.cssFamily}"'),
          document.fonts.load('700 8px "${fontManifest.text.cssFamily}"'),
          document.fonts.load('400 8px "${fontManifest.symbols.cssFamily}"', '\\uf120'),
          document.fonts.load('400 8px "${fontManifest.cjk.cssFamily}"', '\\u4e2d'),
        ]).then(() => document.fonts.ready)
      : Promise.resolve();
    const initializeTerminal = () => {
      const send = value => window.parent.postMessage({ herdrTerminalMessage: value }, '*');
      const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: true,
      linkHandler: { activate: (_event, link) => send({ type: 'open-link', link }) },
      fontFamily: terminalFontFamily,
      fontSize: 8,
      fontWeight: '400',
      fontWeightBold: '700',
      lineHeight: 1.12,
      letterSpacing: 0,
      scrollback: 5000,
      scrollbar: { showScrollbar: false },
      theme: {
        background: 'rgba(0,0,0,0)', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#283457',
        black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
        blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
        brightBlack: '#414868', brightRed: '#ff899d', brightGreen: '#9fe044',
        brightYellow: '#faba4a', brightBlue: '#8db0ff', brightMagenta: '#c7a9ff',
        brightCyan: '#a4daff', brightWhite: '#c0caf5'
      }
    });
    const fit = new FitAddon.FitAddon();
    terminal.loadAddon(fit);
    const images = new ImageAddon.ImageAddon({
      kittySupport: true,
      sixelSupport: false,
      iipSupport: false,
      enableSizeReports: true,
      pixelLimit: 4194304,
      kittySizeLimit: 8388608,
      storageLimit: 8,
      showPlaceholder: true,
    });
    terminal.loadAddon(images);
    const serializer = new SerializeAddon.SerializeAddon();
    terminal.loadAddon(serializer);
    terminal.open(document.getElementById('terminal'));
    let lastTap = null;
    let doubleTapAction = 'tab';
    let keyboardEnabled = false;
    let forcedMouseInput = false;
    let localScrollback = false;
    let offlineScrollback = false;
    let offlineTranscriptChunks = [];
    let offlineTranscriptVisible = false;
    let lastReportedOfflineScroll = '';
    let terminalVisualInsets = {
      top: 0,
      bottom: 0,
      geometryBottomInset: 0,
      debug: false,
      alternateScreen: false,
      scrollOffsetFromBottom: undefined,
      maxScrollOffsetFromBottom: undefined,
    };
    let lastTerminalVisualState = '';
    let lastReportedAtVisualBottom;
    let remoteVisualScrollOffset;
    let remoteVisualScrollMaximum;
    let remoteVisualInputOffset;
    let remoteVisualInputMaximum;
    let remoteVisualPendingDelta = 0;
    let terminalBoundaryScrollState = {
      offsetFromBottom: 0,
      maxOffsetFromBottom: 0,
      boundary: null,
      boundaryRevealPx: 0,
      boundaryAllowancePx: 0,
      rowRemainderPx: 0,
    };
    setTerminalKeyboardInputEnabled(terminal, keyboardEnabled);
    const offlineCache = createTerminalOfflineCache({
      serialize: options => serializer.serialize(options),
      send,
    });
    const offlineScrollInfo = () => ({
      offsetFromBottom: Math.max(0, terminal.buffer.active.baseY - terminal.buffer.active.viewportY),
      maxOffsetFromBottom: Math.max(0, terminal.buffer.active.baseY),
      viewportRows: Math.max(0, terminal.rows),
    });
    const reportOfflineScroll = () => {
      if (!offlineScrollback) return;
      const scroll = offlineScrollInfo();
      const signature = scroll.offsetFromBottom + ':' + scroll.maxOffsetFromBottom + ':' + scroll.viewportRows;
      if (signature === lastReportedOfflineScroll) return;
      lastReportedOfflineScroll = signature;
      send({ type: 'offline-scroll', ...scroll });
    };
    const finiteInset = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
    const reportTerminalVisualScrollState = atVisualBottom => {
      if (atVisualBottom === lastReportedAtVisualBottom) return;
      lastReportedAtVisualBottom = atVisualBottom;
      send({ type: 'visual-scroll-state', atVisualBottom });
    };
    const reportTerminalVisualState = state => {
      const signature = JSON.stringify(state);
      const debug = document.getElementById('terminal-visual-debug');
      if (debug) {
        debug.style.display = terminalVisualInsets.debug ? 'block' : 'none';
        debug.textContent = terminalVisualInsets.debug
          ? (state.alternateScreen ? 'ALT' : 'NORMAL')
            + '  scroll ' + state.offset + '/' + state.maximum
            + '  visual ' + state.visualOffset
            + '\\nT ' + state.top + '  B ' + state.bottom + '  G ' + state.geometryBottom
            + '  boundary ' + (state.boundary || '-') + '/' + state.boundaryRevealPx
            + (state.remoteScroll ? '\\nin ' + state.inputOffset + '  pending ' + state.pendingDelta : '')
            + (Number.isFinite(state.surfaceTop) ? '\\nS ' + state.surfaceTop + '..' + state.surfaceBottom + '/' + state.viewportHeight : '')
          : '';
      }
      if (signature === lastTerminalVisualState) return;
      lastTerminalVisualState = signature;
      send({ type: 'visual-insets-debug', ...state });
    };
    const applyTerminalVisualInsets = () => {
      const terminalElement = document.getElementById('terminal');
      const geometryElement = document.getElementById('terminal-geometry');
      if (!terminalElement || !geometryElement) return;
      const geometryBottom = finiteInset(terminalVisualInsets.geometryBottomInset);
      geometryElement.style.setProperty('--terminal-geometry-bottom', geometryBottom + 'px');
      const local = offlineScrollInfo();
      const hasRemoteScroll = Number.isFinite(remoteVisualScrollOffset)
        && Number.isFinite(remoteVisualScrollMaximum);
      const offset = hasRemoteScroll
        ? Math.max(0, Number(remoteVisualScrollOffset))
        : local.offsetFromBottom;
      const maximum = hasRemoteScroll
        ? Math.max(0, Number(remoteVisualScrollMaximum))
        : local.maxOffsetFromBottom;
      const top = finiteInset(terminalVisualInsets.top);
      const bottomAllowance = Math.max(0, finiteInset(terminalVisualInsets.bottom) - geometryBottom);
      const alternateScreen = terminalVisualInsets.alternateScreen
        || terminal.buffer.active.type === 'alternate';
      terminalBoundaryScrollState = reconcileTerminalBoundaryScroll({
        state: terminalBoundaryScrollState,
        offsetFromBottom: offset,
        maxOffsetFromBottom: maximum,
        topAllowancePx: top,
        bottomAllowancePx: bottomAllowance,
        alternateScreen,
      });
      const visualOffset = terminalBoundaryVisualOffset({
        alternateScreen,
        boundary: terminalBoundaryScrollState.boundary,
        boundaryRevealPx: terminalBoundaryScrollState.boundaryRevealPx,
      });
      geometryElement.style.setProperty('--terminal-visual-offset', visualOffset + 'px');
      const atVisualBottom = terminalAtVisualBottom({
        state: terminalBoundaryScrollState,
        bottomAllowancePx: bottomAllowance,
        alternateScreen,
      });
      reportTerminalVisualScrollState(atVisualBottom);
      const surfaceRect = geometryElement.getBoundingClientRect();
      reportTerminalVisualState({
        alternateScreen,
        top,
        bottom: finiteInset(terminalVisualInsets.bottom),
        geometryBottom,
        offset,
        maximum,
        visualOffset,
        boundary: terminalBoundaryScrollState.boundary,
        boundaryRevealPx: terminalBoundaryScrollState.boundaryRevealPx,
        atVisualBottom,
        remoteScroll: hasRemoteScroll,
        inputOffset: remoteVisualInputOffset,
        pendingDelta: remoteVisualPendingDelta,
        surfaceTop: Math.round(surfaceRect.top),
        surfaceBottom: Math.round(surfaceRect.bottom),
        viewportHeight: Math.round(window.innerHeight),
      });
    };
    window.herdrSetVisualInsets = options => {
      const nextInputOffset = Number(options?.scrollOffsetFromBottom);
      const nextInputMaximum = Number(options?.maxScrollOffsetFromBottom);
      if (Number.isFinite(nextInputOffset) && Number.isFinite(nextInputMaximum)) {
        const normalizedInputMaximum = Math.max(0, nextInputMaximum);
        const normalizedInputOffset = Math.max(0, Math.min(normalizedInputMaximum, nextInputOffset));
        const inputOffsetChanged = normalizedInputOffset !== remoteVisualInputOffset;
        const inputMaximumChanged = normalizedInputMaximum !== remoteVisualInputMaximum;
        if (inputOffsetChanged || inputMaximumChanged) {
          remoteVisualInputOffset = normalizedInputOffset;
          remoteVisualInputMaximum = normalizedInputMaximum;
          remoteVisualScrollMaximum = normalizedInputMaximum;
          if (inputOffsetChanged) {
            remoteVisualPendingDelta = 0;
            remoteVisualScrollOffset = normalizedInputOffset;
          } else {
            remoteVisualScrollOffset = Math.max(0, Math.min(
              normalizedInputMaximum,
              normalizedInputOffset + remoteVisualPendingDelta,
            ));
            remoteVisualPendingDelta = remoteVisualScrollOffset - normalizedInputOffset;
          }
        }
      } else {
        remoteVisualScrollOffset = undefined;
        remoteVisualScrollMaximum = undefined;
        remoteVisualInputOffset = undefined;
        remoteVisualInputMaximum = undefined;
        remoteVisualPendingDelta = 0;
      }
      terminalVisualInsets = { ...terminalVisualInsets, ...(options || {}) };
      applyTerminalVisualInsets();
    };
    const handleOfflineInput = data => {
      if (!offlineScrollback || typeof data !== 'string') return false;
      const page = Math.max(1, terminal.rows - 1);
      if (data === '\u001b[A' || data === '\u001bOA') terminal.scrollLines(-1);
      else if (data === '\u001b[B' || data === '\u001bOB') terminal.scrollLines(1);
      else if (data === '\u001b[5~' || data === '\u001b[1;5A') terminal.scrollLines(-page);
      else if (data === '\u001b[6~' || data === '\u001b[1;5B') terminal.scrollLines(page);
      else if (data === '\u001b[H' || data === '\u001bOH') terminal.scrollToTop();
      else if (data === '\u001b[F' || data === '\u001bOF') terminal.scrollToBottom();
      else return false;
      return true;
    };
    ${legacyControlCharacter.toString()}
    terminal.attachCustomKeyEventHandler(event => {
      if (offlineScrollback) {
        if (event.type === 'keydown') {
          const offlineKey = event.key === 'ArrowUp' ? '\u001b[A'
            : event.key === 'ArrowDown' ? '\u001b[B'
              : event.key === 'PageUp' ? '\u001b[5~'
                : event.key === 'PageDown' ? '\u001b[6~'
                  : event.key === 'Home' ? '\u001b[H'
                    : event.key === 'End' ? '\u001b[F'
                      : '';
          if (offlineKey) handleOfflineInput(offlineKey);
          event.preventDefault();
          event.stopPropagation();
        }
        return false;
      }
      if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
      // Keep the Ctrl-letter workaround; xterm owns other hardware key events.
      if (!/^[a-z]$/i.test(event.key)) return true;
      const sequence = legacyControlCharacter(event.key);
      if (sequence === null) return true;
      event.preventDefault();
      event.stopPropagation();
      send({ type: 'input', data: sequence });
      return false;
    });
    let bufferedInput = null;
    let fitResizeInProgress = false;
    let resetAndroidImeAfterPaste = () => {};
    const pasteBridge = createTerminalPasteBridge(
      terminal,
      (data, kind) => {
        if (bufferedInput !== null) bufferedInput += data;
        else send({ type: 'input', data, kind });
      },
      window,
      () => resetAndroidImeAfterPaste(),
    );
    const disposeAndroidImeBridge = installAndroidImeBridge(
      terminal,
      send,
      navigator.userAgent,
    );
    resetAndroidImeAfterPaste = disposeAndroidImeBridge.reset;
    terminal.onData(data => {
      if (offlineScrollback) {
        handleOfflineInput(data);
        return;
      }
      pasteBridge.handleData(data);
    });
    terminal.onResize(({ cols, rows }) => {
      if (!fitResizeInProgress) {
        send({ type: 'resize', source: 'xterm', cols, rows, requestedAtEpochMs: Date.now() });
      }
      reportOfflineScroll();
    });
    terminal.parser.registerOscHandler(52, data => {
      const separator = data.indexOf(';');
      const payload = separator >= 0 ? data.slice(separator + 1) : '';
      if (!payload || payload === '?') return true;
      try { send({ type: 'clipboard-write', text: decodeURIComponent(escape(atob(payload))) }); } catch {}
      return true;
    });
    ${osc8LinkFromData.toString()}
    const osc8Links = new Set();
    let osc8LinkSequence = 0;
    let openOsc8Link = null;
    const finishOsc8Link = () => {
      if (!openOsc8Link) return;
      const link = openOsc8Link;
      openOsc8Link = null;
      const endMarker = terminal.registerMarker();
      if (!endMarker) return;
      link.endMarker = endMarker;
      link.endColumn = terminal.buffer.active.cursorX;
      endMarker.onDispose(() => osc8Links.delete(link));
    };
    const clearOsc8Links = () => {
      openOsc8Link = null;
      for (const link of osc8Links) {
        link.marker.dispose();
        link.endMarker?.dispose();
      }
      osc8Links.clear();
      osc8LinkSequence = 0;
    };
    terminal.parser.registerOscHandler(8, data => {
      const separator = data.indexOf(';');
      if (separator < 0) return false;
      const params = data.slice(0, separator).trim();
      const target = data.slice(separator + 1);
      if (!target) {
        if (!params) finishOsc8Link();
        return false;
      }
      finishOsc8Link();
      const href = osc8LinkFromData(data);
      if (href) {
        const marker = terminal.registerMarker();
        if (marker) {
          const link = {
            href,
            marker,
            endMarker: null,
            startColumn: terminal.buffer.active.cursorX,
            endColumn: null,
            sequence: ++osc8LinkSequence,
          };
          osc8Links.add(link);
          openOsc8Link = link;
          marker.onDispose(() => {
            osc8Links.delete(link);
            if (openOsc8Link === link) openOsc8Link = null;
          });
        }
      }
      return false;
    });
    const prepareLiveWrite = () => {
      if (!offlineTranscriptVisible) return;
      offlineTranscriptVisible = false;
      offlineTranscriptChunks = [];
      lastReportedOfflineScroll = '';
      clearOsc8Links();
      clearInteractiveSelection(false);
      // Queue RIS through xterm's parser so it cannot race a pending transcript.
      terminal.write('\u001bc');
    };
    let renderDrop = false;
    const reportTracePhase = (type, inboundCookie) => {
      if (Number.isInteger(inboundCookie)) send({ type, inboundCookie });
    };
    const reportTraceRendered = (inputCookie, resizeCookie, inboundCookie) => {
      if (!Number.isInteger(inputCookie) && !Number.isInteger(resizeCookie) && !Number.isInteger(inboundCookie)) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        send({ type: 'trace-rendered', inputCookie, resizeCookie, inboundCookie });
      }));
    };
    window.herdrWrite = (data, inputCookie, resizeCookie, inboundCookie) => {
      reportTracePhase('trace-write-received', inboundCookie);
      if (renderDrop) {
        reportTracePhase('trace-xterm-written', inboundCookie);
        reportTraceRendered(inputCookie, resizeCookie, inboundCookie);
        return;
      }
      prepareLiveWrite();
      terminal.write(data, () => {
        offlineCache.markDirty();
        reportTracePhase('trace-xterm-written', inboundCookie);
        reportTraceRendered(inputCookie, resizeCookie, inboundCookie);
      });
    };
    window.herdrWriteBase64 = (data, inputCookie, resizeCookie, inboundCookie) => {
      reportTracePhase('trace-write-received', inboundCookie);
      if (renderDrop) {
        reportTracePhase('trace-xterm-written', inboundCookie);
        reportTraceRendered(inputCookie, resizeCookie, inboundCookie);
        return;
      }
      prepareLiveWrite();
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      terminal.write(bytes, () => {
        offlineCache.markDirty();
        reportTracePhase('trace-xterm-written', inboundCookie);
        reportTraceRendered(inputCookie, resizeCookie, inboundCookie);
      });
    };
    const pendingFrames = new Map();
    window.herdrWriteBase64Chunk = (sequence, data, final, inputCookie, resizeCookie, inboundCookie) => {
      const pending = pendingFrames.get(sequence);
      const encoded = (pending?.encoded || '') + data;
      const pendingInputCookie = Number.isInteger(inputCookie)
        ? inputCookie
        : pending?.inputCookie;
      const pendingResizeCookie = Number.isInteger(resizeCookie)
        ? resizeCookie
        : pending?.resizeCookie;
      const pendingInboundCookie = Number.isInteger(inboundCookie)
        ? inboundCookie
        : pending?.inboundCookie;
      if (!final) {
        pendingFrames.set(sequence, {
          encoded,
          inputCookie: pendingInputCookie,
          resizeCookie: pendingResizeCookie,
          inboundCookie: pendingInboundCookie,
        });
        return;
      }
      pendingFrames.delete(sequence);
      window.herdrWriteBase64(encoded, pendingInputCookie, pendingResizeCookie, pendingInboundCookie);
    };
    window.herdrSetRenderDrop = enabled => { renderDrop = enabled === true; };
    window.herdrSnapshot = reason => offlineCache.snapshot(reason || 'lifecycle', true);
    window.herdrReset = () => {
      pendingFrames.clear();
      offlineTranscriptChunks = [];
      offlineTranscriptVisible = false;
      lastReportedOfflineScroll = '';
      clearOsc8Links();
      terminal.reset();
      clearInteractiveSelection(false);
    };
    window.herdrBeginOfflineTranscript = () => {
      offlineTranscriptChunks = [];
    };
    window.herdrAppendOfflineTranscript = data => {
      if (typeof data === 'string') offlineTranscriptChunks.push(data);
    };
    window.herdrCommitOfflineTranscript = offsetFromBottom => {
      const transcript = offlineTranscriptChunks.join('');
      offlineTranscriptChunks = [];
      if (!transcript) return;
      pendingFrames.clear();
      offlineTranscriptVisible = true;
      lastReportedOfflineScroll = '';
      clearOsc8Links();
      clearInteractiveSelection(false);
      terminal.write('\u001bc' + transcript, () => {
        const offset = Math.max(0, Math.round(Number(offsetFromBottom) || 0));
        terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - offset));
        reportOfflineScroll();
      });
    };
    window.herdrHideOfflineTranscript = () => {
      offlineTranscriptChunks = [];
      if (!offlineTranscriptVisible) return;
      offlineTranscriptVisible = false;
      lastReportedOfflineScroll = '';
      clearOsc8Links();
      clearInteractiveSelection(false);
      terminal.write('\u001bc');
    };
    window.herdrOfflineInput = data => handleOfflineInput(data);
    window.herdrConfigure = options => {
      terminal.options.fontSize = Math.max(8, Math.min(24, Number(options.fontSize) || 8));
      terminal.options.scrollback = Math.max(1000, Math.min(20000, Number(options.scrollback) || 5000));
      terminal.options.cursorBlink = options.cursorBlink !== false;
      doubleTapAction = ['none', 'paste', 'tab', 'escape'].includes(options.doubleTapAction) ? options.doubleTapAction : 'tab';
      const nextOfflineScrollback = options.offlineScrollback === true;
      if (offlineScrollback && !nextOfflineScrollback) terminal.scrollToBottom();
      if (!nextOfflineScrollback) lastReportedOfflineScroll = '';
      localScrollback = options.localScrollback === true;
      offlineScrollback = nextOfflineScrollback;
      offlineCache.configure({
        enabled: options.offlineCache === true,
        scrollback: options.scrollback,
      });
      if (doubleTapAction === 'none') lastTap = null;
      const backgroundUri = options.backgroundImageUri || '';
      const dimming = Math.max(0, Math.min(100, Number(options.backgroundDimming) || 0)) / 100;
      const backgroundLayer = document.getElementById('terminal-background-layer');
      const backgroundImage = document.getElementById('terminal-background-image');
      const backgroundGlass = document.getElementById('terminal-background-glass');
      backgroundLayer.style.display = backgroundUri ? 'block' : 'none';
      backgroundImage.src = backgroundUri;
      backgroundGlass.style.backgroundColor = 'rgba(0,0,0,' + dimming + ')';
      setTimeout(resize, 0);
    };
    window.herdrChangeFontSize = delta => {
      const fontSize = Math.max(8, Math.min(24, Math.round(terminal.options.fontSize + Number(delta))));
      if (fontSize === terminal.options.fontSize) return;
      terminal.options.fontSize = fontSize;
      resize();
      send({ type: 'font-size-change', fontSize });
    };
    const terminalMouseCaptured = () => terminal.modes.mouseTrackingMode !== 'none';
    const terminalMouseInputEnabled = () => forcedMouseInput || terminalMouseCaptured();
    const terminalMouseCell = point => {
      const screen = terminal.element?.querySelector('.xterm-screen');
      if (!screen) return null;
      const bounds = screen.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      const clientX = Number.isFinite(point?.clientX) ? point.clientX : bounds.left + bounds.width / 2;
      const clientY = Number.isFinite(point?.clientY) ? point.clientY : bounds.top + bounds.height / 2;
      return {
        col: Math.max(0, Math.min(terminal.cols - 1, Math.floor((clientX - bounds.left) / bounds.width * terminal.cols))),
        row: Math.max(0, Math.min(terminal.rows - 1, Math.floor((clientY - bounds.top) / bounds.height * terminal.rows))),
      };
    };
    window.herdrSetForcedMouseInput = enabled => {
      forcedMouseInput = enabled === true;
    };
    const dispatchTerminalMouse = (action, point) => {
      if (offlineScrollback || !terminalMouseCaptured() || !terminal.element) return false;
      const eventType = action === 'down' ? 'mousedown' : action === 'move' ? 'mousemove' : 'mouseup';
      terminal.element.dispatchEvent(new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: action === 'up' ? 0 : 1,
        clientX: point.clientX,
        clientY: point.clientY,
      }));
      return true;
    };
    const dispatchTerminalClick = point => {
      if (forcedMouseInput) {
        const cell = terminalMouseCell(point);
        if (!cell) return false;
        send({
          type: 'input',
          data: terminalMouseClickInput(cell.col, cell.row),
        });
        return true;
      }
      if (!dispatchTerminalMouse('down', point)) return false;
      dispatchTerminalMouse('up', point);
      if (!keyboardEnabled) terminal.blur();
      return true;
    };
    const dispatchTerminalWheel = (direction, count, point) => {
      if (forcedMouseInput) {
        const cell = terminalMouseCell(point);
        if (!cell) return false;
        send({
          type: 'input',
          data: terminalMouseWheelInput(direction, count, cell.col, cell.row),
        });
        return true;
      }
      if (!terminal.element) return false;
      if (terminal.buffer.active.type !== 'alternate' && terminal.modes.mouseTrackingMode === 'none') return false;
      const bounds = terminal.element.getBoundingClientRect();
      const clientX = Number.isFinite(point?.clientX) ? point.clientX : bounds.left + bounds.width / 2;
      const clientY = Number.isFinite(point?.clientY) ? point.clientY : bounds.top + bounds.height / 2;
      const deltaY = direction === 'up' ? -1 : 1;
      for (let index = 0; index < count; index += 1) {
        terminal.element.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY,
        }));
      }
      return true;
    };
    const terminalCellHeight = () => {
      const screen = terminal.element?.querySelector('.xterm-screen');
      return Math.max(1, screen
        ? screen.getBoundingClientRect().height / Math.max(1, terminal.rows)
        : window.innerHeight / Math.max(1, terminal.rows));
    };
    const scrollTerminalPixels = (gestureDeltaPx, point) => {
      const local = offlineScrollInfo();
      const hasRemoteScroll = Number.isFinite(remoteVisualScrollOffset)
        && Number.isFinite(remoteVisualScrollMaximum);
      terminalBoundaryScrollState = reconcileTerminalBoundaryScroll({
        state: terminalBoundaryScrollState,
        offsetFromBottom: hasRemoteScroll ? remoteVisualScrollOffset : local.offsetFromBottom,
        maxOffsetFromBottom: hasRemoteScroll ? remoteVisualScrollMaximum : local.maxOffsetFromBottom,
        topAllowancePx: finiteInset(terminalVisualInsets.top),
        bottomAllowancePx: Math.max(
          0,
          finiteInset(terminalVisualInsets.bottom)
            - finiteInset(terminalVisualInsets.geometryBottomInset),
        ),
        alternateScreen: false,
      });
      const result = terminalBoundaryScroll({
        state: terminalBoundaryScrollState,
        gestureDeltaPx,
        cellHeightPx: terminalCellHeight(),
        topAllowancePx: finiteInset(terminalVisualInsets.top),
        bottomAllowancePx: Math.max(
          0,
          finiteInset(terminalVisualInsets.bottom)
            - finiteInset(terminalVisualInsets.geometryBottomInset),
        ),
        alternateScreen: false,
      });
      terminalBoundaryScrollState = result;
      const rowDelta = result.rowScrollDelta;
      if (rowDelta !== 0) {
        if (offlineScrollback || localScrollback) {
          terminal.scrollLines(-rowDelta);
        } else {
          remoteVisualScrollOffset = result.offsetFromBottom;
          remoteVisualPendingDelta += rowDelta;
          const cell = terminalMouseCell(point);
          send({
            type: 'scroll',
            direction: rowDelta > 0 ? 'up' : 'down',
            lines: Math.abs(rowDelta),
            column: cell?.col,
            row: cell?.row,
          });
        }
      }
      applyTerminalVisualInsets();
    };
    const scrollTerminal = (direction, lines, point) => {
      const count = Math.max(1, Math.round(Number(lines) || 1));
      if (dispatchTerminalWheel(direction, count, point)) return;
      scrollTerminalPixels(
        (direction === 'up' ? 1 : -1) * count * terminalCellHeight(),
        point,
      );
    };
    window.herdrScroll = (direction, lines) => scrollTerminal(direction, lines);
    window.herdrScrollToVisualBottom = () => {
      const alternateScreen = terminalVisualInsets.alternateScreen
        || terminal.buffer.active.type === 'alternate';
      if (alternateScreen) {
        applyTerminalVisualInsets();
        return;
      }
      terminal.scrollToBottom();
      const local = offlineScrollInfo();
      const hasRemoteScroll = Number.isFinite(remoteVisualScrollOffset)
        && Number.isFinite(remoteVisualScrollMaximum);
      if (hasRemoteScroll) {
        remoteVisualScrollOffset = 0;
        remoteVisualPendingDelta = -Math.max(0, Number(remoteVisualInputOffset) || 0);
      }
      terminalBoundaryScrollState = terminalBoundaryScrollToVisualBottom({
        state: {
          ...terminalBoundaryScrollState,
          offsetFromBottom: 0,
          maxOffsetFromBottom: hasRemoteScroll
            ? remoteVisualScrollMaximum
            : local.maxOffsetFromBottom,
        },
        bottomAllowancePx: Math.max(
          0,
          finiteInset(terminalVisualInsets.bottom)
            - finiteInset(terminalVisualInsets.geometryBottomInset),
        ),
      });
      applyTerminalVisualInsets();
      reportOfflineScroll();
    };
    window.herdrPaste = data => { pasteBridge.paste(data); hideToolbar(); };
    window.herdrSubmitPastes = parts => {
      const values = [];
      for (const part of Array.isArray(parts) ? parts : []) {
        if (typeof part !== 'string' || !part) continue;
        bufferedInput = '';
        pasteBridge.paste(part);
        values.push(bufferedInput);
      }
      bufferedInput = null;
      send({ type: 'buffered-submit', parts: values });
      hideToolbar();
    };
    let searchState = { query: '', caseSensitive: false, regex: false, matches: [], index: -1 };
    window.herdrClearSearch = () => { clearInteractiveSelection(true); searchState = { query: '', caseSensitive: false, regex: false, matches: [], index: -1 }; };
    window.herdrSearch = (query, caseSensitive, regex, direction) => {
      clearInteractiveSelection(false);
      const changed = query !== searchState.query || caseSensitive !== searchState.caseSensitive || regex !== searchState.regex;
      if (changed) {
        const matches = [];
        let invalid = false;
        let expression = null;
        if (query && regex) {
          try { expression = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch { invalid = true; }
        }
        if (query && !invalid) {
          for (let row = 0; row < terminal.buffer.active.length; row += 1) {
            const line = terminal.buffer.active.getLine(row)?.translateToString(true) || '';
            if (expression) {
              expression.lastIndex = 0;
              let match;
              while ((match = expression.exec(line))) {
                matches.push({ row, col: match.index, length: Math.max(1, match[0].length) });
                if (match[0].length === 0) expression.lastIndex += 1;
              }
            } else {
              const source = caseSensitive ? line : line.toLowerCase();
              const needle = caseSensitive ? query : query.toLowerCase();
              let col = source.indexOf(needle);
              while (col >= 0) {
                matches.push({ row, col, length: query.length });
                col = source.indexOf(needle, col + Math.max(1, query.length));
              }
            }
          }
        }
        searchState = { query, caseSensitive, regex, matches, index: matches.length ? (direction < 0 ? matches.length - 1 : 0) : -1 };
        if (invalid) { send({ type: 'search-result', count: 0, index: -1, invalid: true }); return; }
      } else if (searchState.matches.length) {
        searchState.index = (searchState.index + direction + searchState.matches.length) % searchState.matches.length;
      }
      const match = searchState.matches[searchState.index];
      if (match) {
        terminal.select(match.col, match.row, match.length);
        terminal.scrollToLine(match.row);
      } else {
        terminal.clearSelection();
      }
      send({ type: 'search-result', count: searchState.matches.length, index: searchState.index, invalid: false });
    };
    ${trimTerminalUrl.toString()}
    ${terminalLinkCandidates.toString()}
    ${extractTerminalLinks.toString()}
    ${mergeTerminalLinks.toString()}
    ${osc8LinkAt.toString()}
    ${terminalLinkAt.toString()}
    const terminalRows = () => {
      const rows = [];
      for (let row = 0; row < terminal.buffer.active.length; row += 1) {
        const bufferLine = terminal.buffer.active.getLine(row);
        if (!bufferLine) continue;
        rows.push({
          text: bufferLine.translateToString(false),
          isWrapped: bufferLine.isWrapped,
        });
      }
      return rows;
    };
    window.herdrScanLinks = () => {
      send({
        type: 'link-scan-result',
        links: mergeTerminalLinks(terminalRows(), terminal.cols, osc8Links),
      });
    };
    let lastFitGeometry = null;
    const measureEffectiveTerminalGeometry = () => {
      const element = terminal.element;
      const parent = element?.parentElement;
      const cell = terminal.dimensions?.css.cell;
      if (!parent || !cell || cell.width <= 0 || cell.height <= 0) return null;
      const view = element.ownerDocument.defaultView || window;
      const parentStyle = view.getComputedStyle(parent);
      const elementStyle = view.getComputedStyle(element);
      // Match FitAddon.proposeDimensions: integer computed CSS pixels, not
      // transformed bounding rectangles or the WebView's window dimensions.
      const pixels = (style, property) => parseInt(style.getPropertyValue(property), 10) || 0;
      const width = Math.max(0, pixels(parentStyle, 'width'));
      const height = Math.max(0, pixels(parentStyle, 'height'));
      if (!width || !height) return null;
      const proposed = fit.proposeDimensions();
      if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null;
      return {
        ...proposed,
        signature: [
          width - pixels(elementStyle, 'padding-left') - pixels(elementStyle, 'padding-right'),
          height - pixels(elementStyle, 'padding-top') - pixels(elementStyle, 'padding-bottom'),
          cell.width, cell.height, view.devicePixelRatio || 1, terminal.options.fontSize,
          proposed.cols, proposed.rows,
        ].join(':'),
      };
    };
    const resize = (geometry = measureEffectiveTerminalGeometry()) => {
      if (geometry && geometry.signature === lastFitGeometry
        && terminal.cols === geometry.cols && terminal.rows === geometry.rows) {
        // Foreground scroll restoration still needs to know fitting settled.
        send({ type: 'fit-complete' });
        return;
      }
      const fitStartedAt = performance.now();
      lastFitGeometry = null;
      fitResizeInProgress = true;
      try {
        fit.fit();
        // FitAddon can return without fitting when cell measurements are not
        // ready. Only remember geometry that was successfully applied.
        if (geometry && terminal.cols === geometry.cols && terminal.rows === geometry.rows) {
          lastFitGeometry = geometry.signature;
        }
      } finally {
        fitResizeInProgress = false;
      }
      const screen = terminal.element?.querySelector('.xterm-screen');
      const rect = screen?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      send({
        type: 'resize',
        source: 'fit',
        cols: terminal.cols,
        rows: terminal.rows,
        cellWidthPx: rect ? Math.round((rect.width / terminal.cols) * scale) : 0,
        cellHeightPx: rect ? Math.round((rect.height / terminal.rows) * scale) : 0,
        localFitMs: performance.now() - fitStartedAt,
        requestedAtEpochMs: Date.now()
      });
      renderSelectionHandles();
    };
    window.herdrFocus = () => {
      if (keyboardEnabled) terminal.focus();
    };
    window.herdrBlur = () => terminal.blur();
    window.herdrSetKeyboardEnabled = enabled => {
      keyboardEnabled = setTerminalKeyboardInputEnabled(terminal, enabled);
      clearInteractiveSelection(true);
    };
    window.herdrFit = resize;
    const toolbar = document.getElementById('selection-toolbar');
    const hideToolbar = () => { toolbar.style.display = 'none'; };
    const showToolbar = (x, y) => {
      toolbar.style.display = 'flex';
      const width = toolbar.offsetWidth || 196;
      const height = toolbar.offsetHeight || 42;
      toolbar.style.left = Math.max(6, Math.min(window.innerWidth - width - 6, x - width / 2)) + 'px';
      toolbar.style.top = Math.max(6, Math.min(window.innerHeight - height - 6, y - height - 8)) + 'px';
    };
    document.getElementById('copy-selection').addEventListener('click', event => {
      event.stopPropagation();
      const text = terminal.getSelection();
      if (text) send({ type: 'clipboard-write', text });
      clearInteractiveSelection(true);
    });
    document.getElementById('paste-selection').addEventListener('click', event => {
      event.stopPropagation();
      send({ type: 'clipboard-read' });
      clearInteractiveSelection(true);
    });
    const bufferCellAt = (x, y) => {
      const screen = terminal.element?.querySelector('.xterm-screen');
      const rect = screen?.getBoundingClientRect();
      if (!rect) return null;
      const col = Math.max(0, Math.min(terminal.cols - 1, Math.floor((x - rect.left) / (rect.width / terminal.cols))));
      const viewportRow = Math.max(0, Math.min(terminal.rows - 1, Math.floor((y - rect.top) / (rect.height / terminal.rows))));
      const row = terminal.buffer.active.viewportY + viewportRow;
      return { col, row };
    };
    const startHandle = document.getElementById('selection-start-handle');
    const endHandle = document.getElementById('selection-end-handle');
    let activeSelection = null;
    let selectionHandleDrag = null;
    const cellIndex = point => point.row * terminal.cols + point.col;
    const normalizedSelection = selection => cellIndex(selection.anchor) <= cellIndex(selection.focus)
      ? { start: selection.anchor, end: selection.focus }
      : { start: selection.focus, end: selection.anchor };
    const hideSelectionHandles = () => {
      startHandle.style.display = 'none';
      endHandle.style.display = 'none';
      startHandle.classList.remove('dragging');
      endHandle.classList.remove('dragging');
    };
    const positionSelectionHandle = (handle, cell, edge) => {
      const screen = terminal.element?.querySelector('.xterm-screen');
      const rect = screen?.getBoundingClientRect();
      if (!rect || !terminal.cols || !terminal.rows) { handle.style.display = 'none'; return; }
      const viewportRow = cell.row - terminal.buffer.active.viewportY;
      if (viewportRow < 0 || viewportRow >= terminal.rows) { handle.style.display = 'none'; return; }
      const cellWidth = rect.width / terminal.cols;
      const cellHeight = rect.height / terminal.rows;
      handle.style.left = rect.left + (cell.col + (edge === 'end' ? 1 : 0)) * cellWidth + 'px';
      handle.style.top = rect.top + (viewportRow + 1) * cellHeight + 'px';
      handle.style.display = 'block';
    };
    const renderSelectionHandles = drag => {
      if (!activeSelection) { hideSelectionHandles(); return; }
      const { start, end } = normalizedSelection(activeSelection);
      if (drag) {
        positionSelectionHandle(drag.movingHandle, drag.movingEdge === 'start' ? start : end, drag.movingEdge);
        positionSelectionHandle(drag.fixedHandle, drag.movingEdge === 'start' ? end : start, drag.movingEdge === 'start' ? 'end' : 'start');
        return;
      }
      positionSelectionHandle(startHandle, start, 'start');
      positionSelectionHandle(endHandle, end, 'end');
    };
    const setInteractiveSelection = (anchor, focus, drag) => {
      activeSelection = { anchor, focus };
      const { start, end } = normalizedSelection(activeSelection);
      terminal.select(start.col, start.row, Math.max(1, cellIndex(end) - cellIndex(start) + 1));
      renderSelectionHandles(drag);
    };
    const clearInteractiveSelection = clearTerminalSelection => {
      activeSelection = null;
      selectionHandleDrag = null;
      hideSelectionHandles();
      hideToolbar();
      if (clearTerminalSelection) terminal.clearSelection();
    };
    document.getElementById('select-all-selection').addEventListener('click', event => {
      event.stopPropagation();
      terminal.selectAll();
      activeSelection = {
        anchor: { col: 0, row: 0 },
        focus: {
          col: Math.max(0, terminal.cols - 1),
          row: Math.max(0, terminal.buffer.active.length - 1),
        },
      };
      renderSelectionHandles();
      const rect = toolbar.getBoundingClientRect();
      showToolbar(rect.left + rect.width / 2, rect.bottom + 8);
    });
    const handleCellAt = touchPoint => bufferCellAt(touchPoint.clientX, touchPoint.clientY - 14);
    const installSelectionHandle = (handle, edge) => {
      handle.addEventListener('touchstart', event => {
        if (!activeSelection || event.touches.length !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        const selection = normalizedSelection(activeSelection);
        selectionHandleDrag = {
          movingHandle: handle,
          fixedHandle: handle === startHandle ? endHandle : startHandle,
          fixed: edge === 'start' ? selection.end : selection.start,
        };
        handle.classList.add('dragging');
        hideToolbar();
      }, { capture: true, passive: false });
      handle.addEventListener('touchmove', event => {
        if (!selectionHandleDrag || event.touches.length !== 1) return;
        event.preventDefault();
        event.stopPropagation();
        const cell = handleCellAt(event.touches[0]);
        if (!cell) return;
        const movingEdge = cellIndex(cell) <= cellIndex(selectionHandleDrag.fixed) ? 'start' : 'end';
        setInteractiveSelection(selectionHandleDrag.fixed, cell, { ...selectionHandleDrag, movingEdge });
      }, { capture: true, passive: false });
      const finishHandleDrag = event => {
        if (!selectionHandleDrag) return;
        event.preventDefault();
        event.stopPropagation();
        handle.classList.remove('dragging');
        selectionHandleDrag = null;
        renderSelectionHandles();
        const point = event.changedTouches?.[0];
        if (point) showToolbar(point.clientX, point.clientY);
      };
      handle.addEventListener('touchend', finishHandleDrag, { capture: true, passive: false });
      handle.addEventListener('touchcancel', finishHandleDrag, { capture: true, passive: false });
    };
    installSelectionHandle(startHandle, 'start');
    installSelectionHandle(endHandle, 'end');
    terminal.onScroll(() => {
      renderSelectionHandles();
      reportOfflineScroll();
      applyTerminalVisualInsets();
    });
    terminal.buffer.onBufferChange(buffer => {
      clearInteractiveSelection(true);
      searchState = { query: '', caseSensitive: false, regex: false, matches: [], index: -1 };
      applyTerminalVisualInsets();
      send({ type: 'buffer-mode', alternate: buffer.type === 'alternate' });
    });
    send({ type: 'buffer-mode', alternate: terminal.buffer.active.type === 'alternate' });
    const wordRangeAt = (x, y) => {
      const cell = bufferCellAt(x, y);
      if (!cell) return null;
      const { col, row } = cell;
      const line = terminal.buffer.active.getLine(row)?.translateToString(true) || '';
      if (!line[col] || /\\s/.test(line[col])) return null;
      const wordChar = character => character && /[A-Za-z0-9_./:@~+-]/.test(character);
      let start = col;
      let end = col + 1;
      while (start > 0 && wordChar(line[start - 1])) start -= 1;
      while (end < line.length && wordChar(line[end])) end += 1;
      terminal.select(start, row, Math.max(1, end - start));
      return {
        start: { col: start, row },
        end: { col: Math.max(start, end - 1), row },
      };
    };
    const selectRangeTo = (selection, cell) => {
      const indexOf = point => point.row * terminal.cols + point.col;
      const beforeWord = indexOf(cell) < indexOf(selection.start);
      const start = beforeWord ? cell : selection.start;
      const end = beforeWord ? selection.end : cell;
      terminal.select(start.col, start.row, Math.max(1, indexOf(end) - indexOf(start) + 1));
      activeSelection = { anchor: start, focus: end };
      renderSelectionHandles();
    };
    const urlAtPoint = (x, y) => {
      const cell = bufferCellAt(x, y);
      if (!cell) return null;
      return osc8LinkAt(osc8Links, cell.row, cell.col)
        || terminalLinkAt(terminalRows(), terminal.cols, cell.row, cell.col);
    };
    let touch = null;
    let pinch = null;
    let longPressTimer = null;
    const doubleTapTimeoutMs = 300;
    const doubleTapDistancePx = 24;
    const touchDistance = touches => Math.hypot(
      touches[1].clientX - touches[0].clientX,
      touches[1].clientY - touches[0].clientY,
    );
    document.getElementById('terminal').addEventListener('touchstart', event => {
      if (event.target.closest?.('#selection-toolbar')) return;
      if (keyboardEnabled && event.touches.length === 1) terminal.focus();
      if (!keyboardEnabled) {
        event.preventDefault();
        event.stopPropagation();
        terminal.blur();
      }
      if (event.touches.length === 2) {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        event.preventDefault();
        event.stopPropagation();
        clearInteractiveSelection(true);
        touch = null;
        lastTap = null;
        pinch = {
          distance: Math.max(1, touchDistance(event.touches)),
          initialFontSize: terminal.options.fontSize,
          fontSize: terminal.options.fontSize,
        };
        return;
      }
      if (event.touches.length !== 1) { touch = null; pinch = null; lastTap = null; return; }
      const point = event.touches[0];
      clearInteractiveSelection(true);
      terminalBoundaryScrollState = {
        ...terminalBoundaryScrollState,
        rowRemainderPx: 0,
      };
      touch = { x: point.clientX, y: point.clientY, lastY: point.clientY, moved: false, longPressed: false, selection: null };
      longPressTimer = setTimeout(() => {
        if (!touch || touch.moved) return;
        if (terminalMouseCaptured() && keyboardEnabled) {
          touch.longPressed = true;
          touch.mouseDragging = dispatchTerminalMouse('down', { clientX: touch.x, clientY: touch.y });
          lastTap = null;
          return;
        }
        let selection = wordRangeAt(touch.x, touch.y);
        if (!selection && !keyboardEnabled) {
          const cell = bufferCellAt(touch.x, touch.y);
          if (cell) {
            selection = { start: cell, end: cell };
            terminal.select(cell.col, cell.row, 1);
          }
        }
        if (selection) {
          touch.longPressed = true;
          lastTap = null;
          touch.selection = selection;
          setInteractiveSelection(selection.start, selection.end);
          showToolbar(touch.x, touch.y);
        }
      }, 420);
    }, { capture: true, passive: false });
    document.getElementById('terminal').addEventListener('touchmove', event => {
      if (pinch && event.touches.length === 2) {
        event.preventDefault();
        event.stopPropagation();
        const ratio = touchDistance(event.touches) / pinch.distance;
        const fontSize = Math.max(8, Math.min(24, Math.round(pinch.initialFontSize * ratio)));
        if (fontSize !== pinch.fontSize) {
          pinch.fontSize = fontSize;
          terminal.options.fontSize = fontSize;
          resize();
        }
        return;
      }
      if (pinch) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!touch || event.touches.length !== 1) return;
      const point = event.touches[0];
      if (touch.mouseDragging) {
        event.preventDefault();
        event.stopPropagation();
        dispatchTerminalMouse('move', point);
        touch.lastX = point.clientX;
        touch.lastY = point.clientY;
        touch.moved = true;
        return;
      }
      if (touch.longPressed && !keyboardEnabled) {
        event.preventDefault();
        event.stopPropagation();
        const cell = bufferCellAt(point.clientX, point.clientY);
        if (cell && touch.selection) selectRangeTo(touch.selection, cell);
        touch.moved = true;
        hideToolbar();
        return;
      }
      if (!touch.moved && Math.hypot(point.clientX - touch.x, point.clientY - touch.y) < 10) return;
      touch.moved = true;
      lastTap = null;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      event.preventDefault();
      event.stopPropagation();
      const deltaPx = point.clientY - touch.lastY;
      touch.lastY = point.clientY;
      scrollTerminalPixels(deltaPx, point);
    }, { capture: true, passive: false });
    document.getElementById('terminal').addEventListener('touchend', event => {
      if (pinch) {
        event.preventDefault();
        event.stopPropagation();
        if (event.touches.length < 2) {
          const fontSize = pinch.fontSize;
          pinch = null;
          terminal.options.fontSize = fontSize;
          resize();
          send({ type: 'font-size-change', fontSize });
        }
        return;
      }
      if (!touch) return;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      const point = event.changedTouches[0];
      if (touch.mouseDragging) {
        event.preventDefault();
        event.stopPropagation();
        if (point) dispatchTerminalMouse('up', point);
        touch = null;
        return;
      }
      if (touch.longPressed) {
        event.preventDefault();
        event.stopPropagation();
        if (!keyboardEnabled && point) showToolbar(point.clientX, point.clientY);
      }
      if (!touch.moved && !touch.longPressed && point && !keyboardEnabled) {
        event.preventDefault();
        event.stopPropagation();
        handleKeyboardClosedStationaryTap({
          point,
          urlAtPoint,
          terminalMouseInputEnabled,
          dispatchTerminalClick,
          send,
          clearInteractiveSelection,
        });
        lastTap = null;
        touch = null;
        return;
      }
      if (!touch.moved && !touch.longPressed && point) {
        terminal.focus();
        const now = { time: Date.now(), x: point.clientX, y: point.clientY };
        if (doubleTapAction !== 'none' && lastTap && now.time - lastTap.time <= doubleTapTimeoutMs && Math.hypot(now.x - lastTap.x, now.y - lastTap.y) <= doubleTapDistancePx) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (doubleTapAction === 'paste') send({ type: 'clipboard-read' });
          else send({ type: 'input', data: doubleTapAction === 'escape' ? '\\u001b' : '\\t' });
          lastTap = null;
        } else {
          lastTap = doubleTapAction === 'none' ? null : now;
        }
      }
      touch = null;
    }, { capture: true, passive: false });
    document.getElementById('terminal').addEventListener('touchcancel', () => {
      if (touch?.mouseDragging) {
        dispatchTerminalMouse('up', {
          clientX: touch.lastX ?? touch.x,
          clientY: touch.lastY ?? touch.y,
        });
      }
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = null;
      touch = null;
      pinch = null;
      lastTap = null;
    }, { capture: true });
    const terminalSessionRoot = () => document.getElementById('terminal')?.closest('.terminal-session');
    const terminalIsPresented = () => {
      const sessionRoot = terminalSessionRoot();
      return !sessionRoot || sessionRoot.classList.contains('presented');
    };
    const resizePresentedTerminal = () => {
      if (!terminalIsPresented()) return;
      const geometry = measureEffectiveTerminalGeometry();
      if (!geometry || geometry.signature === lastFitGeometry) return;
      resize(geometry);
    };
    const usesNativeWindowImeResize = /Android/i.test(navigator.userAgent);
    window.addEventListener('resize', resizePresentedTerminal);
    if (!usesNativeWindowImeResize) {
      window.visualViewport?.addEventListener('resize', resizePresentedTerminal);
      window.visualViewport?.addEventListener('scroll', resizePresentedTerminal);
    }
    let readySent = false;
    const announceReady = () => {
      resize();
      if (!readySent) {
        readySent = true;
        send({ type: 'ready' });
      }
    };
      announceReady();
    };
    Promise.race([
      fontReady.then(() => undefined, () => undefined),
      new Promise(resolve => setTimeout(resolve, 1500)),
    ]).then(initializeTerminal);
  </script>
</body>
</html>`;

const terminalSessionStyle = terminalSessionHtml
  .match(/<style>\n([\s\S]*?)\n  <\/style>/)?.[1]
  ?.replace(
    'html, body, #terminal-geometry, #terminal {',
    'html, body, #terminals, .terminal-session #terminal-geometry, .terminal-session #terminal {',
  );
const terminalSessionMarkup = terminalSessionHtml
  .match(/<body>\n([\s\S]*?)\n  <script src="xterm.js">/)?.[1];
const terminalSessionScript = terminalSessionHtml
  .match(/  <script>\n([\s\S]*?)\n  <\/script>\n<\/body>/)?.[1]
  ?.replace(
    'const initializeTerminal = () => {',
    'const initializeTerminal = () => {\n      if (disposed) return;',
  )
  .replace(
    "const send = value => window.parent.postMessage({ herdrTerminalMessage: value }, '*');",
    'const send = value => report(value);',
  )
  .replaceAll("document.getElementById('", "root.querySelector('#")
  .replaceAll('window.herdr', 'api.herdr')
  .replace(
    "    window.visualViewport?.addEventListener('scroll', resizePresentedTerminal);\n    }",
    `    window.visualViewport?.addEventListener('scroll', resizePresentedTerminal);
    }
    api.herdrDispose = () => {
      disposed = true;
      offlineCache.dispose();
      pasteBridge.dispose();
      disposeAndroidImeBridge();
      window.removeEventListener('resize', resizePresentedTerminal);
      if (!usesNativeWindowImeResize) {
        window.visualViewport?.removeEventListener('resize', resizePresentedTerminal);
        window.visualViewport?.removeEventListener('scroll', resizePresentedTerminal);
      }
      terminal.dispose();
    };`,
  );

if (!terminalSessionStyle || !terminalSessionMarkup || !terminalSessionScript) {
  throw new Error('Failed to extract the multiplexed terminal document');
}

const terminalHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <base href="file:///android_asset/">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <link rel="stylesheet" href="xterm.css">
  <style>
    ${terminalSessionStyle}
    #terminals { position: relative; width: 100%; height: 100%; }
    .terminal-session {
      position: absolute;
      inset: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateX(0);
    }
    .terminal-session #terminal-geometry {
      height: calc(100% - var(--terminal-geometry-bottom, 0px));
    }
    .terminal-session.presented {
      visibility: visible;
      pointer-events: auto;
    }
  </style>
</head>
<body>
  <div id="terminals"></div>
  <script src="xterm.js"></script>
  <script src="addon-fit.js"></script>
  <script src="addon-image.js"></script>
  <script src="addon-serialize.js"></script>
  <script>
    const terminalMarkup = ${JSON.stringify(terminalSessionMarkup).replaceAll('<', '\\u003c')};
    const createTerminalSession = (root, report) => {
      let disposed = false;
      const api = {
        herdrDispose: () => { disposed = true; },
      };
      ${terminalSessionScript}
      return api;
    };

    const terminals = new Map();
    let activeKey = null;
    const send = value => window.ReactNativeWebView.postMessage(JSON.stringify(value));
    const call = (key, method, args = []) => {
      const entry = terminals.get(key);
      if (!entry) return;
      if (!entry.ready) {
        entry.pending.push([method, args]);
        return;
      }
      entry.api[method]?.(...args);
    };
    const flushInput = entry => {
      entry.inputTimer = null;
      const data = entry.pendingInput;
      entry.pendingInput = '';
      if (data) send({ type: 'input', data, key: entry.key });
    };
    const receive = (entry, value) => {
      if (!value || typeof value.type !== 'string') return;
      if (value.type === 'ready') {
        entry.ready = true;
        const pending = entry.pending;
        entry.pending = [];
        for (const [method, args] of pending) call(entry.key, method, args);
        send({ type: 'terminal-ready', key: entry.key });
        if (entry.key === activeKey) call(entry.key, 'herdrFit');
        return;
      }
      if (value.type === 'input' && typeof value.data === 'string') {
        if (value.kind === 'paste') {
          if (entry.inputTimer !== null) {
            clearTimeout(entry.inputTimer);
            flushInput(entry);
          }
          send({ type: 'input', data: value.data, kind: 'paste', key: entry.key });
          return;
        }
        entry.pendingInput += value.data;
        if (entry.inputTimer === null) {
          entry.inputTimer = setTimeout(() => flushInput(entry), 4);
        }
        return;
      }
      send({ ...value, key: entry.key });
    };
    const create = key => {
      if (!key || terminals.has(key)) return terminals.get(key);
      const root = document.createElement('div');
      root.className = 'terminal-session';
      root.innerHTML = terminalMarkup;
      const entry = {
        key,
        root,
        api: null,
        ready: false,
        pending: [],
        pendingInput: '',
        inputTimer: null,
      };
      terminals.set(key, entry);
      document.getElementById('terminals').appendChild(root);
      entry.api = createTerminalSession(root, value => receive(entry, value));
      return entry;
    };
    const present = keys => {
      const presented = new Set(keys.filter(Boolean));
      for (const entry of terminals.values()) {
        const visible = presented.has(entry.key);
        entry.root.classList.toggle('presented', visible);
        if (!visible) {
          entry.root.style.transform = 'translateX(0)';
          call(entry.key, 'herdrBlur');
        }
      }
    };

    window.herdrCreate = key => { create(key); };
    window.herdrRemove = key => {
      const entry = terminals.get(key);
      if (!entry) return;
      if (entry.inputTimer !== null) {
        clearTimeout(entry.inputTimer);
        flushInput(entry);
      }
      entry.api.herdrDispose?.();
      entry.root.remove();
      terminals.delete(key);
      if (activeKey === key) activeKey = null;
    };
    window.herdrActivate = key => {
      const entry = create(key);
      activeKey = key || null;
      present(key ? [key] : []);
      if (entry) {
        entry.root.style.transform = 'translateX(0)';
        call(key, 'herdrFit');
      }
    };
    window.herdrWriteBase64Chunk = (key, sequence, data, final, inputCookie, resizeCookie, inboundCookie) => call(key, 'herdrWriteBase64Chunk', [sequence, data, final, inputCookie, resizeCookie, inboundCookie]);
    window.herdrWrite = (key, data, inputCookie, resizeCookie, inboundCookie) => call(key, 'herdrWrite', [data, inputCookie, resizeCookie, inboundCookie]);
    window.herdrReset = key => call(key, 'herdrReset');
    window.herdrBeginOfflineTranscript = key => call(key, 'herdrBeginOfflineTranscript');
    window.herdrAppendOfflineTranscript = (key, data) => call(key, 'herdrAppendOfflineTranscript', [data]);
    window.herdrCommitOfflineTranscript = (key, offsetFromBottom) => call(key, 'herdrCommitOfflineTranscript', [offsetFromBottom]);
    window.herdrHideOfflineTranscript = key => call(key, 'herdrHideOfflineTranscript');
    window.herdrOfflineInput = (key, data) => call(key, 'herdrOfflineInput', [data]);
    window.herdrConfigure = (key, options) => call(key, 'herdrConfigure', [options]);
    window.herdrSetVisualInsets = (key, options) => {
      const entry = create(key);
      if (!entry) return;
      call(key, 'herdrSetVisualInsets', [options]);
    };
    window.herdrChangeFontSize = (key, delta) => call(key, 'herdrChangeFontSize', [delta]);
    window.herdrScroll = (key, direction, lines) => call(key, 'herdrScroll', [direction, lines]);
    window.herdrScrollToVisualBottom = key => call(key, 'herdrScrollToVisualBottom');
    window.herdrPaste = (key, data) => call(key, 'herdrPaste', [data]);
    window.herdrSubmitPastes = (key, parts) => call(key, 'herdrSubmitPastes', [parts]);
    window.herdrClearSearch = key => call(key, 'herdrClearSearch');
    window.herdrSearch = (key, query, caseSensitive, regex, direction) => call(key, 'herdrSearch', [query, caseSensitive, regex, direction]);
    window.herdrScanLinks = key => call(key, 'herdrScanLinks');
    window.herdrFocus = key => call(key, 'herdrFocus');
    window.herdrBlur = key => call(key, 'herdrBlur');
    window.herdrSetKeyboardEnabled = (key, enabled) => call(key, 'herdrSetKeyboardEnabled', [enabled]);
    window.herdrSetForcedMouseInput = (key, enabled) => call(key, 'herdrSetForcedMouseInput', [enabled]);
    window.herdrSetRenderDrop = (key, enabled) => call(key, 'herdrSetRenderDrop', [enabled]);
    window.herdrSnapshot = (key, reason) => call(key, 'herdrSnapshot', [reason]);
    window.herdrFit = key => call(key, 'herdrFit');

    send({ type: 'ready' });
  </script>
</body>
</html>`;

await writeFile(resolve(assets, 'herdr-terminal.html'), terminalHtml, 'utf8');
const iosTerminalHtml = terminalHtml
  .replace('  <base href="file:///android_asset/">\n', '')
  .replace(
    `const terminalFontFamily = '${androidTerminalFontFamily}';`,
    `const terminalFontFamily = '${iosTerminalFontFamily}';`,
  );
await writeFile(
  resolve(iosAssets, 'index.html'),
  iosTerminalHtml,
  'utf8',
);
