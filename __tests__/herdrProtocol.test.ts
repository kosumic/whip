import { isHerdrProtocolMismatch } from '../src/lib/herdrProtocol';

describe('Herdr protocol compatibility', () => {
  test('recognizes the native runtime mismatch code', () => {
    const error = Object.assign(new Error('protocol mismatch'), {
      code: 'HERDR_PROTOCOL_MISMATCH',
    });
    expect(isHerdrProtocolMismatch(error)).toBe(true);
    expect(isHerdrProtocolMismatch(new Error('connection lost'))).toBe(false);
  });
});
