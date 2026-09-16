import { errorCode } from './connectionErrors';

/** Display metadata only; Rust owns compatibility validation and wire normalization. */
export const HERDR_PROTOCOL_VERSIONS_LABEL = '17–22';

export function isHerdrProtocolMismatch(error: unknown): boolean {
  return errorCode(error) === 'HERDR_PROTOCOL_MISMATCH';
}
