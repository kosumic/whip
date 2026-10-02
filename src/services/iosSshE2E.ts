import {
  createHostRuntime,
  getKeyDetails,
  setKnownHosts,
  type HostRuntimeConnection,
  type RuntimeSshConfig,
  type RuntimeSshShellHandler,
} from 'react-native-whip-ssh';
import { Directory, File, Paths } from 'expo-file-system';
import { errorCode } from '../lib/connectionErrors';
import {
  operationalErrorDetails,
  recordOperationalDiagnostic,
} from './operationalDiagnostics';

export const IOS_SSH_E2E_CONFIG_FILE = 'whip-ios-ssh-e2e-config.json';
export const IOS_SSH_E2E_RESULT_FILE = 'whip-ios-ssh-e2e-result.json';

interface IosSshE2EConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  privateKey: string;
  knownHostLine: string;
  changedHostLine: string;
}

interface IosSshE2EStep {
  name: string;
  durationMs: number;
}

export interface IosSshE2EResult {
  status: 'passed' | 'failed';
  steps: IosSshE2EStep[];
  error?: string;
  durationMs: number;
}

let runtimeSequence = 0;

function sshConfig(
  config: IosSshE2EConfig,
  authMode: 'password' | 'key',
  options: { host?: string; port?: number; forwardAgent?: boolean } = {},
): RuntimeSshConfig {
  return {
    host: options.host ?? config.host,
    port: options.port ?? config.port,
    username: config.username,
    authMode,
    secret: authMode === 'password' ? config.password : config.privateKey,
    forwardAgent: options.forwardAgent ?? false,
  };
}

async function connectRuntime(
  ssh: RuntimeSshConfig,
  jumpHosts: RuntimeSshConfig[] = [],
): Promise<HostRuntimeConnection> {
  const runtime = createHostRuntime({
    runtimeId: `ios-ssh-e2e-${Date.now()}-${++runtimeSequence}`,
    ssh,
    jumpHosts,
    sessionName: '',
    herdrCommand: 'herdr',
  });
  try {
    await runtime.connect();
    return runtime;
  } catch (error) {
    await runtime.disconnect().catch(disconnectError => {
      recordOperationalDiagnostic('warn', 'Application', 'ios-ssh-e2e-cleanup-failed', {
        stage: 'failed-connect',
        ...operationalErrorDetails(disconnectError),
      });
    });
    throw error;
  }
}

export async function runIosSshE2E(
  onStep: (name: string) => void = () => undefined,
): Promise<IosSshE2EResult> {
  const startedAt = Date.now();
  const steps: IosSshE2EStep[] = [];
  const runtimes: HostRuntimeConnection[] = [];
  const resources: {
    cleanupRuntime?: HostRuntimeConnection;
    localForward?: { runtime: HostRuntimeConnection; previewId: string };
  } = {};
  let remoteDirectory: string | null = null;
  let result: IosSshE2EResult;

  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    onStep(name);
    console.log(`[WHIP_IOS_SSH_E2E] START ${name}`);
    const stepStartedAt = Date.now();
    const value = await withTimeout(action(), 30_000, name);
    const durationMs = Date.now() - stepStartedAt;
    steps.push({ name, durationMs });
    console.log(`[WHIP_IOS_SSH_E2E] PASS ${name} (${durationMs}ms)`);
    return value;
  };

  try {
    const config = await step('load simulator configuration', loadConfig);

    await step('reject unknown host key', async () => {
      setKnownHosts('');
      await expectConnectionFailure(
        () => connectRuntime(sshConfig(config, 'key')),
        'HOST_KEY_UNKNOWN',
      );
    });

    await step('reject changed host key', async () => {
      setKnownHosts(config.changedHostLine);
      await expectConnectionFailure(
        () => connectRuntime(sshConfig(config, 'key')),
        'HOST_KEY_CHANGED',
      );
    });

    setKnownHosts(config.knownHostLine);
    const passwordRuntime = await step('authenticate with password', async () => {
      const runtime = await connectRuntime(sshConfig(config, 'password'));
      runtimes.push(runtime);
      assertIncludes(await runtime.execute('printf whip-password-auth'), 'whip-password-auth');
      return runtime;
    });
    await passwordRuntime.disconnect();

    const keyRuntime = await step('authenticate with Ed25519 key', async () => {
      const details = getKeyDetails(config.privateKey);
      if (details.keyType !== 'ssh-ed25519') {
        throw new Error(`Expected ssh-ed25519 key, received ${details.keyType}`);
      }
      const runtime = await connectRuntime(sshConfig(config, 'key', { forwardAgent: true }));
      runtimes.push(runtime);
      resources.cleanupRuntime = runtime;
      return runtime;
    });

    await step('execute command', async () => {
      assertIncludes(await keyRuntime.execute('printf whip-execute'), 'whip-execute');
    });

    await step('open interactive PTY shell', async () => {
      const terminalId = 'ios-ssh-e2e-shell';
      const shell = shellTokenWaiter('whip-shell-ready');
      await keyRuntime.openSshShell(terminalId, 80, 24, 0, 0, shell.handler);
      keyRuntime.sshShellInput(terminalId, utf8Buffer("printf 'whip-shell-ready\\n'\n"));
      await shell.result;
      keyRuntime.closeSshShell(terminalId);
    });

    await step('forward authenticated SSH agent', async () => {
      assertIncludes(await keyRuntime.execute('ssh-add -L'), 'ssh-ed25519');
    });

    await step('upload and download with SFTP', async () => {
      const remoteHome = (await keyRuntime.remoteHome()).trim();
      remoteDirectory = `${remoteHome}/.whip-ios-e2e-${Date.now()}`;
      await keyRuntime.execute(`mkdir -p '${remoteDirectory}'`);

      const localDirectory = new Directory(Paths.cache, `whip-ios-e2e-${Date.now()}`);
      localDirectory.create({ idempotent: true });
      const upload = new File(localDirectory, 'payload.txt');
      upload.write('whip-sftp-payload');
      await keyRuntime.startUpload(nativePath(upload.uri), remoteDirectory).result;

      const listing = await keyRuntime.listDirectory(remoteDirectory);
      if (!listing.entries.some(entry => entry.name === 'payload.txt')) {
        throw new Error('Uploaded SFTP file was not present in directory listing');
      }

      const downloadDirectory = new Directory(localDirectory, 'download');
      downloadDirectory.create({ idempotent: true });
      const download = await keyRuntime.startDownload(
        `${remoteDirectory}/payload.txt`,
        `${nativePath(downloadDirectory.uri)}/`,
      ).result;
      if (!download.localPath) throw new Error('Native download returned no local path');
      const downloaded = new File(fileUri(download.localPath));
      if (await downloaded.text() !== 'whip-sftp-payload') {
        throw new Error('Downloaded SFTP content did not match the uploaded file');
      }
      localDirectory.delete();
    });

    await step('connect through ProxyJump chain', async () => {
      const jumped = await connectRuntime(
        sshConfig(config, 'key'),
        [sshConfig(config, 'key')],
      );
      runtimes.push(jumped);
      assertIncludes(await jumped.execute('printf whip-jump'), 'whip-jump');
    });

    await step('connect through local TCP forwarding', async () => {
      const preview = await keyRuntime.startWebPreview(`http://${config.host}:${config.port}`);
      resources.localForward = { runtime: keyRuntime, previewId: preview.id };
      const localPort = Number(new URL(preview.url).port);
      if (!Number.isInteger(localPort) || localPort <= 0) {
        throw new Error(`Native forwarding returned an invalid local URL: ${preview.url}`);
      }
      setKnownHosts([
        config.knownHostLine,
        knownHostLineForPort(config.knownHostLine, config.host, localPort),
      ].join('\n'));
      const forwarded = await connectRuntime(sshConfig(config, 'key', {
        host: '127.0.0.1',
        port: localPort,
      }));
      runtimes.push(forwarded);
      assertIncludes(await forwarded.execute('printf whip-local-forward'), 'whip-local-forward');
    });

    result = {
      status: 'passed',
      steps,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    result = {
      status: 'failed',
      steps,
      error: errorMessage(error),
      durationMs: Date.now() - startedAt,
    };
    console.error(`[WHIP_IOS_SSH_E2E] FAIL ${result.error}`);
  } finally {
    if (resources.localForward) {
      await withTimeout(
        resources.localForward.runtime.stopPreview(resources.localForward.previewId),
        5_000,
        'local forwarding cleanup',
      ).catch(error => {
        recordOperationalDiagnostic('warn', 'Application', 'ios-ssh-e2e-cleanup-failed', {
          stage: 'local-forward',
          ...operationalErrorDetails(error),
        });
      });
    }
    if (resources.cleanupRuntime && remoteDirectory) {
      await withTimeout(
        resources.cleanupRuntime.execute(`rm -rf '${remoteDirectory}'`),
        5_000,
        'remote SFTP cleanup',
      ).catch(error => {
        recordOperationalDiagnostic('warn', 'Application', 'ios-ssh-e2e-cleanup-failed', {
          stage: 'remote-directory',
          ...operationalErrorDetails(error),
        });
      });
    }
    const runtimesInCleanupOrder = [...runtimes];
    runtimesInCleanupOrder.reverse();
    for (const runtime of runtimesInCleanupOrder) {
      await runtime.disconnect().catch(error => {
        recordOperationalDiagnostic('warn', 'Application', 'ios-ssh-e2e-cleanup-failed', {
          stage: 'runtime-disconnect',
          ...operationalErrorDetails(error),
        });
      });
    }
  }
  writeResult(result);
  return result;
}

async function loadConfig(): Promise<IosSshE2EConfig> {
  const file = new File(Paths.document, IOS_SSH_E2E_CONFIG_FILE);
  if (!file.exists) throw new Error(`Missing ${IOS_SSH_E2E_CONFIG_FILE}`);
  const parsed = JSON.parse(await file.text()) as Partial<IosSshE2EConfig>;
  for (const key of ['host', 'username', 'password', 'privateKey', 'knownHostLine', 'changedHostLine'] as const) {
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0) {
      throw new Error(`Invalid iOS SSH E2E configuration field: ${key}`);
    }
  }
  if (!Number.isInteger(parsed.port) || Number(parsed.port) <= 0) {
    throw new Error('Invalid iOS SSH E2E configuration field: port');
  }
  return parsed as IosSshE2EConfig;
}

async function expectConnectionFailure(
  connect: () => Promise<HostRuntimeConnection>,
  expected: string,
): Promise<void> {
  let runtime: HostRuntimeConnection;
  try {
    runtime = await connect();
  } catch (error) {
    if (errorCode(error) === expected || errorMessage(error).includes(expected)) return;
    throw error;
  }
  await runtime.disconnect();
  throw new Error(`Connection unexpectedly succeeded; expected ${expected}`);
}

function shellTokenWaiter(token: string): {
  handler: RuntimeSshShellHandler;
  result: Promise<void>;
} {
  const decoder = new TextDecoder();
  let output = '';
  let settle: (() => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const result = withTimeout(new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  }), 10_000, 'interactive shell output');
  return {
    handler: {
      data(bytes): void {
        output += decoder.decode(bytes, { stream: true });
        if (output.includes(token)) settle?.();
      },
      closed(reason): void {
        fail?.(new Error(`Interactive shell closed before ${token}: ${reason}`));
      },
    },
    result,
  };
}

function utf8Buffer(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function knownHostLineForPort(line: string, host: string, port: number): string {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 3) throw new Error('Invalid trusted known_hosts line');
  return `[${host}]:${port} ${fields[1]} ${fields[2]}`;
}

function assertIncludes(value: string, expected: string): void {
  if (!value.includes(expected)) throw new Error(`Expected output to contain ${expected}: ${value}`);
}

function nativePath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function fileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeResult(result: IosSshE2EResult): void {
  const serialized = JSON.stringify(result, null, 2);
  new File(Paths.document, IOS_SSH_E2E_RESULT_FILE).write(serialized);
  console.log(`[WHIP_IOS_SSH_E2E] RESULT ${JSON.stringify(result)}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
