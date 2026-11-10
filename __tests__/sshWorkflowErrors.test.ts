import { TextEncoder } from 'node:util';
import bindings, { SshWorkflowError } from '../packages/react-native-whip-ssh/src/generated/whip_ssh';

jest.mock('../packages/react-native-whip-ssh/src/generated/whip_ssh-ffi', () => ({
  __esModule: true,
  default: () => ({
    ubrn_uniffi_internal_fn_func_ffi__read_string_from_buffer: (
      buffer: { arrayBuffer: ArrayBuffer }, offset: number, length: number,
    ) => Buffer.from(buffer.arrayBuffer, offset, length).toString('utf8'),
  }),
}));

// UniFFI flat errors carry a variant ordinal followed by the Rust Display string.
// Decode native error payloads through the real generated converter.
const ERROR_ORDINALS = { Timeout: 8, OutcomeUnknown: 9, Pairing: 10, Installation: 11 } as const;

function nativeError(tag: keyof typeof ERROR_ORDINALS, message: string) {
  const text = new TextEncoder().encode(message);
  const bytes = new Uint8Array(8 + text.length);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, ERROR_ORDINALS[tag]);
  view.setInt32(4, text.length);
  bytes.set(text, 8);
  return bindings.converters.FfiConverterTypeSshWorkflowError.lift(bytes);
}

test.each([
  ['Pairing', 'No route to host (os error 113)'],
  ['Pairing', 'temporary SSH authentication failed'],
  ['Pairing', 'enrollment refused (denied): 用户拒绝了配对'],
  ['Installation', 'Permission denied (os error 13)'],
  ['Timeout', 'SSH operation timed out'],
  ['OutcomeUnknown', 'The remote change may have completed (operation abc). Check the host before trying again.'],
] as const)('native %s errors retain their reason: %s', (tag, reason) => {
  const error = nativeError(tag, reason);
  expect(SshWorkflowError[tag].instanceOf(error)).toBe(true);
  expect(error.message).toBe(`SshWorkflowError.${tag}: ${reason}`);
  expect(String(error)).toContain(reason);
});
