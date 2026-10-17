import type { RuntimeTerminalSelection } from 'react-native-whip-ssh';
import { isUnknownRecord } from './unknown';

export function parseTerminalSelection(value: unknown): RuntimeTerminalSelection | null {
  if (!isUnknownRecord(value)) return null;
  const { columns, text, rows, startRow, startColumn, endRow, endColumn, offsetFromBottom } = value;
  const uint = (input: unknown, maximum: number): input is number =>
    typeof input === 'number' && Number.isInteger(input) && input >= 0 && input <= maximum;
  const maxColumn = 0xffff;
  const maxRow = 0xffffffff;
  if (!uint(columns, maxColumn) || columns === 0
    || typeof text !== 'string'
    || !Array.isArray(rows) || !rows.every((row: unknown): row is string => typeof row === 'string')
    || !uint(startRow, maxRow) || !uint(endRow, maxRow)
    || !uint(startColumn, columns) || !uint(endColumn, columns)
    || (offsetFromBottom !== null && !uint(offsetFromBottom, maxRow))) return null;
  return {
    columns, text, rows, startRow, startColumn, endRow, endColumn,
    offsetFromBottom: offsetFromBottom === null ? undefined : offsetFromBottom,
  };
}
