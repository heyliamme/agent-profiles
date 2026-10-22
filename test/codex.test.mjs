// Codex: config.toml merges that keep comments and other tables, providers, keys.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { applyText, codex, core, fakeKey, profile, tmp } from './helpers.mjs';

const existing = `# Codex settings, edited by hand
model = "gpt-old" # what I used before
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp_servers.docs]
command = "npx"   # keep this alignment
args = ["-y", "docs-server"]

# A provider I set up myself
[model_providers.mine]
name = "Mine"
base_url = "http://localhost:9000/v1"
`;

const gateway = (extra = {}, mode = 'terminal') =>
  profile(codex, { provider: 'gw', providerName: 'Gateway', baseUrl: 'https://gw.test/v1', wireApi: 'responses', envKey: 'GW_KEY', model: 'm-1', ...extra }, mode);

test('a provider profile adds its table at the end and keeps every comment and table', () => {
  const r = applyText(codex, existing, gateway({ reasoningEffort: 'high' }), { secret: fakeKey() });
  assert.equal(
    r.text,
    `# Codex settings, edited by hand
model = "m-1" # what I used before
approval_policy = "on-request"
sandbox_mode = "workspace-write"
model_provider = "gw"
model_reasoning_effort = "high"

[mcp_servers.docs]
command = "npx"   # keep this alignment
args = ["-y", "docs-server"]

# A provider I set up myself
[model_providers.mine]
name = "Mine"
base_url = "http://localhost:9000/v1"

[model_providers.gw]
name = "Gateway"
base_url = "https://gw.test/v1"
wire_api = "responses"
env_key = "GW_KEY"
`,
  );
  assert.equal(r.plan.terminal.name, 'GW_KEY');
});

test('switching provider removes the table the last apply wrote, not the ones you wrote', () => {
  const first = applyText(codex, existing, gateway(), { secret: fakeKey() });
  const second = applyText(codex, first.text, gateway({ provider: 'other', providerName: 'Other', baseUrl: 'https://other.test/v1', envKey: 'OTHER_KEY', model: '' }), { secret: fakeKey(), prev: { ...first.record, at: 0 } });
  const j = core.read('toml', second.text);
  assert.deepEqual(Object.keys(j.model_providers), ['mine', 'other']);
  assert.equal(j.model, undefined);
  assert.equal(j.model_provider, 'other');
  assert.match(second.text, /# A provider I set up myself\n\[model_providers\.mine\]/);
  assert.ok(!second.text.includes('[model_providers.gw]'));
  assert.ok(!/\n\n\n/.test(second.text), 'no runs of blank lines left behind');
});

test("editing a provider you defined yourself keeps its other keys", () => {
  const text = '[model_providers.mine]\nname = "Mine"\nbase_url = "http://old/v1"\nrequires_openai_auth = false # mine\n';
  const p = profile(codex, { provider: 'mine', providerName: 'Mine', baseUrl: 'http://localhost:9000/v1', envKey: 'MINE_KEY' }, 'terminal');
  const r = applyText(codex, text, p, { secret: fakeKey() });
  assert.equal(r.text, 'model_provider = "mine"\n\n[model_providers.mine]\nname = "Mine"\nbase_url = "http://localhost:9000/v1"\nrequires_openai_auth = false # mine\nwire_api = "responses"\nenv_key = "MINE_KEY"\n');
});

test('built-in providers get no table; Ollama needs no key', () => {
  const p = core.fromPreset(codex, codex.presets.find((x) => x.id === 'ollama'), 'o');
  assert.deepEqual(core.validate(codex, p), []);
  const r = applyText(codex, '', p);
  assert.equal(r.text, 'model_provider = "ollama"\nmodel = "gpt-oss:20b"\n');
  const login = core.fromPreset(codex, codex.presets.find((x) => x.id === 'openai-login'), 'l');
  assert.equal(applyText(codex, r.text, login, { prev: { ...r.record, at: 0 } }).text, 'model_provider = "openai"\n');
  // Only "none" is offered for a built-in provider.
  assert.deepEqual(core.availableModes(codex, login).map((m) => m.id), ['none']);
});

test('reserved provider ids are refused, odd ids are validated', () => {
  const ids = (provider) => core.validate(codex, gateway({ provider }), { hasSecret: true }).map((i) => i.field);
  assert.deepEqual(ids('amazon-bedrock'), ['provider']);
  assert.deepEqual(ids('has space'), ['provider']);
  assert.deepEqual(ids('ok_id-2'), []);
  assert.deepEqual(core.validate(codex, gateway({ envKey: 'CODEX_KEY' }), { hasSecret: true }).map((i) => i.field), ['envKey']);
});

test('Azure: query parameters as an inline table; numbers as numbers', () => {
  const p = core.fromPreset(codex, codex.presets.find((x) => x.id === 'azure'), 'az');
  assert.deepEqual(core.validate(codex, p, { hasSecret: true }).map((i) => i.message), ['Replace the placeholder with your own address.']);
  p.values.baseUrl = 'https://contoso.openai.azure.com/openai';
  p.values.requestMaxRetries = '2';
  p.values.contextWindow = '200000';
  const r = applyText(codex, '', p, { secret: fakeKey() });
  const j = core.read('toml', r.text);
  assert.deepEqual({ ...j.model_providers.azure.query_params }, { 'api-version': '2025-04-01-preview' });
  assert.equal(j.model_providers.azure.request_max_retries, 2);
  assert.equal(j.model_context_window, 200000);
  assert.match(r.text, /query_params = \{ api-version = "2025-04-01-preview" \}/);
});

test('bearer-token mode writes experimental_bearer_token; switching mode removes it', () => {
  const key = fakeKey();
  const r = applyText(codex, '', gateway({}, 'config'), { secret: key });
  const j = core.read('toml', r.text);
  assert.equal(j.model_providers.gw.experimental_bearer_token, key);
  assert.equal(j.model_providers.gw.env_key, undefined);
  const back = applyText(codex, r.text, gateway(), { secret: key, prev: { ...r.record, at: 0 } });
  assert.ok(!back.text.includes(key));
  assert.equal(core.read('toml', back.text).model_providers.gw.env_key, 'GW_KEY');
});

test('a bearer token someone left in the active provider table is cleared', () => {
  const text = `[model_providers.gw]\nname = "G"\nexperimental_bearer_token = "${fakeKey()}"\n`;
  const r = applyText(codex, text, gateway(), { secret: fakeKey() });
  assert.equal(core.read('toml', r.text).model_providers.gw.experimental_bearer_token, undefined);
});

test('.env mode: the key goes to CODEX_HOME/.env, config.toml only names the variable', () => {
  const key = fakeKey();
  const r = applyText(codex, '', gateway({}, 'dotenv'), { secret: key });
  assert.ok(!r.text.includes(key));
  assert.deepEqual(r.plan.dotenv, { file: '/cfg/.env', set: { name: 'GW_KEY', value: key }, remove: [] });
  const env = core.editDotenv('# mine\nOTHER=1\nGW_KEY=old\n', r.plan.dotenv.set, r.plan.dotenv.remove);
  assert.equal(env, `# mine\nOTHER=1\nGW_KEY=${key}\n`);
  // Renaming the variable removes the old line; leaving .env mode removes ours.
  const renamed = core.plan({ def: codex, profile: gateway({ envKey: 'NEW_KEY' }, 'dotenv'), secret: key, prev: { ...r.record, at: 0 }, configDir: '/cfg', platform: 'linux' });
  assert.deepEqual(renamed.dotenv.remove, ['GW_KEY']);
  const left = core.plan({ def: codex, profile: gateway(), secret: key, prev: { ...r.record, at: 0 }, configDir: '/cfg', platform: 'linux' });
  assert.deepEqual(left.dotenv, { file: '/cfg/.env', remove: ['GW_KEY'] });
  assert.equal(core.editDotenv(env, undefined, ['GW_KEY']), '# mine\nOTHER=1\n');
  assert.equal(core.dotenvValue('a b#c'), "'a b#c'");
  assert.throws(() => core.dotenvValue('a\nb'), /line break/);
});

test('keys written with dotted names or inline tables still merge (through toml-patch) and stay correct', () => {
  const text = 'model_providers.gw.name = "Old"\nmodel = "x"\n';
  const r = applyText(codex, text, gateway(), { secret: fakeKey() });
  const j = core.read('toml', r.text);
  assert.equal(j.model_providers.gw.name, 'Gateway');
  assert.equal(j.model_providers.gw.base_url, 'https://gw.test/v1');
  const inline = '[model_providers]\ngw = { name = "Old" }\n[other]\na = 1\n';
  const j2 = core.read('toml', applyText(codex, inline, gateway(), { secret: fakeKey() }).text);
  assert.equal(j2.model_providers.gw.base_url, 'https://gw.test/v1');
  assert.deepEqual({ ...j2.other }, { a: 1 });
});

test('a value with # inside a string keeps its meaning; multi-line values are handled', () => {
  const text = 'model = "a#b" # comment\nnotify = [\n  "x",\n]\n';
  const r = applyText(codex, text, profile(codex, { provider: 'openai', model: 'c#d' }, 'none'));
  assert.equal(r.text, 'model = "c#d" # comment\nnotify = [\n  "x",\n]\nmodel_provider = "openai"\n');
});

test('escapes in strings are written so TOML reads them back', () => {
  const p = profile(codex, { provider: 'openai', model: 'quote" back\\ unicode \u2028é' }, 'none');
  assert.equal(core.read('toml', applyText(codex, '', p).text).model, 'quote" back\\ unicode \u2028é');
});

test('a leading comment block stays on top; a comment above a table stays with it', () => {
  const p = profile(codex, { provider: 'openai' }, 'none');
  assert.equal(applyText(codex, '# header\n\n[t]\na = 1\n', p).text, '# header\n\nmodel_provider = "openai"\n\n[t]\na = 1\n');
  assert.equal(applyText(codex, '# about t\n[t]\na = 1\n', p).text, 'model_provider = "openai"\n\n# about t\n[t]\na = 1\n');
});

test('config.toml with a syntax error is refused', () => {
  assert.throws(() => applyText(codex, 'model = \n', gateway(), { secret: fakeKey() }), core.ConfigSyntaxError);
});

test('CODEX_HOME moves the config', () => {
  assert.equal(core.configFile(codex, {}, '/home/u', path.posix), '/home/u/.codex/config.toml');
  assert.equal(core.configFile(codex, { CODEX_HOME: '/data/codex' }, '/home/u', path.posix), '/data/codex/config.toml');
  assert.equal(core.configFile(codex, {}, 'C:\\Users\\u', path.win32), 'C:\\Users\\u\\.codex\\config.toml');
  assert.equal(core.configFile(codex, { CODEX_HOME: 'E:\\codex' }, 'C:\\Users\\u', path.win32), 'E:\\codex\\config.toml');
  // This machine's own path functions, whatever it runs on.
  const home = tmp();
  assert.equal(core.configFile(codex, {}, home), path.join(home, '.codex', 'config.toml'));
});

test('the result is re-read and compared before it is accepted', () => {
  // applyOps throws rather than return text that doesn't hold what was asked.
  const ops = [{ path: ['model'], value: 'ok' }];
  assert.equal(core.applyOps('toml', 'a = 1\n', ops), 'a = 1\nmodel = "ok"\n');
  assert.ok(core.same(core.read('toml', core.applyOps('toml', '[x]\ny = 2\n', [{ path: ['x', 'z'], value: { 'a b': 'c' } }])), { x: { y: 2, z: { 'a b': 'c' } } }));
});

test('a config.toml with dates can still be edited, and the dates keep their form', () => {
  for (const text of ['model = "a"\n\n[x]\nt = 2026-10-01T10:00:00Z\n', 'd = 1979-05-27\nmodel = "a"\n', 'lt = 07:32:00\nldt = 1979-05-27T07:32:00.5\nmodel = "a"\n']) {
    const out = core.applyOps('toml', text, [{ path: ['model'], value: 'b' }]);
    assert.equal(out, text.replace('model = "a"', 'model = "b"'));
  }
  // Through toml-patch too (a dotted key the line editor leaves alone).
  const out = core.applyOps('toml', 'a.b = 1\nd = 1979-05-27\n', [{ path: ['a', 'b'], value: 2 }]);
  assert.match(out, /d = 1979-05-27\n/);
  assert.equal(core.read('toml', out).a.b, 2);
});

test('.env values: comments after a value, quotes, and $ that dotenvy would expand', () => {
  const env = core.readDotenv('A="sk-or-v1-abc" # personal\nB=sk-abc # note\nC=\'lit $X\' # c\nD="a\\"b\\$c"\nE=x#y\nexport F=plain\n');
  assert.deepEqual(env, { A: 'sk-or-v1-abc', B: 'sk-abc', C: 'lit $X', D: 'a"b$c', E: 'x#y', F: 'plain' });
  assert.equal(core.dotenvValue('ab$cdXYZ'), "'ab$cdXYZ'");
  assert.equal(core.dotenvValue("it's$x"), '"it\'s\\$x"');
  for (const v of ['ab$cdXYZ', "it's$x", 'a b#c', 'q"uote\\']) assert.equal(core.readDotenv(`K=${core.dotenvValue(v)}`).K, v);
});

test('a TOML file the line editor can\'t extend falls back to the full rewrite, not a syntax error', () => {
  const text = 'model = "o3"\nmodel_providers = { local = { name = "L", base_url = "http://x/v1" } }\n';
  const p = core.fromPreset(codex, codex.presets.find((x) => x.id === 'openrouter'), 'a');
  const { text: out } = applyText(codex, text, p, { secret: fakeKey() });
  const v = core.read('toml', out);
  assert.equal(v.model_providers.openrouter.base_url, 'https://openrouter.ai/api/v1');
  assert.equal(v.model_providers.local.name, 'L');
});

test('"No key here" keeps env_key for a key exported by your own shell', () => {
  const p = profile(codex, { provider: 'openrouter', providerName: 'OR', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY' }, 'none');
  assert.deepEqual(core.validate(codex, p), []);
  const { text } = applyText(codex, '', p);
  assert.equal(core.read('toml', text).model_providers.openrouter.env_key, 'OPENROUTER_API_KEY');
  // Without a variable (a local server), nothing is required.
  const local = profile(codex, { provider: 'local', baseUrl: 'http://localhost:8000/v1' }, 'none');
  assert.deepEqual(core.validate(codex, local), []);
  assert.equal(core.read('toml', applyText(codex, '', local).text).model_providers.local.env_key, undefined);
});

test('the key variable can\'t be one the shell or other programs rely on', () => {
  for (const name of ['PATH', 'HOME', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BASH_ENV', 'GIT_SSH_COMMAND', 'path']) {
    const p = profile(codex, { provider: 'gw', baseUrl: 'https://gw.test/v1', envKey: name }, 'terminal');
    assert.ok(core.validate(codex, p, { hasSecret: true }).some((i) => i.field === 'envKey'), name);
  }
  const ok = profile(codex, { provider: 'gw', baseUrl: 'https://gw.test/v1', envKey: 'GATEWAY_API_KEY' }, 'terminal');
  assert.deepEqual(core.validate(codex, ok, { hasSecret: true }), []);
});
