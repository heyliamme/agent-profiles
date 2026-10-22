// Importing the current config as a profile, export / import, masking, definitions.
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'node:path';
import { test } from 'node:test';
import { applyText, claude, codex, core, fakeKey, profile } from './helpers.mjs';

test('import Claude Code settings: fields, the key (to move into secret storage), extra env', () => {
  const key = fakeKey();
  const cfg = { model: 'opus', permissions: {}, env: { ANTHROPIC_BASE_URL: 'https://gw.test', ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '', API_TIMEOUT_MS: '600000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', MY_VAR: 'x', OTHER_SECRET: 'zzzzzzzzzz' } };
  const r = core.importConfig(claude, cfg, { id: 'i', name: 'Current' });
  assert.equal(r.profile.values.backend, 'anthropic');
  assert.equal(r.profile.values.baseUrl, 'https://gw.test');
  assert.equal(r.profile.values.model, 'opus');
  assert.equal(r.profile.values.apiTimeout, '600000');
  assert.equal(r.profile.values.disableTraffic, 'true');
  assert.equal(r.profile.values.authVar, 'ANTHROPIC_AUTH_TOKEN');
  assert.equal(r.profile.values.extraEnv, 'ANTHROPIC_API_KEY=\nMY_VAR=x');
  assert.equal(r.profile.secretMode, 'config');
  assert.equal(r.secret, key);
  assert.equal(r.secretFrom, 'settings.json (env.ANTHROPIC_AUTH_TOKEN)');
  assert.deepEqual(r.notes, ['OTHER_SECRET looks like a credential and was not imported.']);
  // Applying the imported profile back changes nothing but the credential-like extra.
  const text = JSON.stringify(cfg, null, 2);
  const back = JSON.parse(applyText(claude, text, r.profile, { secret: key }).text);
  delete cfg.env.OTHER_SECRET;
  assert.deepEqual(back, { ...cfg, env: { ...cfg.env, OTHER_SECRET: 'zzzzzzzzzz' } });
});

test('import Bedrock settings: the service is recognised from its switch', () => {
  const r = core.importConfig(claude, { env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' } }, { id: 'i', name: 'B' });
  assert.equal(r.profile.values.backend, 'bedrock');
  assert.equal(r.profile.values.awsRegion, 'eu-west-1');
  assert.equal(r.profile.secretMode, 'none');
  assert.equal(r.profile.values.extraEnv, undefined);
});

test('import Codex config: provider table, key in .env, or key in a variable', () => {
  const cfg = core.read('toml', 'model = "m"\nmodel_provider = "gw"\nmodel_reasoning_effort = "low"\n[model_providers.gw]\nname = "G"\nbase_url = "https://gw.test/v1"\nenv_key = "GW_KEY"\nquery_params = { a = "1" }\nrequest_max_retries = 3\n');
  const key = fakeKey();
  const r = core.importConfig(codex, cfg, { id: 'i', name: 'C', dotenvText: `GW_KEY=${key}\n` });
  assert.deepEqual(r.profile.values, { provider: 'gw', wireApi: 'responses', providerName: 'G', baseUrl: 'https://gw.test/v1', envKey: 'GW_KEY', model: 'm', reasoningEffort: 'low', queryParams: 'a=1', requestMaxRetries: '3' });
  assert.equal(r.profile.secretMode, 'dotenv');
  assert.equal(r.secret, key);
  const r2 = core.importConfig(codex, cfg, { id: 'i', name: 'C' });
  assert.equal(r2.profile.secretMode, 'terminal');
  assert.equal(r2.secret, undefined);
  const r3 = core.importConfig(codex, {}, { id: 'i', name: 'Empty' });
  assert.deepEqual(r3.profile.values, { provider: 'openai', wireApi: 'responses' });
  assert.equal(r3.profile.secretMode, 'none');
});

test('export holds no keys, import validates and renames duplicates', () => {
  const key = fakeKey();
  const p = profile(claude, { baseUrl: 'https://gw.test', authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'terminal', { name: 'Work' });
  const out = core.exportProfiles([p, profile(codex, { provider: 'openai' }, 'none', { name: 'Codex' })]);
  assert.ok(!out.includes(key));
  assert.ok(!out.includes('"id"'));
  const back = core.importProfiles(out, core.AGENTS);
  assert.equal(back.profiles.length, 2);
  assert.deepEqual(back.profiles[0].values, p.values);
  assert.equal(back.profiles[0].secretMode, 'terminal');
  assert.throws(() => core.importProfiles('{"profiles":[]}', core.AGENTS), /not an Agent Profiles export/);
  assert.throws(() => core.importProfiles('nope', core.AGENTS), /not JSON/);
  const odd = core.importProfiles(JSON.stringify({ format: 'agent-profiles', profiles: [{ agent: 'gemini', name: 'G' }, { agent: 'codex', name: 'X', secretMode: 'weird', values: { provider: 'openai', bogus: 'x', model: 5 } }] }), core.AGENTS);
  assert.deepEqual(odd.skipped, ['#1 (G): unknown agent gemini']);
  assert.deepEqual(odd.profiles[0].values, { provider: 'openai' });
  assert.equal(odd.profiles[0].secretMode, 'none');
  assert.equal(core.uniqueName('Work', ['Work', 'Work (2)']), 'Work (3)');
});

test('masking: keys show as dots and their last four characters, in text and in config objects', () => {
  const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX';
  assert.equal(core.mask(key), '••••••••UVWX');
  assert.equal(core.mask('short'), '••••••••');
  assert.equal(core.maskText(`token=${key} again ${key}`, [key]), 'token=••••••••UVWX again ••••••••UVWX');
  const cfg = { env: { ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_BASE_URL: 'https://gw.test' }, model_providers: { x: { experimental_bearer_token: 'fake-token-xxxx', http_headers: { Authorization: 'Bearer abcdefghijk' } } } };
  assert.deepEqual(core.secretsIn(cfg).sort(), [key, 'Bearer abcdefghijk', 'fake-token-xxxx'].sort());
  assert.deepEqual(core.secretsInDotenv('A=short\nGW_KEY="abcdefghijkl"\n'), ['abcdefghijkl']);
  assert.equal(core.scrub(`failed for ${key}\nline2\nline3\nline4`, [key]), 'failed for ••••••••UVWX line2 line3');
});

test('presets fill fields only: each one validates once its placeholders are replaced', () => {
  for (const def of core.AGENTS) {
    for (const preset of def.presets) {
      const p = core.fromPreset(def, preset, 'x');
      const issues = core.validate(def, p, { hasSecret: true }).filter((i) => !/placeholder|full http|is required/.test(i.message));
      assert.deepEqual(issues, [], `${def.id}/${preset.id}`);
      assert.ok(core.availableModes(def, p).some((m) => m.id === preset.secretMode), `${def.id}/${preset.id} mode`);
    }
  }
});

test('the bundled agent definitions are valid', () => {
  for (const def of core.AGENTS) assert.deepEqual(core.checkAgentDef(def), [], def.id);
});

test('a broken agent definition is caught', () => {
  const def = structuredClone(claude);
  def.fields.push({ id: 'x', label: 'X', help: 'h', type: 'string', group: 'models', target: ['env', '{nope}'] });
  def.fields.push({ id: 'y', label: 'Y', help: 'h', type: 'select', group: 'models', when: { field: 'ghost', equals: 'a' } });
  def.secret.modes = def.secret.modes.filter((m) => m.kind !== 'none');
  def.presets.push({ id: 'p', label: 'P', description: 'd', values: { missing: '1' }, secretMode: 'nope' });
  def.secret.modes.push({ id: 'cfg2', kind: 'config', label: 'l', help: 'h', plaintext: false, target: ['k'] });
  assert.deepEqual(core.checkAgentDef(def), [
    'claude-code: field x: placeholder {nope} is not a field',
    'claude-code: field y: a select needs options',
    'claude-code: field y: condition on unknown field ghost',
    'claude-code: secret needs an unconditional mode of kind none',
    'claude-code: secret mode cfg2: a key written to a file is plain text',
    'claude-code: preset anthropic-login: unknown secret mode none',
    'claude-code: preset bedrock: unknown secret mode none',
    'claude-code: preset vertex: unknown secret mode none',
    'claude-code: preset p: unknown secret mode nope',
    'claude-code: preset p: unknown field missing',
  ]);
  assert.deepEqual(core.checkAgentDef(null), ['not an object']);
});

test('a new agent is a data file: a minimal definition plans an apply', () => {
  const def = {
    id: 'demo',
    label: 'Demo CLI',
    short: 'Demo',
    docs: ['https://example.com/docs'],
    config: { format: 'json', file: 'config.json', defaultDir: '~/.demo', dirEnv: 'DEMO_HOME' },
    statusField: 'model',
    statusFallback: 'default',
    fields: [{ id: 'model', label: 'Model', type: 'string', group: 'models', help: 'h', target: ['model'] }],
    secret: { label: 'Key', help: 'h', modes: [{ id: 'none', kind: 'none', label: 'None', help: 'h', plaintext: false }, { id: 'config', kind: 'config', label: 'File', help: 'h', plaintext: true, target: ['apiKey'] }] },
    presets: [],
  };
  assert.deepEqual(core.checkAgentDef(def), []);
  const p = profile(def, { model: 'm' }, 'config');
  assert.deepEqual(JSON.parse(applyText(def, '{"x":1}', p, { secret: 'k-123456789' }).text), { x: 1, model: 'm', apiKey: 'k-123456789' });
  assert.equal(core.configFile(def, { DEMO_HOME: '/d' }, '/home/u', path.posix), '/d/config.json');
  assert.equal(core.configFile(def, {}, '/home/u', path.posix), '/home/u/.demo/config.json');
  assert.equal(core.configFile(def, { DEMO_HOME: 'D:\\d' }, 'C:\\Users\\u', path.win32), 'D:\\d\\config.json');
});

test('docs sources named in the definitions are recorded in the README', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const def of core.AGENTS) for (const u of def.docs) assert.ok(readme.includes(u), `${def.id}: ${u}`);
});

test('import Bedrock with a truthy switch other than 1; an unknown value is kept, not dropped', () => {
  const r = core.importConfig(claude, { env: { CLAUDE_CODE_USE_BEDROCK: 'true', AWS_REGION: 'us-west-2' } }, { id: 'i', name: 'B' });
  assert.equal(r.profile.values.backend, 'bedrock');
  assert.equal(r.profile.values.awsRegion, 'us-west-2');
  const back = JSON.parse(applyText(claude, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: 'true', AWS_REGION: 'us-west-2' } }), r.profile).text);
  assert.equal(back.env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(back.env.AWS_REGION, 'us-west-2');
  const odd = core.importConfig(claude, { env: { CLAUDE_CODE_USE_BEDROCK: 'enabled' } }, { id: 'i', name: 'B' });
  assert.match(odd.profile.values.extraEnv, /CLAUDE_CODE_USE_BEDROCK=enabled/);
  assert.equal(odd.notes.length, 1);
});
