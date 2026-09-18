/* global TextDecoder, TextEncoder */

const LEGACY_TERMINAL_ATTACH_LAUNCH_MODE = 1;
let latestMockControl;

function unavailable(error) {
  const value = String(error?.message || error || '').toLowerCase();
  return value.includes('channel not open')
    || value.includes('channel is not opened')
    || value.includes('failed to open channel')
    || value.includes('session is down')
    || value.includes('socket is not established');
}

class MockNativeHostProfileStore {
  constructor() { this.hosts = []; this.revision = 0; }
  normalizeProfile(profile, previousCreatedAt, now) {
    const host = {
      ...profile,
      id: profile.id.trim(), name: profile.name.trim(), host: profile.host.trim(),
      port: profile.port.trim() || '22', username: profile.username.trim(),
      jumpHostId: profile.jumpHostId?.trim() || undefined,
      forwardAgent: profile.authMode === 'key' && Boolean(profile.forwardAgent),
      herdrCommand: profile.herdrCommand.trim() || 'herdr',
      herdrSocketPath: profile.herdrSocketPath.trim(), sessionName: profile.sessionName.trim(),
      createdAt: previousCreatedAt || profile.createdAt || now, updatedAt: now,
    };
    if (!host.id || !host.host || !host.username) throw new Error('invalid host profile');
    return host;
  }
  result() {
    return { revision: ++this.revision, hosts: this.hosts, persistedValue: JSON.stringify(this.hosts) };
  }
  hydrate(value) {
    const parsed = value === undefined ? [] : JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('host profile data is malformed');
    this.hosts = parsed.map(profile => {
      const { rememberCredentials: _ignored, ...host } = profile;
      return this.normalizeProfile(host, host.createdAt, host.updatedAt);
    }).sort((a, b) => (b.lastConnectedAt || '').localeCompare(a.lastConnectedAt || '')
      || (a.name || a.host).localeCompare(b.name || b.host));
    return this.result();
  }
  view() { return this.result(); }
  upsert(profile, now) {
    const previous = this.hosts.find(host => host.id === profile.id);
    const next = this.normalizeProfile(profile, previous?.createdAt, now);
    this.hosts = [...this.hosts.filter(host => host.id !== next.id), next]
      .sort((a, b) => (b.lastConnectedAt || '').localeCompare(a.lastConnectedAt || '')
        || (a.name || a.host).localeCompare(b.name || b.host));
    return this.result();
  }
  markDisconnected(id, now) {
    this.hosts = this.hosts.map(host => host.id === id
      ? { ...host, lastConnectedAt: now, updatedAt: now } : host);
    return this.hydrate(JSON.stringify(this.hosts));
  }
  remove(id, now) {
    this.hosts = this.hosts.filter(host => host.id !== id).map(host => host.jumpHostId === id
      ? { ...host, jumpHostId: undefined, updatedAt: now } : host);
    return this.result();
  }
  resolveJumpChain(profileId, jumpHostId) {
    const byId = new Map(this.hosts.map(host => [host.id, host]));
    const seen = new Set([profileId]);
    const chain = [];
    for (let id = jumpHostId; id;) {
      if (seen.has(id)) throw new Error('cycle');
      const host = byId.get(id);
      if (!host) throw new Error(`missing jump host ${id}`);
      seen.add(id); chain.unshift(host); id = host.jumpHostId;
    }
    return chain;
  }
  jumpCandidates(profileId) {
    return this.hosts.filter(host => {
      if (host.id === profileId) return false;
      try { this.resolveJumpChain(profileId, host.id); return true; } catch { return false; }
    });
  }
  migrateLegacy(value, now) {
    const parsed = JSON.parse(value);
    if (!parsed.host || !parsed.username) return undefined;
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.host);
    return this.normalizeProfile({
      id: 'host-legacy-default', name: parsed.name || (ip ? parsed.host : parsed.host.split('.')[0]),
      host: parsed.host, port: parsed.port || '22', username: parsed.username,
      forwardAgent: false, authMode: parsed.authMode === 'key' ? 'key' : 'password',
      herdrCommand: parsed.herdrCommand || 'herdr', herdrSocketPath: parsed.herdrSocketPath || '',
      sessionName: parsed.sessionName || '', createdAt: now, updatedAt: now,
    }, undefined, now);
  }
}

class MockNativeKnownHostStore {
  constructor() { this.hosts = []; this.pending = undefined; this.token = 0n; }
  result(hosts = this.hosts) {
    return { revision: 1, hosts, persistedValue: JSON.stringify(hosts) };
  }
  hydrate(value) {
    const parsed = value === undefined ? [] : JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('malformed known hosts');
    this.hosts = parsed;
    this.pending = undefined;
    return this.result();
  }
  view() { return this.result(); }
  prepareAdd(challenge, id, createdAt) {
    if (this.hosts.some(host => host.host.toLowerCase() === challenge.host.toLowerCase()
      && host.port === challenge.port && host.keyType === challenge.keyType
      && host.fingerprint === challenge.fingerprint)) {
      return { token: 0n, changed: false, view: this.result() };
    }
    const hosts = [...this.hosts, { ...challenge, id, createdAt }];
    const token = ++this.token;
    this.pending = { token, hosts };
    return { token, changed: true, view: this.result(hosts) };
  }
  prepareRemove(id) {
    const hosts = this.hosts.filter(host => host.id !== id);
    if (hosts.length === this.hosts.length) return { token: 0n, changed: false, view: this.result() };
    const token = ++this.token;
    this.pending = { token, hosts };
    return { token, changed: true, view: this.result(hosts) };
  }
  commit(token) {
    if (this.pending?.token !== token) throw new Error('invalid mutation');
    this.hosts = this.pending.hosts;
    this.pending = undefined;
    return this.result();
  }
  rollback(token) {
    if (this.pending?.token !== token) throw new Error('invalid mutation');
    this.pending = undefined;
    return this.result();
  }
}

function createMockWhipSshModule() {
  const api = {
    connectWithPassword: jest.fn(),
    connectWithPasswordViaJump: jest.fn(),
    connectWithKey: jest.fn(),
    connectWithKeyViaJump: jest.fn(),
    createHostRuntime: jest.fn(),
    getHostRuntime: jest.fn(() => null),
    disconnectHostRuntime: jest.fn(async () => {}),
  };
  latestMockControl = api;

  const connectOne = async (config, jump) => {
    const args = [config.host, config.port, config.username, config.secret];
    let client;
    if (config.authMode === 'key') {
      client = jump
        ? await api.connectWithKeyViaJump(...args, config.passphrase, jump)
        : await api.connectWithKey(...args, config.passphrase);
    } else {
      client = jump
        ? await api.connectWithPasswordViaJump(...args, jump)
        : await api.connectWithPassword(...args);
    }
    if (config.forwardAgent) await client.setAgentForwarding?.(true);
    return client;
  };

  api.createHostRuntime.mockImplementation((config, lifecycleHandler) => {
    let clients = [];
    let generation = 0;
    let protocol;
    let resolvedSocket;
    let socketFromCache = Boolean(config.cachedSocketPath && !config.socketPath);
    const bridges = new Map();
    const bridgeGeometries = new Map();
    const sshShells = new Map();
    const sshShellGeometries = new Map();
    const transfers = new Map();
    let transferSequence = 0;
    let previewSequence = 0;
    let hostState = {
      revision: 0,
      connectionGeneration: 0,
      syncGeneration: 0,
      syncStatus: 'idle',
      freshness: 'loading',
      needsResync: false,
      focus: {},
    };

    const emitHostState = (agentStatusTransitions = []) => lifecycleHandler?.({
      type: 'host-state', state: hostState, agentStatusTransitions,
    });

    const socketPath = async () => {
      if (config.socketPath) return config.socketPath;
      if (resolvedSocket) return resolvedSocket;
      const home = await runtime.controlClient?.getRemoteHome?.() || `/home/${config.ssh.username}`;
      const dataDir = config.sessionName
        ? `${home}/.config/herdr/sessions/${config.sessionName}`
        : `${home}/.config/herdr`;
      resolvedSocket = `${dataDir}/herdr.sock`;
      return resolvedSocket;
    };

    const connectChain = async () => {
      const opened = [];
      try {
        let jump;
        for (const entry of [...config.jumpHosts, config.ssh]) {
          jump = await connectOne(entry, jump);
          opened.push(jump);
        }
        clients = opened;
        runtime.controlClient = opened[opened.length - 1];
        resolvedSocket = config.socketPath || config.cachedSocketPath;
        generation += 1;
        hostState = {
          ...hostState,
          revision: hostState.revision + 1,
          connectionGeneration: generation,
          freshness: hostState.snapshot ? 'stale' : 'loading',
          needsResync: true,
        };
        lifecycleHandler?.({
          type: 'connection-state', state: 'connected', generation,
          reconnectAttempt: 0,
        });
      } catch (error) {
        for (const client of opened.reverse()) client.disconnect?.();
        throw error;
      }
    };

    const runtime = {
      runtimeId: config.runtimeId,
      controlClient: undefined,
      async connect() {
        await connectChain();
        await runtime.refreshState();
      },
      async disconnect() {
        bridges.clear();
        bridgeGeometries.clear();
        sshShells.clear();
        sshShellGeometries.clear();
        for (const client of clients.reverse()) client.disconnect?.();
        clients = [];
        runtime.controlClient = undefined;
      },
      async recover(_immediate, reason) {
        lifecycleHandler?.({
          type: 'connection-state', state: 'reconnecting', generation,
          reconnectAttempt: 1, error: reason,
        });
        const oldClients = clients;
        await connectChain();
        await runtime.refreshState();
        for (const client of oldClients.reverse()) client.disconnect?.();
        for (const [terminalId, bridge] of bridges) {
          await runtime.controlClient.startHerdrBridge(
            await socketPath(), protocol || 20, terminalId, bridge.takeover,
            bridge.columns, bridge.rows, bridge.cellWidthPx, bridge.cellHeightPx,
            bridge.handler, LEGACY_TERMINAL_ATTACH_LAUNCH_MODE,
          );
        }
        lifecycleHandler?.({ type: 'reconnected', generation, restoredTerminals: bridges.size });
      },
      status() { return { state: clients.length ? 'connected' : 'disconnected', generation }; },
      setMonitoringState() {},
      detach() { lifecycleHandler = undefined; },
      hostState() { return hostState; },
      async refreshState() {
        const syncGeneration = hostState.syncGeneration + 1;
        hostState = {
          ...hostState,
          revision: hostState.revision + 1,
          syncGeneration,
          syncStatus: 'syncing',
          freshness: hostState.snapshot ? 'stale' : 'loading',
          error: undefined,
        };
        emitHostState();
        let result;
        let failure;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            result = await runtime.requestHerdrApi({ method: 'session.snapshot', params: {} });
            failure = undefined;
            break;
          } catch (error) {
            failure = error;
            if (!unavailable(error)) break;
          }
        }
        if (result?.type === 'session_snapshot' && result.snapshot) {
          hostState = {
            ...hostState,
            revision: hostState.revision + 1,
            syncStatus: 'synced',
            freshness: 'fresh',
            error: undefined,
            needsResync: false,
            lastSyncedAtMs: Date.now(),
            focus: {
              workspaceId: result.snapshot.focused_workspace_id,
              tabId: result.snapshot.focused_tab_id,
              paneId: result.snapshot.focused_pane_id,
            },
            snapshot: result.snapshot,
          };
        } else {
          hostState = {
            ...hostState,
            revision: hostState.revision + 1,
            syncStatus: 'error',
            freshness: hostState.snapshot ? 'stale' : 'unavailable',
            error: String(failure || 'Herdr host state unavailable'),
            needsResync: true,
          };
        }
        emitHostState();
        return hostState;
      },
      resolvedSocketPath() { return resolvedSocket; },
      resolveHerdrSocketPath() { return socketPath(); },
      async requestHerdrApi(request) {
        const call = async () => {
          const result = await runtime.controlClient.requestHerdrApi(await socketPath(), request);
          if (typeof result?.protocol === 'number') protocol = result.protocol;
          if (typeof result?.snapshot?.protocol === 'number') protocol = result.snapshot.protocol;
          return result;
        };
        try {
          return await call();
        } catch (error) {
          const replayable = ['workspace.focus', 'tab.focus', 'pane.focus', 'agent.focus']
            .includes(request.method);
          const replayableSocketRequest = replayable
            || ['ping', 'session.snapshot', 'pane.read'].includes(request.method);
          if (socketFromCache && unavailable(error) && replayableSocketRequest) {
            socketFromCache = false;
            resolvedSocket = undefined;
            return call();
          }
          if (!replayable || !unavailable(error)) throw error;
          await runtime.recover(true, String(error));
          return call();
        }
      },
      async startHerdrBridge(terminalId, takeover, columns, rows, cellWidthPx, cellHeightPx, handler) {
        const geometry = { columns, rows, cellWidthPx, cellHeightPx };
        bridgeGeometries.set(terminalId, geometry);
        const existing = bridges.get(terminalId);
        if (existing?.state === 'attached') {
          Object.assign(existing, { takeover, handler });
          return;
        }
        const bridge = {
          takeover,
          ...geometry,
          handler,
          kittyKeyboardReportAll: false,
          dispatchedGeometry: geometry,
          state: 'opening',
        };
        const forward = event => {
          if (event.type === 'kitty_keyboard_report_all') {
            bridge.kittyKeyboardReportAll = event.flag === true;
          }
          bridge.handler?.(event);
        };
        bridges.set(terminalId, bridge);
        if (!protocol) {
          const result = await runtime.controlClient.requestHerdrApi(
            await socketPath(), { method: 'ping', params: {} },
          );
          protocol = result.protocol;
        }
        await runtime.controlClient.startHerdrBridge(
          await socketPath(), protocol || 20, terminalId, takeover, columns, rows,
          cellWidthPx, cellHeightPx, forward, LEGACY_TERMINAL_ATTACH_LAUNCH_MODE,
        );
        bridge.state = 'attached';
      },
      herdrBridgeInput(terminalId, text) {
        return runtime.controlClient.herdrBridgeInput(terminalId, text);
      },
      async herdrBridgeResize(terminalId, columns, rows, cellWidthPx, cellHeightPx, forceDispatch = false) {
        const bridge = bridges.get(terminalId);
        const geometry = { columns, rows, cellWidthPx, cellHeightPx };
        bridgeGeometries.set(terminalId, geometry);
        if (!bridge || bridge.state !== 'attached') return 'deferred';
        if (!forceDispatch && bridge.dispatchedGeometry
          && Object.keys(geometry).every(
            key => bridge.dispatchedGeometry[key] === geometry[key],
          )) {
          return 'deduplicated';
        }
        await runtime.controlClient.herdrBridgeResize(
          terminalId, columns, rows, cellWidthPx, cellHeightPx,
        );
        Object.assign(bridge, geometry, { dispatchedGeometry: geometry });
        return 'dispatched';
      },
      herdrBridgeGeometry(terminalId) { return bridgeGeometries.get(terminalId); },
      herdrBridgeProtocolState(terminalId) {
        return { kittyKeyboardReportAll: bridges.get(terminalId)?.kittyKeyboardReportAll === true };
      },
      detachHerdrBridge(terminalId) {
        const bridge = bridges.get(terminalId);
        if (bridge) bridge.handler = undefined;
      },
      herdrBridgeScroll(terminalId, up, lines, column, row, modifiers = 0) {
        const args = [terminalId, up ? 'up' : 'down', lines, column, row];
        if (modifiers) args.push(modifiers);
        return runtime.controlClient.herdrBridgeScroll(...args);
      },
      closeHerdrBridge(terminalId) {
        bridges.delete(terminalId);
        bridgeGeometries.delete(terminalId);
        runtime.controlClient?.closeHerdrBridge?.(terminalId);
      },
      closeAllHerdrBridges() {
        bridges.clear();
        bridgeGeometries.clear();
        runtime.controlClient?.closeAllHerdrBridges?.();
      },
      hasHerdrBridge(terminalId) { return bridges.get(terminalId)?.state === 'attached'; },
      isHerdrBridgeOpening(terminalId) { return bridges.get(terminalId)?.state === 'opening'; },
      async openSshShell(terminalId, columns, rows, cellWidthPx, cellHeightPx, handler) {
        const geometry = { columns, rows, cellWidthPx, cellHeightPx };
        sshShellGeometries.set(terminalId, geometry);
        const existing = sshShells.get(terminalId);
        if (existing) {
          existing.handler = handler;
          return;
        }
        const client = runtime.controlClient;
        const onData = data => {
          const bytes = new TextEncoder().encode(data);
          sshShells.get(terminalId)?.handler.data(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          );
        };
        sshShells.set(terminalId, {
          client,
          handler,
          onData,
          dispatchedGeometry: geometry,
        });
        client.on('Shell', onData);
        await client.startShell('xterm-256color');
        client.resizeShell(columns, rows);
      },
      sshShellInput(terminalId, bytes) {
        const shell = sshShells.get(terminalId);
        if (!shell) throw new Error(`SSH shell ${terminalId} is not connected`);
        return shell.client.writeToShell(new TextDecoder().decode(bytes));
      },
      resizeSshShell(terminalId, columns, rows, cellWidthPx, cellHeightPx, forceDispatch = false) {
        const geometry = { columns, rows, cellWidthPx, cellHeightPx };
        sshShellGeometries.set(terminalId, geometry);
        const shell = sshShells.get(terminalId);
        if (!shell) return 'deferred';
        if (!forceDispatch && shell.dispatchedGeometry
          && Object.keys(geometry).every(
            key => shell.dispatchedGeometry[key] === geometry[key],
          )) {
          return 'deduplicated';
        }
        shell.client.resizeShell(columns, rows);
        shell.dispatchedGeometry = geometry;
        return 'dispatched';
      },
      sshShellGeometry(terminalId) { return sshShellGeometries.get(terminalId); },
      closeSshShell(terminalId) {
        const shell = sshShells.get(terminalId);
        sshShellGeometries.delete(terminalId);
        if (!shell) return;
        sshShells.delete(terminalId);
        shell.client.off('Shell');
        shell.client.closeShell();
      },
      hasSshShell(terminalId) { return sshShells.has(terminalId); },
      createTabWithLaunch(workspaceId, label, launch) {
        return runtime.controlClient.createTabWithLaunch(workspaceId, label, launch);
      },
      agentIntegrationStatus(kind) {
        return runtime.controlClient.agentIntegrationStatus(kind);
      },
      installAgentIntegration(kind) {
        return runtime.controlClient.installAgentIntegration(kind);
      },
      submitPastes(paneId, parts) { return runtime.controlClient.submitPastes(paneId, parts); },
      startHerdrServer() { return runtime.controlClient.startHerdrServer(); },
      execute(command) { return runtime.controlClient.execute(command); },
      remoteHome() { return runtime.controlClient.getRemoteHome(); },
      measureHostLatency() { return runtime.controlClient.measureHostLatency(); },
      async listDirectory(path) {
        const home = await runtime.controlClient.getRemoteHome();
        const resolved = path || home;
        const entries = await runtime.controlClient.sftpLs(resolved);
        return {
          path: resolved,
          entries: entries.map(entry => {
            const name = entry.filename.replace(/\/+$/, '');
            return {
              name,
              path: `${resolved.replace(/\/$/, '')}/${name}`,
              kind: entry.isDirectory ? 'directory' : 'file',
              size: entry.fileSize,
              modifiedAt: Number(entry.modificationDate) || undefined,
            };
          }),
        };
      },
      removeRemotePath(path, directory) {
        return directory ? runtime.controlClient.sftpRmdir(path) : runtime.controlClient.sftpRm(path);
      },
      startUpload(local, remoteDirectory) {
        const id = `transfer-${++transferSequence}`;
        const result = runtime.controlClient.sftpUpload(local, remoteDirectory).then(() => ({ transferId: id }));
        transfers.set(id, result);
        return { id, result };
      },
      startAttachmentUpload(local) {
        const id = `transfer-${++transferSequence}`;
        const source = local.split('/').pop();
        const dot = source.lastIndexOf('.');
        const stem = (dot > 0 ? source.slice(0, dot) : source).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
        const extension = dot > 0 ? source.slice(dot) : '';
        const result = (async () => {
          const home = await runtime.controlClient.getRemoteHome();
          const directory = `${home}/.whip/uploads`;
          await runtime.controlClient.sftpCreateDirAll(directory);
          const remotePath = `${directory}/${stem}-${id}${extension}`;
          await runtime.controlClient.sftpUploadToPath(local, remotePath);
          return { transferId: id, localPath: local, remotePath };
        })();
        transfers.set(id, result);
        return { id, result };
      },
      startDownload(remote, localDirectory) {
        const id = `transfer-${++transferSequence}`;
        const result = runtime.controlClient.sftpDownload(remote, localDirectory)
          .then(localPath => ({ transferId: id, localPath, remotePath: remote }));
        transfers.set(id, result);
        return { id, result };
      },
      cancelTransfer(id) {
        if (!transfers.has(id)) return false;
        runtime.controlClient.sftpCancelUpload();
        return true;
      },
      discoverGitRepository: jest.fn(async () => null),
      gitStatus: jest.fn(async () => []),
      gitDiff: jest.fn(),
      async startWebPreview(url) {
        const parsed = new URL(url);
        const port = await runtime.controlClient.openLocalForward(parsed.hostname, Number(parsed.port) || 80);
        parsed.hostname = '127.0.0.1';
        parsed.port = String(port);
        return { id: `preview-${++previewSequence}`, kind: 'web-forward', state: 'running', url: parsed.toString() };
      },
      async startHtmlPreview() { throw new Error('HTML previews are not implemented by the unit mock'); },
      async startRemoteFilePreview(path) {
        const server = await runtime.controlClient.startSftpFileServer(path);
        return { id: `preview-${++previewSequence}`, kind: 'remote-file', state: 'running', url: `http://127.0.0.1:${server.localPort}/${server.token}/file` };
      },
      async stopPreview() {},
      async openLocalForward(host, port) { return runtime.controlClient.openLocalForward(host, port); },
      closeLocalForward(port) { return runtime.controlClient.closeLocalForward(port); },
      sftpLs(path) { return runtime.controlClient.sftpLs(path); },
      sftpRemove(path, directory) {
        return directory ? runtime.controlClient.sftpRmdir(path) : runtime.controlClient.sftpRm(path);
      },
      sftpCreateDirAll(path) { return runtime.controlClient.sftpCreateDirAll(path); },
      sftpUpload(local, remote, exact = false) {
        return exact
          ? runtime.controlClient.sftpUploadToPath(local, remote)
          : runtime.controlClient.sftpUpload(local, remote);
      },
      sftpDownload(remote, local) { return runtime.controlClient.sftpDownload(remote, local); },
      cancelSftpUpload() { return runtime.controlClient.sftpCancelUpload(); },
      startSftpFileServer(path) { return runtime.controlClient.startSftpFileServer(path); },
      closeSftpFileServer(port) { return runtime.controlClient.closeSftpFileServer(port); },
    };
    return runtime;
  });

  return {
    __esModule: true,
    createHostRuntime: api.createHostRuntime,
    getHostRuntime: api.getHostRuntime,
    disconnectHostRuntime: api.disconnectHostRuntime,
    NativeHostProfileStore: MockNativeHostProfileStore,
    NativeKnownHostStore: MockNativeKnownHostStore,
  };
}

function getMockWhipSshControl() {
  if (!latestMockControl) throw new Error('react-native-whip-ssh mock has not been initialized');
  return latestMockControl;
}

module.exports = { createMockWhipSshModule, getMockWhipSshControl };
