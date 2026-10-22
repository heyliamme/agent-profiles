// End-to-end: installs the packaged extension into a throwaway VS Code profile and uses it
// as a person would: the profiles editor, presets, validation, Test connection, the diff
// preview, the status bar, restore, import, terminals, export, Reload Window, then a second
// window in Restricted Mode. Linux, with `code` on PATH.
//
// Nothing here touches the real ~/.claude, ~/.codex or keyring: HOME, CLAUDE_CONFIG_DIR and
// CODEX_HOME point into a temporary folder, secret storage uses VS Code's basic store inside
// the throwaway profile, and Test connection talks to a stub server on 127.0.0.1.
//
//   npm run package && node test/e2e/run.mjs [agent-profiles-x.y.z.vsix]
//   E2E_SHOTS=images node test/e2e/run.mjs   # also writes the README screenshots there
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import path from 'path';
import { VSCode, waitFor } from './vscode.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const vsix = path.resolve(process.argv[2] || `${pkg.name}-${pkg.version}.vsix`);
if (!existsSync(vsix)) throw new Error(`${vsix} not found: run npm run package first`);
const shotsFor = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : undefined;

const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'agent-profiles-e2e-')));
const out = path.join(root, 'shots');
mkdirSync(out);

// Fake keys, unique enough to grep for afterwards.
const CLAUDE_KEY = 'sk-e2e-claude-FAKEKEY-7f3a9c21d4e5b6a7';
const CODEX_KEY = 'sk-e2e-codex-FAKEKEY-0b1c2d3e4f5a6b7c';

// ---- A stub provider -----------------------------------------------------------------
const hits = [];
const server = createServer((req, res) => {
  hits.push({ url: req.url, auth: req.headers.authorization, version: req.headers['anthropic-version'] });
  const reply = (status, body) => setTimeout(() => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(body))), 40);
  if (req.url === '/api/v1/models') return req.headers.authorization === `Bearer ${CLAUDE_KEY}` ? reply(200, { data: [{ id: 'gw-sonnet' }, { id: 'gw-haiku' }] }) : reply(401, { error: { message: 'bad key' } });
  if (req.url === '/v1/models') return req.headers.authorization === `Bearer ${CODEX_KEY}` ? reply(200, { data: [{ id: 'gw-codex-1' }] }) : reply(401, { error: { message: 'bad key' } });
  reply(404, { error: { message: 'not found' } });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const stub = `http://127.0.0.1:${server.address().port}`;

// ---- A home folder with both agents set up -------------------------------------------
function makeHome(dir) {
  const home = path.join(dir, 'home');
  const claudeDir = path.join(home, '.claude-work'); // through CLAUDE_CONFIG_DIR
  const codexDir = path.join(home, 'codex-home'); // through CODEX_HOME
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] }, env: { MY_OWN_VAR: 'keep me' }, includeCoAuthoredBy: false }, null, 2) + '\n');
  writeFileSync(
    path.join(codexDir, 'config.toml'),
    `# My Codex setup
model = "gw-codex-1"
model_provider = "local"
approval_policy = "on-request"

[mcp_servers.docs]
command = "npx"   # keep this
args = ["-y", "docs-server"]

[model_providers.local]
name = "Local gateway"
base_url = "${stub}/v1"
env_key = "LOCAL_KEY"
`,
  );
  writeFileSync(path.join(codexDir, '.env'), `OTHER=1\nLOCAL_KEY=${CODEX_KEY}\n`);
  return { home, claudeDir, codexDir, env: { HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir } };
}
const H = makeHome(root);
const settingsFile = path.join(H.claudeDir, 'settings.json');
const codexFile = path.join(H.codexDir, 'config.toml');
const ws = path.join(root, 'project');
mkdirSync(ws);
writeFileSync(path.join(ws, 'README.md'), '# A project\n');

const settings = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'window.restoreWindows': 'none',
  'extensions.autoUpdate': false,
  'telemetry.telemetryLevel': 'off',
  'chat.disableAIFeatures': true,
  'window.dialogStyle': 'custom',
  'files.simpleDialog.enable': true,
  'workbench.tips.enabled': false,
  'editor.minimap.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'window.menuStyle': 'custom',
  'terminal.integrated.shellIntegration.enabled': false,
  'terminal.integrated.defaultProfile.linux': 'sh',
  'terminal.integrated.profiles.linux': { sh: { path: '/bin/sh' } },
};
let vs = new VSCode(root, H.env);
vs.install(vsix, settings);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failed = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    if (await vs.quickInputVisible().catch(() => false)) await vs.key('Escape');
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed.push(name);
    const file = path.join(out, `${failed.length}-${name.replace(/\W+/g, '-')}.png`);
    await vs.screenshot(file).catch(() => {});
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}\n      screenshot: ${file}`);
  }
}
const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const eq = (a, b, what) => ok(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

let ctx;
const w = (expr) => vs.eval(expr, ctx);
const until = (expr, what, timeout) => waitFor(() => w(expr), { what, timeout });
const W = {
  click: (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('not found: ' + ${JSON.stringify(sel)}); e.click(); return true; })()`,
  fill: (id, v) => `(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) throw new Error('no #' + ${JSON.stringify(id)}); e.focus(); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
  value: (id) => `document.getElementById(${JSON.stringify(id)})?.value`,
  text: (sel) => `document.querySelector(${JSON.stringify(sel)})?.textContent ?? ''`,
  profiles: `[...document.querySelectorAll('button.profile .pname')].map((e) => e.textContent.trim())`,
  heading: `document.getElementById('name')?.value ?? document.querySelector('.main h1')?.textContent`,
};

async function focusWorkbench() {
  await vs.clickElement(`document.querySelector('.part.statusbar')`);
}
async function shotOfEditor(file) {
  const r = await vs.eval(`(() => { const b = document.querySelector('.part.editor').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
  const { data } = await vs.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
  writeFileSync(file, Buffer.from(data, 'base64'));
}
async function closeAll() {
  await vs.command('View: Close All Editors');
  await waitFor(async () => (await vs.editorTabs()).length === 0, { what: 'editors to close' });
}
/** Runs a command that opens a quick pick or input of its own: doesn't wait for it to close. */
async function paletteRun(title) {
  if (await vs.quickInputVisible()) await vs.key('Escape');
  await waitFor(async () => !(await vs.quickInputVisible()), { what: 'quick input to close' });
  await vs.key('F1');
  await waitFor(async () => (await vs.quickInputVisible()) && (await vs.quickInputValue()).startsWith('>'), { what: 'command palette' });
  await vs.type(title);
  await sleep(500);
  await vs.key('Enter');
  await sleep(600);
}
async function notification(text, timeout = 10000) {
  return waitFor(async () => (await vs.notifications()).find((n) => n.includes(text)), { what: `notification "${text}"`, timeout });
}
/** The status bar item of an agent, by its accessible label. */
const statusItem = (agent) => `[...document.querySelectorAll('.statusbar-item, .statusbar-item a')].find((e) => (e.getAttribute('aria-label') || '').startsWith(${JSON.stringify(agent + ' profile')}))`;
async function statusText(agent) {
  return vs.eval(`(() => { const e = ${statusItem(agent)}; return e ? (e.closest('.statusbar-item') ?? e).textContent.trim() : null; })()`);
}
async function diffText() {
  return vs.eval(`document.querySelector('.monaco-diff-editor')?.innerText.replace(/\\u00a0/g, ' ') ?? ''`);
}
async function openProfiles() {
  await vs.command('Agent Profiles: Open Profiles');
  ctx = await vs.webview();
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const storage = () => path.join(root, 'user-data', 'User', 'globalStorage', 'heyliam.agent-profiles');

try {
  await vs.launch(ws);
  await sleep(1500);

  await step('no profiles yet: no status bar item, and the editor opens on its welcome page', async () => {
    eq(await statusText('Claude Code'), null, 'status bar');
    await openProfiles();
    await until(`!!document.querySelector('.welcome')`, 'welcome');
  });

  await step('a Claude Code profile from a preset: the form is filled in', async () => {
    await w(W.click('#new-claude-code'));
    await until(`!!document.getElementById('preset-anthropic-gateway')`, 'presets');
    await w(W.click('#preset-anthropic-gateway'));
    await until(`document.getElementById('name')?.value === 'Anthropic-compatible gateway'`, 'the new profile');
    eq(await w(W.value('f-baseUrl')), 'https://', 'base URL placeholder');
    eq(await w(`document.getElementById('mode-terminal').checked`), true, 'key mode');
    eq(await w(`document.getElementById('f-disableTraffic').checked`), true, 'flag from the preset');
  });

  await step('validation lists what to fix, and nothing is applied', async () => {
    await w(W.click('#apply'));
    await until(`!!document.getElementById('issues')`, 'issue list');
    const t = await w(W.text('#issues'));
    ok(/Base URL: Enter a full http/.test(t), t);
    ok(/Key or token: Enter the key or token/.test(t), t);
    eq(await w(`document.getElementById('f-baseUrl').getAttribute('aria-invalid')`), 'true', 'aria-invalid');
    eq((await vs.editorTabs()).filter((x) => x.includes('now ↔')), [], 'no preview');
  });

  await step('editing the form: name, address, models, key', async () => {
    await w(W.fill('name', 'Work gateway'));
    await w(W.fill('f-baseUrl', `${stub}/api`));
    await w(W.fill('f-model', 'sonnet'));
    await w(W.fill('f-haikuModel', 'gw-haiku'));
    await w(W.fill('secret', CLAUDE_KEY));
    await until(`!document.getElementById('issues')`, 'issues cleared');
    eq(await w(`document.querySelector('.badge.dirty') !== null`), true, 'unsaved badge');
    // Going back to the same profile (its entry, or from "New profile") keeps the edits and the key.
    const pid = await w(`document.querySelector('.profile.current').id`);
    await w(W.click(`#${pid}`));
    eq([await w(W.value('f-baseUrl')), await w(W.value('secret'))], [`${stub}/api`, CLAUDE_KEY], 'kept after clicking the same profile');
    await w(W.click('#new-claude-code'));
    await until(`document.querySelector('.preset') !== null`, 'preset chooser');
    await w(W.click(`#${pid}`));
    await until(`document.getElementById('f-baseUrl')?.value === ${JSON.stringify(`${stub}/api`)}`, 'form back');
    eq(await w(W.value('secret')), CLAUDE_KEY, 'key kept after New profile and back');
  });

  await step('Test connection reaches the stub with the key, shows latency and suggests its models', async () => {
    const before = hits.length;
    await w(W.click('#test'));
    await until(`document.getElementById('test-result')?.textContent.includes('Connected')`, 'test result');
    const t = await w(W.text('#test-result'));
    ok(/HTTP 200 · \d+ ms/.test(t), t);
    ok(t.includes('2 models listed'), t);
    // The second ask, without the key, tells a public models list from one that checked it.
    eq(hits.slice(before).map((h) => [h.url, h.auth === `Bearer ${CLAUDE_KEY}`, h.version]), [['/api/v1/models', true, '2023-06-01'], ['/api/v1/models', false, '2023-06-01']], 'requests');
    eq(await w(`document.querySelector('.badge.dirty') !== null`), true, 'Test connection did not save the form');
    eq(await w(`[...document.querySelectorAll('#models-claude-code option')].map((o) => o.value)`), ['gw-sonnet', 'gw-haiku'], 'datalist');
    ok(!(await w(`document.body.innerText.includes(${JSON.stringify(CLAUDE_KEY)})`)), 'the key is not shown in the page');
  });

  await step('saving keeps the key masked; the eye button reveals it on demand', async () => {
    await w(W.click('#save'));
    await until(`document.getElementById('secret-status')?.textContent.includes('Saved in secret storage (••••••••b6a7)')`, 'masked key');
    eq(await w(W.value('secret')), '', 'the field is empty after saving');
    eq(await w(W.profiles), ['Work gateway'], 'profile list');
    await w(W.click('#reveal'));
    await until(`document.getElementById('secret')?.value === ${JSON.stringify(CLAUDE_KEY)} && document.getElementById('secret').type === 'text'`, 'revealed');
    await w(W.click('#reveal'));
    await until(`document.getElementById('secret')?.type === 'password' && document.getElementById('secret').value === ''`, 'hidden again');
  });

  await step('apply: a diff with the key hidden, then the file is merged, written and backed up', async () => {
    await w(W.click('#mode-config'));
    await until(`document.querySelector('label.radio.checked')?.textContent.includes('In settings.json')`, 'mode');
    await w(W.click('#apply'));
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.includes('settings.json: now ↔ "Work gateway"')), { what: 'diff preview' });
    await notification('Apply "Work gateway" to ~/.claude-work/settings.json?');
    ok((await notification('Apply "Work gateway"')).includes('plain text'), 'plain-text warning');
    await sleep(800);
    const diff = await diffText();
    ok(diff.includes('ANTHROPIC_BASE_URL') && diff.includes('••••••••b6a7'), `masked diff: ${diff.slice(0, 300)}`);
    ok(!diff.includes(CLAUDE_KEY), 'no key in the diff');
    eq(readJson(settingsFile).env, { MY_OWN_VAR: 'keep me' }, 'nothing written before Apply');
    if (shotsFor) await shotOfEditor(path.join(shotsFor, 'preview-dark.png'));
    await vs.dialogButton('Apply');
    await waitFor(() => readJson(settingsFile).env?.ANTHROPIC_BASE_URL === `${stub}/api`, { what: 'settings.json written' });
    const j = readJson(settingsFile);
    eq(j.permissions, { allow: ['Bash(npm test:*)'] }, 'unrelated keys kept');
    eq(j.includeCoAuthoredBy, false, 'unrelated keys kept');
    const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    eq(sorted(j.env), sorted({ MY_OWN_VAR: 'keep me', ANTHROPIC_BASE_URL: `${stub}/api`, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gw-haiku', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_AUTH_TOKEN: CLAUDE_KEY }), 'env');
    eq(j.model, 'sonnet', 'model');
    await waitFor(async () => !(await vs.editorTabs()).some((t) => t.includes('now ↔')), { what: 'preview closed' });
    const backups = readdirSync(path.join(storage(), 'backups', 'claude-code'));
    eq(backups.filter((f) => f.endsWith('.bak')).length, 1, 'one backup');
    eq(statSync(path.join(storage(), 'backups', 'claude-code', backups.find((f) => f.endsWith('.bak')))).mode & 0o777, 0o600, 'backup permissions');
  });

  await step('the status bar shows the active profile and model', async () => {
    await waitFor(async () => (await statusText('Claude Code'))?.includes('Claude: Work gateway · sonnet'), { what: 'status bar item' });
    eq(await statusText('Codex CLI'), null, 'no Codex item without Codex profiles');
    ctx = await vs.webview();
    await until(`document.querySelector('button.profile .badge.active') !== null`, 'active badge in the list');
    if (shotsFor) {
      await w(W.click('#test'));
      await until(`document.getElementById('test-result')?.textContent.includes('Connected')`, 'test');
      await w(`(document.getElementById('test').blur(), document.scrollingElement.scrollTo(0, 0), true)`);
      await vs.clearNotifications();
      await sleep(600);
      await shotOfEditor(path.join(shotsFor, 'profile-dark.png'));
      const userSettings = path.join(root, 'user-data', 'User', 'settings.json');
      writeFileSync(userSettings, JSON.stringify({ ...settings, 'workbench.colorTheme': 'Default Light Modern' }, null, 2));
      await sleep(2000);
      await vs.clearNotifications();
      await shotOfEditor(path.join(shotsFor, 'profile-light.png'));
      writeFileSync(userSettings, JSON.stringify(settings, null, 2));
      await sleep(1500);
    }
  });

  await step('a second profile, and switching to it from the status bar', async () => {
    await paletteRun('Agent Profiles: New Profile');
    await vs.pickQuickItem('Claude Code');
    await vs.pickQuickItem('Anthropic (sign in)');
    ctx = await vs.webview();
    await until(`document.getElementById('name')?.value === 'Anthropic (sign in)'`, 'second profile');
    await focusWorkbench();
    await vs.clickElement(statusItem('Claude Code'));
    await waitFor(() => vs.quickInputVisible(), { what: 'switcher' });
    const items = await vs.eval(`[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map((r) => r.textContent)`);
    ok(items.some((t) => t.includes('Work gateway') && t.includes('active')), JSON.stringify(items));
    if (shotsFor) await vs.screenshot(path.join(shotsFor, 'switch-dark.png'));
    await vs.pickQuickItem('Anthropic (sign in)');
    await notification('Apply "Anthropic (sign in)"');
    const diff = await diffText();
    ok(!diff.includes(CLAUDE_KEY), 'no key in the diff');
    await vs.dialogButton('Apply');
    await waitFor(() => !readJson(settingsFile).env?.ANTHROPIC_BASE_URL, { what: 'switched' });
    eq(readJson(settingsFile), { permissions: { allow: ['Bash(npm test:*)'] }, env: { MY_OWN_VAR: 'keep me' }, includeCoAuthoredBy: false }, 'everything the gateway profile wrote is gone, the rest kept');
    await waitFor(async () => (await statusText('Claude Code'))?.includes('Claude: Anthropic (sign in) · default model'), { what: 'status bar after switch' });
  });

  await step('Restore Previous Config puts the file back as it was before the switch', async () => {
    await paletteRun('Agent Profiles: Restore Previous Config');
    await vs.pickQuickItem('Claude Code');
    await vs.pickQuickItem('before: Apply "Anthropic (sign in)"');
    await notification('Restore ~/.claude-work/settings.json');
    ok((await diffText()).includes('••••••••b6a7'), 'masked restore preview');
    await vs.dialogButton('Restore');
    await waitFor(() => readJson(settingsFile).env?.ANTHROPIC_AUTH_TOKEN === CLAUDE_KEY, { what: 'restored' });
    await waitFor(async () => (await statusText('Claude Code'))?.includes('Work gateway'), { what: 'status bar after restore' });
  });

  await step('a change made while the preview is open is not overwritten', async () => {
    await openProfiles();
    await w(W.click('button.profile'));
    await until(`document.getElementById('name')?.value === 'Work gateway'`, 'Work gateway selected');
    await w(W.fill('f-model', 'opus'));
    await w(W.click('#apply'));
    await notification('Apply "Work gateway"');
    const j = readJson(settingsFile);
    writeFileSync(settingsFile, JSON.stringify({ ...j, editedElsewhere: true }, null, 2));
    await vs.dialogButton('Apply');
    await notification('changed while the preview was open. Nothing was written.');
    await vs.dialogButton('Cancel');
    const after = readJson(settingsFile);
    eq([after.editedElsewhere, after.model], [true, 'sonnet'], 'the outside edit survived, nothing written');
    await vs.clearNotifications();
  });

  await step('project scope: Apply writes the workspace file, compares against it, and keeps the key out of Git', async () => {
    execFileSync('git', ['init', '-q'], { cwd: ws, env: { ...process.env, ...H.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    const local = path.join(ws, '.claude', 'settings.local.json');
    await w(W.click('#scope-project'));
    await until(`document.getElementById('scope-project')?.checked`, 'project scope');
    await w(W.click('#apply'));
    const n = await notification('Apply "Work gateway" to project/.claude/settings.local.json?');
    ok(n.includes('info/exclude'), n);
    ok(!(await vs.notifications()).some((x) => x.includes('changed outside VS Code')), 'no false "changed outside VS Code" warning');
    await vs.dialogButton('Apply');
    await waitFor(() => existsSync(local) && readJson(local).env?.ANTHROPIC_AUTH_TOKEN === CLAUDE_KEY, { what: 'project file written' });
    ok(readFileSync(path.join(ws, '.git', 'info', 'exclude'), 'utf8').includes('/.claude/settings.local.json'), 'excluded from Git');
    await vs.clearNotifications();
    await w(W.click('#scope-user'));
    await w(W.click('#save'));
    await until(`document.getElementById('save')?.getAttribute('aria-disabled') === 'true'`, 'saved');
    await vs.clearNotifications();
  });

  await step('import the current Codex config as a profile, with its key from .env', async () => {
    await closeAll();
    await openProfiles();
    await w(W.click('#new-codex'));
    await until(`!!document.getElementById('preset-import')`, 'chooser');
    await w(W.click('#preset-import'));
    await vs.dialogButton('Keep in Secret Storage');
    ctx = await vs.webview();
    await until(`document.getElementById('name')?.value === 'Current Codex CLI settings'`, 'imported profile');
    eq(await w(`['f-provider', 'f-providerName', 'f-baseUrl', 'f-envKey', 'f-model'].map((id) => document.getElementById(id)?.value)`), ['local', 'Local gateway', `${stub}/v1`, 'LOCAL_KEY', 'gw-codex-1'], 'fields');
    eq(await w(`document.getElementById('mode-dotenv').checked`), true, 'key mode');
    await until(`document.getElementById('secret-status')?.textContent.includes('••••••••6b7c')`, 'key kept in secret storage');
    await w(W.click('#test'));
    await until(`document.getElementById('test-result')?.textContent.includes('1 model listed')`, 'test with the stored key');
    await waitFor(async () => (await statusText('Codex CLI'))?.includes('Codex: Current Codex CLI settings · gw-codex-1'), { what: 'imported profile is active' });
  });

  await step('Codex, "VS Code terminals only": comments kept, .env cleaned, the key reaches a new terminal', async () => {
    await w(W.click('#mode-terminal'));
    await w(W.click('#apply'));
    await notification('Apply "Current Codex CLI settings"');
    ok((await notification('Apply "Current Codex CLI settings"')).includes('update ~/codex-home/.env'), 'mentions .env');
    await vs.dialogButton('Apply');
    await waitFor(() => !readFileSync(path.join(H.codexDir, '.env'), 'utf8').includes('LOCAL_KEY'), { what: '.env cleaned' });
    eq(readFileSync(path.join(H.codexDir, '.env'), 'utf8'), 'OTHER=1\n', '.env keeps other lines');
    const toml = readFileSync(codexFile, 'utf8');
    ok(toml.startsWith('# My Codex setup\nmodel = "gw-codex-1"\n'), toml);
    ok(toml.includes('command = "npx"   # keep this'), toml);
    ok(toml.includes('env_key = "LOCAL_KEY"') && toml.includes('wire_api = "responses"'), toml);
    ok(!toml.includes(CODEX_KEY), 'no key in config.toml');
    await vs.clearNotifications();
    await focusWorkbench();
    await vs.command('Terminal: Create New Terminal');
    await waitFor(() => vs.eval(`!!document.querySelector('.terminal-wrapper.active .xterm-helper-textarea, .terminal .xterm-helper-textarea')`), { what: 'terminal', timeout: 15000 });
    await sleep(1500);
    await vs.eval(`document.querySelector('.terminal-wrapper.active .xterm-helper-textarea, .terminal .xterm-helper-textarea').focus()`);
    const outFile = path.join(root, 'term.txt');
    await vs.type(`printenv LOCAL_KEY > '${outFile}'`);
    await vs.key('Enter');
    await waitFor(() => existsSync(outFile) && readFileSync(outFile, 'utf8').trim(), { what: 'terminal output', timeout: 15000 });
    eq(readFileSync(outFile, 'utf8').trim(), CODEX_KEY, 'the key in the terminal');
    await vs.command('Terminal: Kill All Terminals');
  });

  await step('restoring config.toml brings back the .env line the restored config relies on', async () => {
    await paletteRun('Agent Profiles: Restore Previous Config');
    await vs.pickQuickItem('Codex CLI');
    await vs.pickQuickItem('config.toml');
    ok((await notification('Restore ~/codex-home/config.toml')).includes('update ~/codex-home/.env'), 'mentions .env');
    await vs.dialogButton('Restore');
    await waitFor(() => readFileSync(path.join(H.codexDir, '.env'), 'utf8').includes(`LOCAL_KEY=${CODEX_KEY}`), { what: '.env restored' });
    await waitFor(async () => (await statusText('Codex CLI'))?.includes('Current Codex CLI settings'), { what: 'status bar after restore' });
    await vs.clearNotifications();
  });

  await step('export: profiles without keys', async () => {
    const file = path.join(root, 'profiles-export.json');
    await paletteRun('Agent Profiles: Export Profiles');
    await vs.answerInput(file);
    await waitFor(() => existsSync(file), { what: 'export file' });
    const text = readFileSync(file, 'utf8');
    eq(JSON.parse(text).profiles.map((p) => p.name), ['Work gateway', 'Anthropic (sign in)', 'Current Codex CLI settings'], 'exported');
    ok(!text.includes(CLAUDE_KEY) && !text.includes(CODEX_KEY), 'no keys exported');
  });

  await step('the profiles editor comes back after Reload Window', async () => {
    await openProfiles();
    await focusWorkbench();
    vs.contexts.clear();
    await vs.command('Developer: Reload Window');
    await sleep(3000);
    await waitFor(() => vs.eval('!!document.querySelector(".monaco-workbench .part.statusbar")').catch(() => false), { timeout: 30000, what: 'workbench after reload' });
    await waitFor(async () => (await vs.editorTabs()).some((t) => t.includes('Agent Profiles')), { timeout: 20000, what: 'restored tab' });
    await vs.showTab('Agent Profiles');
    ctx = await vs.webview(25000);
    await until(`(${W.profiles}).length === 3`, 'profiles after reload', 15000);
    await waitFor(async () => (await statusText('Claude Code'))?.includes('Work gateway'), { what: 'status bar after reload', timeout: 15000 });
  });

  await step('no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });

  await vs.close();

  await step('no key in VS Code state, settings or logs', async () => {
    const leaks = [];
    const walk = (dir) => {
      for (const n of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, n.name);
        // Backups are copies of the user's config files, which held the key in plain text
        // in "In settings.json" mode, by the person's choice.
        if (p.startsWith(path.join(storage(), 'backups'))) continue;
        if (n.isDirectory()) walk(p);
        else if (n.isFile() && statSync(p).size < 50_000_000) {
          const b = readFileSync(p);
          for (const k of [CLAUDE_KEY, CODEX_KEY]) if (b.includes(k)) leaks.push(`${path.relative(root, p)}: ${k.slice(0, 14)}…`);
        }
      }
    };
    walk(path.join(root, 'user-data'));
    eq(leaks, [], 'files containing a key');
  });

  await restricted();
} finally {
  await vs.close();
  server.close();
  console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
  console.log(`Profile and screenshots: ${root}`);
  process.exitCode = failed.length ? 1 : 0;
}

/** Restricted Mode: a fresh window on an untrusted folder. */
async function restricted() {
  const r = path.join(root, 'restricted');
  const H2 = makeHome(r);
  const ws2 = path.join(r, 'project');
  mkdirSync(path.join(ws2, '.vscode'), { recursive: true });
  writeFileSync(path.join(ws2, '.vscode', 'settings.json'), JSON.stringify({ 'agentProfiles.backups': 1, 'agentProfiles.statusBar': 'never' }, null, 2));
  const trust = { ...settings, 'security.workspace.trust.enabled': true, 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.banner': 'never', 'security.workspace.trust.untrustedFiles': 'open' };
  vs = new VSCode(r, H2.env);
  vs.install(vsix, trust);
  await vs.launch(ws2);
  await sleep(2500);
  const settings2 = path.join(H2.claudeDir, 'settings.json');

  await step('Restricted Mode: project settings are off, with the reason', async () => {
    ok(await vs.eval(`document.body.textContent.includes('Restricted Mode')`), 'the window is in Restricted Mode');
    await paletteRun('Agent Profiles: New Profile');
    await vs.pickQuickItem('Claude Code');
    await vs.pickQuickItem('Amazon Bedrock');
    ctx = await vs.webview();
    await until(`document.getElementById('name')?.value === 'Amazon Bedrock'`, 'profile');
    eq(await w(`document.getElementById('scope-project').disabled`), true, 'project scope disabled');
    ok((await w(W.text('#scope-help-project'))).includes('Restricted Mode'), 'reason given');
  });

  await step('Restricted Mode: user settings still apply; workspace settings change nothing', async () => {
    await w(W.click('#apply'));
    await notification('Apply "Amazon Bedrock"');
    await vs.dialogButton('Apply');
    await waitFor(() => readJson(settings2).env?.CLAUDE_CODE_USE_BEDROCK === '1', { what: 'applied' });
    eq(readJson(settings2).env, { MY_OWN_VAR: 'keep me', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' }, 'env');
    // The workspace asked to hide the status bar; application-scoped settings ignore it.
    await waitFor(async () => (await statusText('Claude Code'))?.includes('Amazon Bedrock'), { what: 'status bar still shown' });
  });

  await step('Restricted Mode: no errors in the webviews', async () => {
    eq(vs.pageErrors, [], 'page errors');
  });
}
