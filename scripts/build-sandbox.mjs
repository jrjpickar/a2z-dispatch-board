// From the repo root run node scripts/build-sandbox.mjs, then open the output locally.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
// The board runs as a classic script. Wrap each source module to preserve its scope.
// State and logistics booking share a wrapper because they import each other.
async function inject(files, prefix = '') {
  const source = (await Promise.all(files.map(read))).join('\n');
  const names = [...source.matchAll(/^export (?:async )?(?:const|function|class) (\w+)/gm)].map(m => m[1]);
  const body = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  return `(() => {\n${prefix}\n${body}\nreturn { ${names.join(', ')} };\n})()`;
}

const core = [
  'const process = { env: {} };',
  'const gateway = ' + await inject(['lib/ghl.mjs']),
  'const sms = ' + await inject(['lib/crew-text.mjs'], 'const { ghl } = gateway;'),
  'const state = ' + await inject(['lib/state.mjs', 'lib/logistics-booking.mjs'], 'const { effectiveWorkerTimes, identityRank, matchWorker } = sms;'),
  'const activity = ' + await inject(['lib/activity.mjs']),
  'const dispatch = ' + await inject(['lib/daily-dispatch.mjs'], [
    'const { pacificToUtc, toE164, identityRank, matchWorker, effectiveWorkerTimes, ensureTable: ensureTextTables, fillScheduleState } = sms;',
    'const { StateError } = state;',
    'const { scheduleActivity, logActivity } = activity;',
    "const deliverEffect = () => { throw new Error('Live delivery disabled in sandbox'); };"
  ].join('\n'))
].join(';\n');

const mock = await read('sandbox/mock.mjs');
const code = `(() => {\n${core};\n${mock}\n})();`;
new Script(code);
const html = (await read('index.html'))
  .replace(/<link\b[^>]*https?:[^>]*>\s*/ig, '')
  .replace('<head>', '<head>\n<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; form-action \'none\'; frame-src \'none\'">')
  .replace('<script>', () => '<script>\n' + code.replace(/<\/script/gi, '<\\/script') + '\n</script>\n<script>')
  .replaceAll(String.fromCharCode(8211), '-').replaceAll(String.fromCharCode(8212), ' - ');
await mkdir(new URL('../sandbox/', import.meta.url), { recursive: true });
await writeFile(new URL('../sandbox/schedule-text-sandbox.html', import.meta.url), html);
