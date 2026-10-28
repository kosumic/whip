// Run only in the fixture's disposable pane. The same bytes feed both renderers.
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const mode = process.argv[2];
const cols = 80;
const text = mode === 'unicode' ? '中文 日本語 e\u0301 👩🏽‍💻 🙂 ' : '0123456789 abcdefghijklmnopqrstuvwxyz ';
(async () => {
  const start = Date.now();
  process.stdout.write('\x1b[?25l');
  if (mode === 'sparse') {
    process.stdout.write('\x1b[2J' + Array.from({ length: 23 }, (_, row) =>
      `\x1b[${row + 1};1HUNCHANGED ROW ${String(row).padStart(2, '0')} ${text}`).join(''));
  }
  for (let frame = 0; Date.now() - start < 8000; frame++) {
    if (mode === 'sparse') {
      process.stdout.write(`\x1b[12;1H${String(frame).padStart(6, '0')}`);
      await delay(16);
      continue;
    }
    const rows = [];
    for (let row = 0; row < 23; row++) {
      const label = `${String(frame).padStart(5, '0')} ${String(row).padStart(2, '0')} `;
      const body = mode === 'unicode' ? text.repeat(3) : text.repeat(3).slice(0, cols - label.length - 1);
      rows.push(`\x1b[${row + 1};1H\x1b[${31 + (row + frame) % 6}m${label}${body}\x1b[K`);
    }
    process.stdout.write(rows.join('') + '\x1b[0m');
    await delay(mode === 'unicode' ? 50 : 16);
  }
  process.stdout.write(`\x1b[?25h\x1b[24;1H${mode.toUpperCase()}_DONE\r\n`);
  if (process.argv[3]) fs.writeFileSync(process.argv[3], 'done');
})().catch(error => { console.error(error); process.exitCode = 1; });
