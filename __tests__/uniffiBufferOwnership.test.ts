import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';

const core = require('@ubjs/core') as typeof import('@ubjs/core');
const bindingsPath = resolve(
  __dirname,
  '../packages/react-native-whip-ssh/src/generated/whip_ssh.ts',
);
// Exercise the generated callback closures, with a native allocation ledger in
// place of JSI. No React Native wrapper or converter is mocked.
const compiledBindings = transpileModule(readFileSync(bindingsPath, 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ESNext },
}).outputText;

function bridge() {
  const allocations = new Set<Uint8Array>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const own = (bytes: Uint8Array) => {
    allocations.add(bytes);
    return bytes;
  };
  const free = jest.fn((bytes: Uint8Array) => {
    if (!allocations.delete(bytes))
      throw new Error('Buffer freed twice or by the wrong owner');
    bytes.fill(0);
  });
  let sinkHandle = 0n;
  let terminalSinkHandle = 0n;
  let deliverySinkHandle = 0n;
  let asyncResult: Uint8Array = new Uint8Array();
  const native = {
    rustbuffer_alloc: (size: number) => own(new Uint8Array(size)),
    rustbuffer_free: free,
    ubrn_uniffi_internal_fn_func_ffi__string_to_buffer: (value: string) =>
      own(encoder.encode(value)),
    ubrn_uniffi_internal_fn_func_ffi__string_to_byte_length: (value: string) =>
      encoder.encode(value).length,
    ubrn_uniffi_internal_fn_func_ffi__read_string_from_buffer: (
      buffer: { arrayBuffer: ArrayBuffer },
      offset: number,
      length: number,
    ) => decoder.decode(new Uint8Array(buffer.arrayBuffer, offset, length)),
    ubrn_uniffi_whip_ssh_fn_func_set_event_sink: (handle: bigint) => {
      sinkHandle = handle;
    },
    ubrn_uniffi_whip_ssh_fn_func_set_herdr_terminal_event_sink: (
      handle: bigint,
    ) => {
      terminalSinkHandle = handle;
    },
    ubrn_uniffi_whip_ssh_fn_func_execute_ssh_command: (
      key: Uint8Array,
      command: Uint8Array,
    ) => {
      // These arguments transfer ownership to Rust, which consumes them.
      free(key);
      free(command);
      return 1n;
    },
    ubrn_uniffi_whip_ssh_fn_func_set_terminal_delivery_event_sink: (handle: bigint) => { deliverySinkHandle = handle; },
    ubrn_uniffi_whip_ssh_fn_func_acknowledge_terminal_delivery_batch: jest.fn(),
    ubrn_ffi_whip_ssh_rust_future_poll_rust_buffer: (
      _future: bigint,
      callback: (handle: bigint, status: number) => void,
      handle: bigint,
    ) => callback(handle, 0),
    ubrn_ffi_whip_ssh_rust_future_complete_rust_buffer: () => asyncResult,
    ubrn_ffi_whip_ssh_rust_future_cancel_rust_buffer: jest.fn(),
    ubrn_ffi_whip_ssh_rust_future_free_rust_buffer: jest.fn(),
  };
  const moduleExports: Record<string, unknown> = {};
  runInNewContext(
    `${compiledBindings}\nexports.callbacks = uniffiCallbackInterfaceWhipSshEventSink.vtable;\nexports.terminalCallbacks = uniffiCallbackInterfaceHerdrTerminalEventSink.vtable;\nexports.deliveryCallbacks = uniffiCallbackInterfaceTerminalDeliveryEventSink.vtable;\nexports.deliveryRecordConverter = FfiConverterTypeTerminalDeliveryBatch;`,
    {
      exports: moduleExports,
      require: (name: string) => {
        if (name === '@ubjs/core') return core;
        if (name === './whip_ssh-ffi')
          return { __esModule: true, default: () => native };
        throw new Error(`Unexpected generated import: ${name}`);
      },
      TextEncoder,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      DataView,
      setTimeout,
      clearTimeout,
      process,
    },
  );
  const bindings =
    moduleExports as typeof import('../packages/react-native-whip-ssh/src/generated/whip_ssh') & {
      callbacks: {
        emit: (
          handle: bigint,
          event: Uint8Array,
        ) => { code: number; errorBuf?: Uint8Array };
        unix_socket_channel_data: (
          handle: bigint,
          key: Uint8Array,
          id: Uint8Array,
          data: Uint8Array,
        ) => { code: number };
      };
      terminalCallbacks: {
        terminal_frame: (
          handle: bigint,
          clientKey: Uint8Array,
          terminalId: Uint8Array,
          sequence: bigint,
          width: number,
          height: number,
          full: number,
          base64Bytes: Uint8Array,
        ) => { code: number };
      };
      deliveryCallbacks: { ready: (handle: bigint, client: Uint8Array, terminal: Uint8Array, generation: bigint, batch: Uint8Array) => { code: number; errorBuf?: Uint8Array } };
      deliveryRecordConverter: { lower: (value: import('../packages/react-native-whip-ssh/src/generated/whip_ssh').TerminalDeliveryBatch, alloc: (size: number) => Uint8Array) => Uint8Array };
    };
  const sink = {
    emit: jest.fn(),
    unixSocketChannelData: jest.fn(),
    execChannelData: jest.fn(),
  };
  bindings.setEventSink(sink);
  const terminalSink = {
    terminalFrame: jest.fn(),
    graphicsFrame: jest.fn(),
    control: jest.fn(),
  };
  bindings.setHerdrTerminalEventSink(terminalSink);
  return {
    allocations,
    free,
    own,
    native,
    bindings,
    sink,
    terminalSink,
    deliveryHandle: () => deliverySinkHandle,
    terminalHandle: terminalSinkHandle,
    handle: sinkHandle,
    string: (value: string) => own(encoder.encode(value)),
    asyncResult: (value: string) => {
      asyncResult = own(encoder.encode(value));
    },
  };
}

test('repeated native callbacks release every incoming Rust buffer', () => {
  const b = bridge();
  for (let index = 0; index < 100; index += 1) {
    expect(b.bindings.callbacks.emit(b.handle, b.string('event'))).toEqual({
      code: 0,
    });
  }
  expect(b.sink.emit).toHaveBeenCalledTimes(100);
  expect(b.allocations.size).toBe(0);
});

test('pushed batches and reentrant numeric completion credits release every buffer', () => {
  const b = bridge();
  const saved: string[] = [];
  b.bindings.setTerminalDeliveryEventSink({
    ready(client, terminal, generation, batch) {
      expect([client, terminal]).toEqual(['host', 'pane']);
      saved.push(batch.json);
      b.bindings.acknowledgeTerminalDeliveryBatch(generation, BigInt(batch.batchId));
    },
  });
  for (let index = 0; index < 100; index += 1) {
    const packet = b.bindings.deliveryRecordConverter.lower(
      { batchId: String(index), json: `packet-${index}`, payloadBytes: 10, chunkCount: 1 }, b.native.rustbuffer_alloc,
    );
    expect(b.bindings.deliveryCallbacks.ready(b.deliveryHandle(), b.string('host'), b.string('pane'), 1n, packet)).toEqual({ code: 0 });
    expect(b.allocations.size).toBe(0);
  }
  expect(saved[0]).toBe('packet-0');
  expect(saved[99]).toBe('packet-99');
  expect(b.native.ubrn_uniffi_whip_ssh_fn_func_acknowledge_terminal_delivery_batch).toHaveBeenLastCalledWith(1n, 99n, expect.any(Object));
});

test('a throwing batch consumer releases its record and transfers only the callback error to Rust', () => {
  const b = bridge();
  b.bindings.setTerminalDeliveryEventSink({ ready() { throw new Error('renderer detached'); } });
  const packet = b.bindings.deliveryRecordConverter.lower(
    { batchId: '1', json: 'packet', payloadBytes: 6, chunkCount: 1 }, b.native.rustbuffer_alloc,
  );
  const result = b.bindings.deliveryCallbacks.ready(b.deliveryHandle(), b.string('host'), b.string('pane'), 1n, packet);
  expect(result.code).toBe(2);
  expect(b.allocations.size).toBe(1);
  b.free(result.errorBuf!);
  expect(b.allocations.size).toBe(0);
});

test('continuous terminal output releases frame payloads and preserves primitive arguments', () => {
  const b = bridge();
  const frame = 'AA=='.repeat(4096);
  for (let sequence = 0n; sequence < 100n; sequence += 1n) {
    expect(
      b.bindings.terminalCallbacks.terminal_frame(
        b.terminalHandle,
        b.string('host'),
        b.string('terminal'),
        sequence,
        120,
        40,
        sequence === 0n ? 1 : 0,
        b.string(frame),
      ).code,
    ).toBe(0);
  }
  expect(b.terminalSink.terminalFrame).toHaveBeenLastCalledWith(
    'host',
    'terminal',
    99n,
    120,
    40,
    false,
    frame,
  );
  expect(b.free).toHaveBeenCalledTimes(300);
  expect(b.allocations.size).toBe(0);
});

test('callback byte arrays remain valid after all three incoming buffers are freed', () => {
  const b = bridge();
  const payload = core.FfiConverterArrayBuffer.lower(
    new Uint8Array([1, 2, 3]).buffer,
    b.native.rustbuffer_alloc,
  );
  expect(
    b.bindings.callbacks.unix_socket_channel_data(
      b.handle,
      b.string('host'),
      b.string('channel'),
      payload,
    ).code,
  ).toBe(0);
  const [key, id, data] = b.sink.unixSocketChannelData.mock.calls[0];
  expect([key, id]).toEqual(['host', 'channel']);
  expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3]));
  expect(b.allocations.size).toBe(0);
});

test('throwing callbacks still release incoming buffers while transferring the error to Rust', () => {
  const b = bridge();
  b.sink.emit.mockImplementation(() => {
    throw new Error('callback failed');
  });
  const result = b.bindings.callbacks.emit(b.handle, b.string('event'));
  expect(result.code).toBe(2);
  expect(result.errorBuf).toBeDefined();
  // The callback error belongs to Rust, which consumes the returned error buffer.
  b.free(result.errorBuf!);
  expect(b.allocations.size).toBe(0);
});

test('asynchronous Rust results release their buffer after decoding', async () => {
  const b = bridge();
  b.asyncResult('remote output');
  await expect(b.bindings.executeSshCommand('host', 'pwd')).resolves.toBe(
    'remote output',
  );
  expect(
    b.native.ubrn_ffi_whip_ssh_rust_future_free_rust_buffer,
  ).toHaveBeenCalledWith(1n);
  expect(b.allocations.size).toBe(0);
});
