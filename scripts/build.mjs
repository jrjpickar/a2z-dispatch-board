import { readFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
async function checkInlineScripts(htmlPath, label) {
  const html = await readFile(new URL(`../${htmlPath}`, import.meta.url), 'utf8');
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) new Script(script[1], { filename: `${label} (inline script)` });
}
await checkInlineScripts('index.html', 'index.html');
await checkInlineScripts('driver-app/index.html', 'driver-app/index.html');
for (const directory of ['lib', 'netlify/functions']) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
for (const file of await readdir('make-blueprints')) if (file.endsWith('.json')) JSON.parse(await readFile(`make-blueprints/${file}`, 'utf8'));
JSON.parse(await readFile('driver-app/manifest.webmanifest', 'utf8'));
await mkdir('public', { recursive: true });
await copyFile('index.html', 'public/index.html');
await mkdir('public/driver', { recursive: true });
for (const file of await readdir('driver-app')) await copyFile(`driver-app/${file}`, `public/driver/${file}`);
console.log('Dashboard, driver app, functions, and blueprint syntax checked; public/index.html and public/driver/ ready.');
