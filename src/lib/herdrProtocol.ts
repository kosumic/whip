import { errorCode } from './connectionErrors';

export function isHerdrProtocolMismatch(error: unknown): boolean {
  return errorCode(error) === 'HERDR_PROTOCOL_MISMATCH';
}
