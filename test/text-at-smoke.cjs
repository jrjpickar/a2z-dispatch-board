// Local smoke. Build first with node scripts/build-sandbox.mjs.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createContext, runInContext } = require('node:vm');

const html = readFileSync(join(__dirname, '../sandbox/schedule-text-sandbox.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert.match(html, /<select class="crew-text-mode" aria-label="Text at">/);
assert.match(html, /value="now"[\s\S]{0,80}>Now/);
assert.match(html, /value="custom"[\s\S]{0,80}>Pick a time/);
assert.match(html, /class="crew-text-time" type="time" step="900"/);
assert.match(html, /data-field="textMode"/);
assert.match(html, /connect-src 'none'/);

class TestElement {
  constructor(tag) { this.tag = tag; this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  prepend(node) { this.children.unshift(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelector(selector) { return nodes.get(selector.slice(1)); }
}
let start;
const ids = ['scheduleSandbox', 'sandbox-clock', 'sandbox-texts', 'sandbox-payloads', 'sandbox-activity', 'sandbox-jump', 'sandbox-run'];
const nodes = new Map(ids.map(id => [id, new TestElement('div')]));
const context = createContext({
  Response, URL, console,
  document: { body: new TestElement('body'), createElement: tag => new TestElement(tag),
    getElementById: id => nodes.get(id), addEventListener: (_, cb) => { start = cb; } }
});
runInContext(scripts[0], context);
start();
const items = id => nodes.get(id).children;
const allText = id => items(id).map(n => n.children.map(c => c.textContent).join('\n')).join('\n');
assert.equal(items('sandbox-texts').length, 7);
assert.match(allText('sandbox-texts'), /Ana Lopez \| 123 Main St/);
assert.match(allText('sandbox-texts'), /Ana Diaz \| 280 Juniper Ave/);
assert.match(allText('sandbox-texts'), /2:15 PM PT/);
assert.match(allText('sandbox-texts'), /Don't text/);
assert.match(allText('sandbox-texts'), /7:00 AM - 11:30 AM/);
assert.match(allText('sandbox-texts'), /12:30 PM - 4:00 PM/);
assert.match(allText('sandbox-texts'), /9:15 AM - 2:45 PM/);
assert.match(allText('sandbox-texts'), /Juan Lopez 4hr/);
assert.match(allText('sandbox-payloads'), /"action": "assign"/);
for (let i = 0; i < 4; i++) nodes.get('sandbox-jump').onclick();
assert.match(allText('sandbox-payloads'), /"action": "split_day_assign"/);
assert.equal(items('sandbox-payloads').length, 5);
assert.doesNotMatch(allText('sandbox-texts'), /Waiting/);
assert.ok(items('sandbox-activity').some(n => /custom.*text at/.test(n.textContent)));

async function post(path, body) {
  const res = await context.fetch(path, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}
(async () => {
  const worker = { id: 'worker-0', name: 'Ana Lopez', phone: '+12025550100' };
  await post('/api/shared-state', { action: 'remove', jobId: 'ghl', removedWorkers: [worker] });
  await post('/api/workflow-effect', { kind: 'workers', payload: { action: 'remove', jobId: 'ghl', removedWorkers: [{ workerName: worker.name, contactId: worker.id, workerPhone: worker.phone }] } });
  await post('/api/workflow-effect', { op: 'times_changed', jobId: 'split', resend: true, previous: { reportTime: '07:45' } });
  assert.match(allText('sandbox-payloads'), /"action": "remove"/);
  assert.match(allText('sandbox-payloads'), /"timesChanged": true/);
  assert.equal((await context.fetch('https://example.org')).status, 403);
  console.log('PASS: Text at control, offline clock, worker texts, Make payloads and activity.');
})().catch(error => { console.error(error); process.exitCode = 1; });
