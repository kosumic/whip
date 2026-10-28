/* Standalone Release benchmark entry. Config is an ignored, ephemeral fixture file. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { registerRootComponent } from 'expo';
import { View, Text, NativeModules, PixelRatio } from 'react-native';
import { createHostRuntime, setKnownHosts } from 'react-native-whip-ssh';
import { TerminalRendererHost } from '../../src/components/TerminalRenderer';
import { TerminalBridgeController } from '../../src/services/TerminalBridgeController';
import { defaultDevicePreferences } from '../../src/services/devicePreferences';
import config from '../../.codex-skia-live-config.json';
import { hasCompletionMarker } from './completion.cjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const noop = () => {};
const post = event => fetch('http://127.0.0.1:22393/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timeMs: Date.now(), ...event }) });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function Benchmark() {
  const renderer = useRef(null);
  const live = useRef({ mode: 'xterm.js', run: -1, phase: '', samples: [], input: [], pendingInput: null, lastFrame: 0, attachAt: 0, first: false, geometry: null });
  const [target, setTarget] = useState(null);
  const [mode, setMode] = useState('xterm.js');
  const [run, setRun] = useState(-1);
  const [visible, setVisible] = useState(true);
  const [size, setSize] = useState({ width: 400, height: 300 });
  const measuredSize = useRef(size);
  measuredSize.current = size;
  const [label, setLabel] = useState('Connecting benchmark');
  const observe = useCallback(sample => {
    const state = live.current;
    if (sample.cellWidthPx && sample.cellHeightPx) {
      state.geometry = sample;
      // xterm rounds exported physical cell dimensions; use feedback from its
      // actual fit instead of multiplying those rounded dimensions by 80.
      if (state.phase !== 'resize-reattach' && sample.columns && sample.rows) setSize(previous => {
        if (sample.columns === 80 && sample.rows === 24) return previous;
        const signature = `${sample.columns}:${sample.rows}:${sample.cellWidthPx}:${sample.cellHeightPx}`;
        if (state.lastFit === signature) return previous;
        state.lastFit = signature;
        return { width: previous.width + (80 - sample.columns) * sample.cellWidthPx / PixelRatio.get(),
          height: previous.height + (24 - sample.rows) * sample.cellHeightPx / PixelRatio.get() };
      });
    }
    if (sample.phase === 'prepared') {
      state.lastFrame = sample.timestampMs;
      if (!state.first) {
        state.first = true;
        void post({ type: 'first-prepared', mode: state.mode, run: state.run, ms: sample.timestampMs - state.attachAt });
      }
    }
    if (sample.phase === 'presented-proxy' && state.pendingInput !== null) {
      state.input.push(sample.timestampMs - state.pendingInput);
      state.pendingInput = null;
    }
    if (sample.phase === 'presented-proxy' && !state.firstProxy) {
      state.firstProxy = true;
      void post({ type: 'first-presented-proxy', mode: state.mode, run: state.run, ms: sample.timestampMs - state.attachAt });
    }
    if (state.phase) state.samples.push(sample);
  }, []);

  useEffect(() => {
    let native;
    let cancelled = false;
    NativeModules.WhipLaunchScreen?.hide();
    const execute = async () => {
      const assignment = await fetch('http://127.0.0.1:22393/run').then(response => response.json());
      setKnownHosts(config.knownHosts);
      native = createHostRuntime({ runtimeId: 'skia-benchmark', ssh: { host: config.host, port: 22392, username: config.username, authMode: 'key', secret: config.key }, jumpHosts: [], sessionName: 'default', herdrCommand: config.herdrCommand, socketPath: config.socketPath });
      await native.connect();
      let pane = native.hostState().snapshot.panes.find(p => p.focused);
      if (!pane) {
        await native.requestHerdrApi({ method: 'workspace.create', params: { focus: true, label: 'renderer benchmark', cwd: config.fixtureDirectory } });
        for (let attempt = 0; !pane && attempt < 50; attempt++) {
          await sleep(100);
          pane = native.hostState().snapshot.panes.find(p => p.focused);
        }
      }
      if (!pane) throw new Error('Fixture has no focused pane after workspace creation');
      const destination = { key: 'skia-benchmark', hostSessionId: 'skia-benchmark', client: { native, terminal: new TerminalBridgeController(() => native) }, session: { terminalId: pane.terminal_id, paneId: pane.pane_id, kind: 'herdr', status: 'connected', fontSize: 8 } };
      const paste = text => renderer.current.submitPastes(destination, [text]);
      const verify = async marker => {
        const response = await native.requestHerdrApi({ method: 'pane.read', params: { pane_id: destination.session.paneId, source: 'visible', format: 'text', strip_ansi: true, lines: 100 } });
        if (!hasCompletionMarker(response.read.text, marker)) throw new Error(`Missing workload completion: ${marker}`);
        await post({ type: 'verified', mode: live.current.mode, run: live.current.run, marker });
      };
      const phase = async (name, operation) => {
        const state = live.current;
        state.phase = name; state.samples = []; state.input = []; state.pendingInput = null;
        setLabel(`${state.mode} · ${state.run} · ${name}`);
        await post({ type: 'phase-start', mode: state.mode, run: state.run, name, geometry: state.geometry });
        await operation();
        state.phase = '';
        await post({ type: 'phase-end', mode: state.mode, run: state.run, name, samples: state.samples, inputProxyMs: state.input, geometry: state.geometry });
      };
      // Alternating order avoids assigning every cold cache and drift to one renderer.
      for (const [index, selected] of [[assignment.run, assignment.mode]]) {
        if (cancelled) return;
        setTarget(null); await sleep(750);
        live.current = { ...live.current, mode: selected, run: index, phase: '', first: false, attachAt: Date.now(), lastFrame: 0 };
        setMode(selected); setRun(index); setTarget(destination);
        for (let attempt = 0; !live.current.first && attempt < 200; attempt++) await sleep(100);
        if (!live.current.first) throw new Error(`${selected} first frame timed out`);
        await paste("printf '\\033cBENCHMARK_READY\\n'"); await sleep(2000);
        await phase('idle', () => sleep(8000));
        await phase('typing', async () => {
          for (let key = 0; key < 30; key++) {
            live.current.pendingInput = Date.now();
            renderer.current.input('x');
            await sleep(200);
          }
        });
        renderer.current.input('\u0015'); await sleep(500);
        await phase('seq100000', async () => { await paste("seq 1 100000 && printf 'SEQ_DONE\\n'"); await sleep(8000); });
        await verify('SEQ_DONE');
        for (const workload of ['continuous', 'unicode']) {
          await phase(workload, async () => {
            await paste(`${quote(config.nodeBinary)} ${quote(config.workload)} ${workload}`);
            await sleep(10000);
          });
          await verify(`${workload.toUpperCase()}_DONE`);
        }
        await paste(`vim -Nu NONE -n -i NONE ${quote(config.sampleFile)}`); await sleep(1500);
        await phase('vim', async () => {
          for (let key = 0; key < 60; key++) { renderer.current.input(key % 2 ? 'k' : 'j'); await sleep(100); }
        });
        renderer.current.input('\u001b'); await sleep(100); renderer.current.input(':q!\r'); await sleep(500);
        await phase('resize-reattach', async () => {
          const original = { ...measuredSize.current };
          for (let i = 0; i < 6; i++) { setSize({ width: 350 + i % 2 * 50, height: 240 + i % 2 * 60 }); await sleep(350); }
          setSize(original); setVisible(false); await sleep(500); setVisible(true); await sleep(2500);
        });
        await phase('reconnect', async () => {
          await fetch('http://127.0.0.1:22393/disconnect', { method: 'POST' });
          await sleep(1000);
          await native.recover(true, 'isolated benchmark connection loss');
          await sleep(4500);
        });
        await phase('sparse', async () => {
          await paste(`${quote(config.nodeBinary)} ${quote(config.workload)} sparse`);
          await sleep(10000);
        });
        await verify('SPARSE_DONE');
      }
      setTarget(null); await sleep(1000);
      await native.disconnect();
      setLabel('Benchmark complete');
      await post({ type: 'run-complete', run: assignment.run, mode: assignment.mode });
    };
    void execute().catch(error => { setLabel(String(error)); void post({ type: 'error', message: String(error), state: { mode: live.current.mode, run: live.current.run, phase: live.current.phase } }); });
    return () => { cancelled = true; void native?.disconnect(); };
  }, []);
  return <View style={{ flex: 1, backgroundColor: '#16161e', paddingTop: 64 }}>
    <Text testID="benchmark-status" style={{ color: 'white', height: 40 }}>{label}</Text>
    <View style={size}>{target && <TerminalRendererHost key={run} ref={renderer} activeTarget={target} targets={[target]} visible={visible} renderingEnabled={visible}
      preferences={{ ...defaultDevicePreferences.terminal, fontSize: 8, herdrRenderer: mode }} onFrameMetrics={observe}
      onReady={noop} onInput={(_, text) => mode === 'skia' ? renderer.current.writeEndpointInput(text) : target.client.terminal.writeToTerminal(target.session.terminalId, text)}
      onScroll={noop} onOfflineScroll={noop} onOfflineSnapshot={noop} onSearchResult={noop} onLinksScanned={noop} onOpenLink={noop} onPaste={noop}
      onBufferModeChange={noop} onVisualScrollState={noop} onProtocolStateChange={noop} onTitleChange={noop} onFontSizeChange={noop} onStatus={noop}
      onError={(_, error) => { setLabel(String(error)); void post({ type: 'renderer-error', error: String(error) }); }} style={{ flex: 1 }} />}</View>
  </View>;
}
registerRootComponent(Benchmark);
