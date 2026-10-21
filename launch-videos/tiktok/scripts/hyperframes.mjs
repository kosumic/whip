import {spawnSync, execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const environment = {...process.env};
if (!environment.HYPERFRAMES_BROWSER_PATH) {
  for (const executable of ['brave', 'google-chrome', 'chromium', 'chromium-browser']) {
    try {
      environment.HYPERFRAMES_BROWSER_PATH = execFileSync('which', [executable], {encoding:'utf8', stdio:['ignore','pipe','ignore']}).trim();
      break;
    } catch { /* Try the next installed Chromium browser. */ }
  }
}
const result = spawnSync(process.execPath,
  [path.join(project, 'node_modules/hyperframes/bin/hyperframes.mjs'), ...process.argv.slice(2)],
  {cwd:project, env:environment, stdio:'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
