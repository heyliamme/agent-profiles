// The extension manifest and what the package ships.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const text = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('runs where the agents run: on the remote side in Remote, WSL and containers', () => {
  assert.deepEqual(pkg.extensionKind, ['workspace']);
});

test('settings are application-scoped, so a workspace cannot change them', () => {
  for (const [k, v] of Object.entries(pkg.contributes.configuration.properties)) assert.equal(v.scope, 'application', k);
});

test('Restricted Mode support is declared', () => {
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, 'limited');
  assert.match(pkg.capabilities.untrustedWorkspaces.description, /Restricted Mode/);
});

test('every command is registered in the code and documented in the README', () => {
  const src = text('src/extension.ts');
  const readme = text('README.md');
  for (const c of pkg.contributes.commands) {
    assert.ok(src.includes(`'${c.command}'`), `${c.command} registered`);
    assert.ok(readme.includes(c.title.replace('…', '')), `${c.title} in the README`);
  }
  for (const k of Object.keys(pkg.contributes.configuration.properties)) assert.ok(readme.includes(k), `${k} in the README`);
});

test('the package ships the third-party notices for what it bundles', () => {
  assert.match(text('.vscodeignore'), /^!ThirdPartyNotices\.txt$/m);
  const notices = text('ThirdPartyNotices.txt');
  const version = (name) => JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;
  for (const n of ['@decimalturn/toml-patch', 'jsonc-parser', '@vscode/codicons']) assert.ok(notices.includes(`${n} ${version(n)}`), `${n} version`);
  assert.match(notices, /Tim Hall/);
  assert.match(notices, /creativecommons\.org\/licenses\/by\/4\.0/);
});

test('bundled libraries are pinned to exact versions', () => {
  for (const n of ['@decimalturn/toml-patch', 'jsonc-parser', '@vscode/codicons']) assert.match(pkg.devDependencies[n], /^\d+\.\d+\.\d+$/, n);
});

test('the webview runs only its own script', () => {
  const panel = text('src/panel.ts');
  assert.match(panel, /default-src 'none'; style-src \$\{w\.cspSource\}; script-src 'nonce-\$\{nonce\}'/);
  assert.ok(!/innerHTML/.test(text('webview/main.ts')), 'the webview builds the DOM without innerHTML');
});

test('no telemetry and no network except Test connection', () => {
  for (const f of ['src/extension.ts', 'src/service.ts', 'src/panel.ts', 'src/statusBar.ts', 'src/store.ts', 'webview/main.ts']) {
    const s = text(f);
    assert.ok(!/telemetry|https?\.request|XMLHttpRequest|WebSocket/i.test(s.replace(/\/\/.*$/gm, '')), f);
  }
  const fetches = ['src/service.ts', 'src/panel.ts', 'src/extension.ts', 'webview/main.ts'].filter((f) => /\bfetch\b/.test(text(f).replace(/\/\/.*$/gm, '')));
  assert.deepEqual(fetches, ['src/service.ts']);
  assert.equal((text('src/service.ts').match(/^.*\bfetch\b.*$/gm) ?? []).length, 1, 'one line with fetch, in test()');
});
