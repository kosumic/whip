import {
  HERDR_PROTOCOL_VERSIONS_LABEL,
  isHerdrProtocolMismatch,
} from '../src/lib/herdrProtocol';

describe('Herdr protocol compatibility', () => {
  test('keeps only display metadata in React', () => {
    expect(HERDR_PROTOCOL_VERSIONS_LABEL).toBe('17–22');
  });

  test('recognizes the native runtime mismatch code', () => {
    const error = Object.assign(new Error('protocol mismatch'), {
      code: 'HERDR_PROTOCOL_MISMATCH',
      expected: HERDR_PROTOCOL_VERSIONS_LABEL,
      received: 16,
    });
    expect(isHerdrProtocolMismatch(error)).toBe(true);
    expect(isHerdrProtocolMismatch(new Error('connection lost'))).toBe(false);
  });
});
