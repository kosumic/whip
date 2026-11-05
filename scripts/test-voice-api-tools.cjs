#!/usr/bin/env node
/* eslint-env node, es2022 */
// Explicitly billable integration probe. All tool results are synthetic; no phone
// commands, UI navigation, SSH connections or agent prompts are executed.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const WebSocket = require('ws');
const Ajv = require('ajv');

const root = path.resolve(__dirname, '..');
const output = path.resolve(
  process.env.WHIP_VOICE_API_OUTPUT || path.join(root, '.codex-voice-api'),
);
const contractPath = path.join(output, 'contract.json');
const reportPath = path.join(output, 'report.json');
const report = { calls: [], scenarios: [], errors: [], usage: [] };
const keyPath = process.env.WHIP_VOICE_API_KEY_FILE;
if (!keyPath)
  throw new Error(
    'Set WHIP_VOICE_API_KEY_FILE to the authorized API-key file.',
  );
let key = fs.readFileSync(keyPath, 'utf8').trim();
if (key.startsWith('OPENAI_API_KEY='))
  key = key.slice('OPENAI_API_KEY='.length).replace(/^['"]|['"]$/g, '');
if (!key.startsWith('sk-') || /\s/.test(key))
  throw new Error('Expected an OpenAI API key in the specified file.');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const log = value => console.log(String(value).replaceAll(key, '[redacted]'));

function rustTest(name, variables) {
  const result = spawnSync(
    'cargo',
    [
      'test',
      '--locked',
      '--manifest-path',
      'packages/react-native-whip-ssh/rust/Cargo.toml',
      '--lib',
      name,
      '--',
      '--ignored',
      '--exact',
      '--test-threads=1',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, ...variables },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  log(result.stdout || '');
  log(result.stderr || '');
  if (result.status !== 0)
    throw new Error(`Rust contract check failed: ${name}`);
}

// Opaque IDs deliberately repeat across hosts, as they can in real Herdr state.
const hosts = [
  {
    id: 'host',
    name: 'Workstation',
    host: 'host.test',
    port: '22',
    username: 'user',
  },
  { id: 'mini', name: 'Mini', host: 'mini.test', port: '22', username: 'user' },
];
const agents = [
  {
    host_id: 'host',
    workspace_id: 'space-a',
    tab_id: 'tab-a',
    pane_id: 'pane-a',
    terminal_id: 'terminal-a',
    name: 'builder',
    status: 'working',
  },
  {
    host_id: 'host',
    workspace_id: 'space-b',
    tab_id: 'tab-b',
    pane_id: 'pane-b',
    terminal_id: 'terminal-b',
    name: 'reviewer',
    status: 'blocked',
  },
  {
    host_id: 'host',
    workspace_id: 'space-b',
    tab_id: 'tab-b',
    pane_id: 'pane-c',
    terminal_id: 'terminal-c',
    name: 'helper',
    status: 'idle',
  },
  {
    host_id: 'mini',
    workspace_id: 'space-b',
    tab_id: 'tab-b',
    pane_id: 'pane-b',
    terminal_id: 'terminal-b',
    name: 'tester',
    status: 'done',
  },
].map(agent => ({ ...agent, kind: 'codex', current: true }));
const scenarios = [
  {
    id: 'all-counts',
    text: 'Check now: how many agents across all hosts and all spaces? Give the status counts.',
    name: 'agents_summary',
    scope: {},
  },
  {
    id: 'host-counts',
    text: 'Check now: agent status counts on the saved host host, across all its spaces.',
    name: 'agents_summary',
    scope: { host_id: 'host' },
  },
  {
    id: 'space-counts',
    text: 'Check now: agent status counts only in workspace space-b on host host.',
    name: 'agents_summary',
    scope: { host_id: 'host', workspace_id: 'space-b' },
  },
  {
    id: 'all-agents',
    text: 'List the current agents across all saved hosts and all spaces using Whip.',
    name: 'agents_list',
    scope: {},
  },
  {
    id: 'space-agents',
    text: 'List only the agents in workspace space-b on host host.',
    name: 'agents_list',
    scope: { host_id: 'host', workspace_id: 'space-b' },
  },
  {
    id: 'page',
    text: 'Fetch the agent list for host host, workspace space-b, with offset 1 and limit 1. Return just that page.',
    name: 'agents_list',
    scope: { host_id: 'host', workspace_id: 'space-b', offset: 1, limit: 1 },
  },
  {
    id: 'spaces',
    text: 'List the current workspace IDs on saved host host.',
    name: 'workspaces_list',
    scope: { host_id: 'host' },
  },
  {
    id: 'tabs',
    text: 'List tabs only in workspace space-b on host host.',
    name: 'tabs_list',
    scope: { host_id: 'host', workspace_id: 'space-b' },
  },
  {
    id: 'panes',
    text: 'List panes only in workspace space-b on host host.',
    name: 'panes_list',
    scope: { host_id: 'host', workspace_id: 'space-b' },
  },
  {
    id: 'battery',
    text: 'Check the phone battery level now.',
    name: 'device_battery',
  },
  {
    id: 'network',
    text: 'Check the phone network status now.',
    name: 'device_network',
  },
  {
    id: 'device-info',
    text: 'Check the phone model and operating system now.',
    name: 'device_info',
  },
  {
    id: 'navigate',
    text: 'Switch Whip to its Herd screen.',
    name: 'app_navigate',
    scope: { tab: 'herd' },
  },
  {
    id: 'shizuku-status',
    text: 'Check the current Shizuku service authorization on the phone.',
    name: 'device_shizuku_status',
  },
  {
    id: 'shizuku-argv',
    text: 'Use the enabled Shizuku access to run /system/bin/id on the Android phone, with the default timeout and output limit.',
    name: 'device_shizuku_exec',
    scope: { argv: ['/system/bin/id'] },
  },
];

function toolOutput(name, args) {
  if (name === 'hosts_list')
    return {
      hosts,
      connections: hosts.map(host => ({
        host_id: host.id,
        status: 'connected',
      })),
    };
  if (name === 'app_snapshot') return { tab: 'herd', foreground: true };
  if (name.startsWith('app_') || name === 'remain_silent')
    return { completed: true };
  if (name === 'agents_prompt')
    return { submitted: false, confirmation_required: true };
  if (name === 'device_battery')
    return { level: 0.92, state: 'charging', low_power_mode: false };
  if (name === 'device_network')
    return {
      connected: true,
      connection_type: 'wifi',
      internet_reachable: true,
      is_expensive: false,
      low_data_mode: false,
    };
  if (name === 'device_info')
    return {
      platform: 'android',
      model: 'Synthetic phone',
      manufacturer: 'Synthetic',
      os_version: '17',
      app_version: 'test',
      locale: 'en-US',
      time_zone: 'America/New_York',
    };
  if (name === 'device_shizuku_status')
    return {
      status: 'ready',
      authorized: true,
      backend: 'shizuku',
      uid: 2000,
      server_version: 13,
    };
  if (name === 'device_shizuku_exec')
    return {
      uid: 2000,
      exit_code: 0,
      stdout: 'uid=2000(shell)\n',
      stderr: '',
      truncated: false,
      timed_out: false,
    };
  const selected = agents.filter(
    agent =>
      (!args.host_id || agent.host_id === args.host_id) &&
      (!args.workspace_id || agent.workspace_id === args.workspace_id),
  );
  const counts = {
    total: selected.length,
    working: 0,
    blocked: 0,
    idle: 0,
    done: 0,
    unknown: 0,
  };
  selected.forEach(agent => counts[agent.status]++);
  const result = {
    source: 'whip',
    complete: true,
    counts,
    hosts: hosts
      .filter(host => !args.host_id || host.id === args.host_id)
      .map(host => ({
        host_id: host.id,
        name: host.name,
        current: true,
        connected: true,
        freshness: 'fresh',
      })),
  };
  if (name === 'agents_summary') return result;
  let items = selected;
  if (name === 'workspaces_list' || name === 'tabs_list') {
    const field = name === 'workspaces_list' ? 'workspace_id' : 'tab_id';
    items = [
      ...new Map(
        selected.map(agent => [
          `${agent.host_id}/${agent[field]}`,
          {
            host_id: agent.host_id,
            workspace_id: agent.workspace_id,
            [field]: agent[field],
            label: agent[field],
            current: true,
          },
        ]),
      ).values(),
    ];
  }
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 20;
  return {
    ...result,
    items: items.slice(offset, offset + limit),
    total: items.length,
    next_offset: offset + limit < items.length ? offset + limit : null,
  };
}

class Connection {
  constructor(url) {
    this.events = [];
    this.waiters = [];
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 20000,
      maxPayload: 2 * 1024 * 1024,
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', data => {
      try {
        this.push(JSON.parse(data.toString()));
      } catch {
        this.push({ type: 'probe.error', message: 'Non-JSON API event' });
      }
    });
    this.ws.on('error', error =>
      this.push({ type: 'probe.error', message: error.message }),
    );
    this.ws.on('close', (code, reason) =>
      this.push({ type: 'probe.closed', code, reason: reason.toString() }),
    );
  }
  push(event) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.events.push(event);
  }
  send(event) {
    this.ws.send(JSON.stringify(event));
  }
  next(timeout = 45000) {
    if (this.events.length) return Promise.resolve(this.events.shift());
    return new Promise((resolve, reject) => {
      const receive = event => {
        clearTimeout(timer);
        resolve(event);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter !== receive);
        reject(new Error('API event timeout'));
      }, timeout);
      this.waiters.push(receive);
    });
  }
  close() {
    this.ws.terminate();
  }
}

async function runProvider(provider, contract) {
  const live = provider === 'gpt-live-1';
  const start = structuredClone(live ? contract.live : contract.realtime);
  // Keep the production tool catalog and instructions. Realtime text output
  // isolates tool arguments from microphone/media quality and lowers test cost.
  if (!live) start.session.output_modalities = ['text'];
  const backend = live ? start.session.delegation.responses : start.session;
  backend.instructions +=
    '\nThis is a synthetic integration probe. Obtain new tool observations for each user request, even if similar data appeared earlier. Keep answers brief. The tool fixtures contain no real hosts or device data.';
  const tools = backend.tools;
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validators = new Map(
    tools.map(tool => [tool.name, ajv.compile(tool.parameters)]),
  );
  const connection = new Connection(
    live
      ? 'wss://api.openai.com/v1/live/sessions'
      : `wss://api.openai.com/v1/realtime?model=${provider}`,
  );
  let silenceTimer;
  const checkError = event => {
    if (
      event.type === 'error' ||
      event.type === 'probe.error' ||
      event.type === 'probe.closed'
    )
      throw new Error(JSON.stringify(event));
    if (event.type === 'session.closed')
      throw new Error(
        `Live session ended: ${JSON.stringify({ reason: event.reason, usage: event.usage })}`,
      );
    if (
      live &&
      event.type === 'response.event' &&
      ['response.failed', 'response.incomplete'].includes(event.event?.type)
    )
      throw new Error(JSON.stringify(event));
  };
  try {
    await connection.opened;
    if (!live) {
      for (;;) {
        const event = await connection.next();
        checkError(event);
        if (event.type === 'session.created') break;
      }
    }
    connection.send(start);
    for (;;) {
      const event = await connection.next();
      checkError(event);
      if (event.type === (live ? 'session.started' : 'session.updated')) break;
    }
    log(`${provider}: accepted ${tools.length} production tool schemas`);
    if (live) {
      // Match the native adapter's continuous 24 kHz PCM input. No microphone
      // or recorded speech is used; every frame is synthetic silence.
      const silence = Buffer.alloc((24000 / 50) * 2).toString('base64');
      silenceTimer = setInterval(() => {
        if (connection.ws.readyState === WebSocket.OPEN)
          connection.send({
            type: 'session.input_audio.append',
            audio: silence,
          });
      }, 20);
    }
    const selectedScenarios = process.env.WHIP_VOICE_API_SCENARIOS?.split(',');
    for (const scenario of scenarios.filter(
      item => !selectedScenarios || selectedScenarios.includes(item.id),
    )) {
      const firstCall = report.calls.length;
      const failures = [];
      let rounds = 0;
      let text = '';
      let finished = false;
      const completedCalls = new Map();
      const activeResponses = new Map();
      const deadline = Date.now() + 90000;
      connection.send({
        type: live ? 'response.item.create' : 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: scenario.text }],
        },
      });
      connection.send({ type: 'response.create' });
      while (!finished && Date.now() < deadline) {
        const envelope = await connection.next(
          Math.max(1, deadline - Date.now()),
        );
        if (
          live &&
          process.env.WHIP_VOICE_API_TRACE &&
          !envelope.type.includes('audio')
        ) {
          fs.appendFileSync(
            path.join(output, 'trace.jsonl'),
            `${JSON.stringify(envelope)}\n`,
            { mode: 0o600 },
          );
        }
        checkError(envelope);
        const event = live
          ? envelope.type === 'response.event'
            ? envelope.event
            : null
          : envelope;
        if (!event) continue;
        if (event.type === 'response.created') {
          activeResponses.set(envelope.delegation_id, event.response.id);
        }
        // Live item events omit response_id. Attribute them to the response
        // opened by this delegation, matching Whip's native tracker.
        const responseId =
          event.response_id ||
          event.response?.id ||
          activeResponses.get(envelope.delegation_id);
        if (
          event.type === 'response.output_item.done' &&
          event.item?.type === 'function_call'
        ) {
          if (!responseId) throw new Error('Tool event has no response owner');
          const calls = completedCalls.get(responseId) || new Map();
          calls.set(event.item.call_id, event.item);
          completedCalls.set(responseId, calls);
        }
        if (
          ['response.output_text.delta', 'response.text.delta'].includes(
            event.type,
          )
        )
          text += event.delta;
        const terminal =
          event.type === (live ? 'response.completed' : 'response.done');
        if (!terminal) continue;
        if (!live && event.response.status !== 'completed')
          throw new Error(`Realtime response status: ${event.response.status}`);
        if (event.response.usage)
          report.usage.push({
            provider,
            scenario: scenario.id,
            usage: event.response.usage,
          });
        const callsById = completedCalls.get(event.response.id) || new Map();
        for (const item of event.response.output || []) {
          if (item.type === 'function_call') callsById.set(item.call_id, item);
        }
        completedCalls.delete(event.response.id);
        const calls = [...callsById.values()];
        if (calls.length === 0) {
          finished = true;
          break;
        }
        if (++rounds > 8)
          throw new Error(`Too many tool rounds for ${scenario.id}`);
        for (const call of calls) {
          let args;
          try {
            args = JSON.parse(call.arguments);
          } catch {
            throw new Error(`Invalid JSON from ${call.name}`);
          }
          const validator = validators.get(call.name);
          const callFailures = [];
          if (!validator || !validator(args))
            callFailures.push({
              name: call.name,
              arguments: args,
              validation: validator?.errors || 'Unknown tool',
            });
          if (args.workspace_id && !args.host_id)
            callFailures.push({
              name: call.name,
              arguments: args,
              validation: 'workspace_id requires host_id',
            });
          failures.push(...callFailures);
          report.calls.push({
            provider,
            scenario: scenario.id,
            name: call.name,
            arguments: args,
          });
          connection.send({
            type: live ? 'response.item.create' : 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: call.call_id,
              output: JSON.stringify(
                callFailures.length
                  ? {
                      error: 'invalid_argument',
                      guidance:
                        'Check the tool schema and provide valid arguments.',
                    }
                  : toolOutput(call.name, args),
              ),
            },
          });
        }
        connection.send({ type: 'response.create' });
      }
      if (!finished)
        throw new Error(`Scenario deadline exceeded: ${scenario.id}`);
      const observed = report.calls.slice(firstCall);
      const matching = observed.filter(call => call.name === scenario.name);
      if (matching.length === 0)
        failures.push({ validation: `Expected a fresh ${scenario.name} call` });
      if (scenario.scope)
        for (const call of matching) {
          for (const field of new Set([
            'host_id',
            'workspace_id',
            ...Object.keys(scenario.scope),
          ])) {
            const actual = call.arguments[field] || undefined;
            const expected = scenario.scope[field];
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              failures.push({
                name: call.name,
                arguments: call.arguments,
                validation: `Wrong ${field}; expected ${JSON.stringify(expected)}`,
              });
          }
        }
      const result = {
        provider,
        scenario: scenario.id,
        passed: failures.length === 0,
        calls: observed.length,
        failures,
        text: text.slice(0, 500),
      };
      report.scenarios.push(result);
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), {
        mode: 0o600,
      });
      log(
        `${provider} ${scenario.id}: ${result.passed ? 'PASS' : 'FAIL'} (${observed.length} calls)${failures.length ? ` ${JSON.stringify(failures)}` : ''}`,
      );
    }
  } catch (error) {
    const message = String(error.message).replaceAll(key, '[redacted]');
    report.errors.push({ provider, message });
    log(`${provider}: ERROR ${message}`);
  } finally {
    clearInterval(silenceTimer);
    if (live && connection.ws.readyState === WebSocket.OPEN) {
      connection.send({ type: 'session.close' });
      const deadline = Date.now() + 5000;
      try {
        while (Date.now() < deadline) {
          const event = await connection.next(deadline - Date.now());
          if (event.type === 'session.closed') break;
        }
      } catch {
        /* bounded cleanup */
      }
    }
    connection.close();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  }
}

async function main() {
  if (!process.env.WHIP_VOICE_API_CONTRACT)
    rustTest('realtime_voice::api_tools_tests::export_voice_api_contracts', {
      WHIP_VOICE_API_CONTRACT: contractPath,
    });
  const contract = JSON.parse(
    fs.readFileSync(
      process.env.WHIP_VOICE_API_CONTRACT || contractPath,
      'utf8',
    ),
  );
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        'packages/react-native-whip-ssh/rust/src/realtime_voice/models.json',
      ),
      'utf8',
    ),
  );
  const providers = process.env.WHIP_VOICE_API_MODELS?.split(',') || [
    catalog.defaultModel,
    ...catalog.models
      .map(model => model.id)
      .filter(model => model !== catalog.defaultModel),
    'gpt-live-1',
  ];
  for (const provider of providers) await runProvider(provider, contract);
  rustTest('reverse_control::voice::api_tests::validate_voice_api_arguments', {
    WHIP_VOICE_API_REPORT: reportPath,
  });
  const failed = report.scenarios.filter(scenario => !scenario.passed).length;
  log(
    `Report: ${reportPath}; ${report.scenarios.length - failed}/${report.scenarios.length} scenarios passed, ${report.calls.length} calls, ${report.errors.length} API errors`,
  );
  if (failed || report.errors.length) process.exitCode = 1;
}

main().catch(error => {
  log(error.message);
  process.exitCode = 1;
});
