import {
  terminalSubmissionWrites,
} from '../src/lib/terminalSubmission';

describe('terminal composer submission', () => {
  test('keeps each paste separate and writes whitespace and Enter in order', () => {
    expect(terminalSubmissionWrites([
      '\u001b[200~please inspect\u001b[201~',
      '\u001b[200~/remote/one.png\u001b[201~',
      '\u001b[200~/remote/two.png\u001b[201~',
    ])).toEqual([
      '\u001b[200~please inspect\u001b[201~',
      ' ',
      '\u001b[200~/remote/one.png\u001b[201~',
      ' ',
      '\u001b[200~/remote/two.png\u001b[201~',
      '\r',
    ]);
  });

  test('submits an empty composer as Enter only', () => {
    expect(terminalSubmissionWrites([])).toEqual(['\r']);
  });
});
