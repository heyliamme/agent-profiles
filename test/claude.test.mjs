// Claude Code: settings.json merges, switching, key handling, config directory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyText, claude, core, fakeKey, profile } from './helpers.mjs';

const existing = `{
    "permissions": {
        "allow": ["Bash(npm test:*)"],
        "deny": []
    },
    "env": {
        "MY_OWN_VAR": "keep me",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "old-opus"
    },
    "hooks": {},
    "includeCoAuthoredBy": false
}
`;

test('a gateway profile writes only its keys and keeps the rest of settings.json as it was', () => {
  const key = fakeKey();
  const p = profile(claude, { baseUrl: 'https://gw.test/api', authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'sonnet', haikuModel: 'small-1' }, 'config');
  const { text, record } = applyText(claude, existing, p, { secret: key });
  const j = JSON.parse(text);
  assert.deepEqual(j.permissions, { allow: ['Bash(npm test:*)'], deny: [] });
  assert.deepEqual(j.hooks, {});
  assert.equal(j.includeCoAuthoredBy, false);
  assert.equal(j.env.MY_OWN_VAR, 'keep me');
  assert.equal(j.env.ANTHROPIC_BASE_URL, 'https://gw.test/api');
  assert.equal(j.env.ANTHROPIC_AUTH_TOKEN, key);
  assert.equal(j.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'small-1');
  assert.equal(j.model, 'sonnet');
  // A managed key the profile leaves empty is removed, so nothing carries over.
  assert.equal(j.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  // Four-space indentation and key order are kept.
  assert.match(text, /^\{\n {4}"permissions": \{\n {8}"allow"/);
  assert.ok(text.indexOf('"permissions"') < text.indexOf('"hooks"'));
  assert.ok(record.paths.some((x) => x.join('.') === 'env.ANTHROPIC_AUTH_TOKEN'));
});

test('switching profiles takes back everything the previous one wrote', () => {
  const a = profile(claude, { baseUrl: 'https://a.test', authVar: 'ANTHROPIC_AUTH_TOKEN', extraEnv: 'FOO=1\nBAR=2', apiTimeout: '600000' }, 'config');
  const first = applyText(claude, existing, a, { secret: fakeKey() });
  const b = profile(claude, { model: 'opus', extraEnv: 'BAR=3' }, 'none');
  const second = applyText(claude, first.text, b, { prev: { ...first.record, at: 0 } });
  const j = JSON.parse(second.text);
  assert.deepEqual(j.env, { MY_OWN_VAR: 'keep me', BAR: '3' });
  assert.equal(j.model, 'opus');
});

test('an env block emptied by a switch is removed, other empty objects are not', () => {
  const p = profile(claude, { baseUrl: 'https://a.test' }, 'none');
  const once = applyText(claude, '{\n  "hooks": {}\n}\n', p);
  assert.deepEqual(JSON.parse(once.text), { hooks: {}, env: { ANTHROPIC_BASE_URL: 'https://a.test' } });
  const back = applyText(claude, once.text, profile(claude, {}, 'none'), { prev: { ...once.record, at: 0 } });
  assert.deepEqual(JSON.parse(back.text), { hooks: {} });
});

test('OpenRouter: ANTHROPIC_API_KEY is written as an empty string, and the token goes in AUTH_TOKEN', () => {
  const preset = claude.presets.find((x) => x.id === 'openrouter');
  const p = core.fromPreset(claude, preset, 'or');
  p.secretMode = 'config';
  assert.deepEqual(core.validate(claude, p, { hasSecret: true }), []);
  const key = fakeKey('sk-or');
  const j = JSON.parse(applyText(claude, '', p, { secret: key }).text);
  assert.equal(j.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  assert.equal(j.env.ANTHROPIC_API_KEY, '');
  assert.equal(j.env.ANTHROPIC_AUTH_TOKEN, key);
});

test('a key left in settings.json by hand is cleared when a profile keeps its key elsewhere', () => {
  const withKey = JSON.stringify({ env: { ANTHROPIC_API_KEY: fakeKey(), ANTHROPIC_AUTH_TOKEN: fakeKey() } }, null, 2);
  const p = profile(claude, { authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'terminal');
  const r = applyText(claude, withKey, p, { secret: fakeKey() });
  assert.equal(JSON.parse(r.text).env, undefined);
  assert.equal(r.plan.terminal.name, 'ANTHROPIC_AUTH_TOKEN');
});

test('apiKeyHelper mode: a key file and a command that prints it, no key in settings.json', () => {
  const key = fakeKey();
  const p = profile(claude, { baseUrl: 'https://gw.test', authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'helper');
  const r = applyText(claude, existing, p, { secret: key, keyFile: "/home/o'neil/.claude/agent-profiles/user.key" });
  const j = JSON.parse(r.text);
  assert.equal(j.apiKeyHelper, `cat '/home/o'\\''neil/.claude/agent-profiles/user.key'`);
  assert.ok(!r.text.includes(key));
  assert.deepEqual(r.plan.keyFile, [{ file: "/home/o'neil/.claude/agent-profiles/user.key", content: key }]);
  assert.equal(core.helperCommand('C:\\Users\\a\\.claude\\k.key', 'win32'), 'type "C:\\Users\\a\\.claude\\k.key"');
  // Switching away removes the helper and deletes the key file.
  const next = applyText(claude, r.text, profile(claude, {}, 'none'), { prev: { ...r.record, at: 0 } });
  assert.equal(JSON.parse(next.text).apiKeyHelper, undefined);
  assert.deepEqual(next.plan.keyFile, [{ file: "/home/o'neil/.claude/agent-profiles/user.key", content: null }]);
});

test("someone's own apiKeyHelper is left alone", () => {
  const own = JSON.stringify({ apiKeyHelper: '~/bin/get-key.sh' });
  const r = applyText(claude, own, profile(claude, { model: 'haiku' }, 'none'));
  assert.equal(JSON.parse(r.text).apiKeyHelper, '~/bin/get-key.sh');
});

test('Bedrock and Vertex write their switches, and switching back to the API removes them', () => {
  const bed = core.fromPreset(claude, claude.presets.find((x) => x.id === 'bedrock'), 'b');
  bed.values.awsProfile = 'dev';
  assert.deepEqual(core.validate(claude, bed), []);
  const r = applyText(claude, '{}', bed);
  assert.deepEqual(JSON.parse(r.text).env, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1', AWS_PROFILE: 'dev' });
  const vx = core.fromPreset(claude, claude.presets.find((x) => x.id === 'vertex'), 'v');
  assert.deepEqual(core.validate(claude, vx).map((i) => i.field), ['vertexProject']);
  vx.values.vertexProject = 'my-project-1';
  const r2 = applyText(claude, r.text, vx, { prev: { ...r.record, at: 0 } });
  assert.deepEqual(JSON.parse(r2.text).env, { CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'global', ANTHROPIC_VERTEX_PROJECT_ID: 'my-project-1' });
  const api = applyText(claude, r2.text, core.fromPreset(claude, claude.presets[0], 'a'), { prev: { ...r2.record, at: 0 } });
  assert.deepEqual(JSON.parse(api.text), {});
});

test('flags and numbers are written as Claude Code reads them: strings in env', () => {
  const p = profile(claude, { disableTraffic: 'true', apiTimeout: '3000000', maxOutputTokens: '8192' }, 'none');
  const j = JSON.parse(applyText(claude, '', p).text);
  assert.deepEqual(j.env, { API_TIMEOUT_MS: '3000000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const off = profile(claude, { disableTraffic: 'false' }, 'none');
  assert.equal(JSON.parse(applyText(claude, JSON.stringify(j), off).text).env, undefined);
});

test('settings.json with a syntax error is refused, not replaced', () => {
  const p = profile(claude, { model: 'opus' }, 'none');
  assert.throws(() => applyText(claude, '{ "env": { "A": 1 }', p), (e) => e instanceof core.ConfigSyntaxError && /line 1/.test(e.message));
  assert.throws(() => applyText(claude, '[1, 2]', p), /not a JSON object/);
});

test('comments in settings.json survive (Claude Code tolerates them in some versions)', () => {
  const text = '{\n  // my settings\n  "model": "haiku"\n}\n';
  const r = applyText(claude, text, profile(claude, { model: 'opus' }, 'none'));
  assert.equal(r.text, '{\n  // my settings\n  "model": "opus"\n}\n');
});

test('CRLF line endings and tab indentation are kept', () => {
  const text = '{\r\n\t"a": 1\r\n}\r\n';
  const r = applyText(claude, text, profile(claude, { model: 'opus' }, 'none'));
  assert.equal(r.text, '{\r\n\t"a": 1,\r\n\t"model": "opus"\r\n}\r\n');
});

test('CLAUDE_CONFIG_DIR moves the settings file; ~ is expanded', () => {
  assert.equal(core.configFile(claude, {}, '/home/u'), '/home/u/.claude/settings.json');
  assert.equal(core.configFile(claude, { CLAUDE_CONFIG_DIR: '/srv/claude-work' }, '/home/u'), '/srv/claude-work/settings.json');
  assert.equal(core.configFile(claude, { CLAUDE_CONFIG_DIR: '~/alt' }, '/home/u'), '/home/u/alt/settings.json');
  assert.equal(core.configFile(claude, { CLAUDE_CONFIG_DIR: '  ' }, '/home/u'), '/home/u/.claude/settings.json');
});

test('validation: URLs, required fields, numbers, patterns, keys in the wrong place', () => {
  const issues = (values, mode = 'none', o) => core.validate(claude, profile(claude, values, mode), o).map((i) => `${i.field}: ${i.message}`);
  assert.deepEqual(issues({ baseUrl: 'gw.test' }), ['baseUrl: Enter a full http:// or https:// address.']);
  assert.deepEqual(issues({ baseUrl: 'https://user:pw@gw.test' }), ["baseUrl: Don't put credentials in the address: use the key field."]);
  assert.deepEqual(issues({ baseUrl: 'https://' }), ['baseUrl: Enter a full http:// or https:// address.']);
  assert.deepEqual(issues({ apiTimeout: '12.5' }), ['apiTimeout: Enter a whole number.']);
  assert.deepEqual(issues({ apiTimeout: '10' }), ['apiTimeout: Between 1000 and 3600000.']);
  assert.deepEqual(issues({ customHeaders: 'no colon here' }), ['customHeaders: One Name: value per line.']);
  assert.deepEqual(issues({ extraEnv: 'MY_TOKEN=abc' }), ['extraEnv: MY_TOKEN looks like a credential. Keys go in the key field, where they are kept in secret storage.']);
  assert.deepEqual(issues({ extraEnv: 'ANTHROPIC_BASE_URL=https://x.test' }), ['extraEnv: ANTHROPIC_BASE_URL is set by another field of this form.']);
  assert.deepEqual(issues({ authVar: 'ANTHROPIC_AUTH_TOKEN', extraEnv: 'ANTHROPIC_AUTH_TOKEN=' }, 'terminal', { hasSecret: true }), ['extraEnv: ANTHROPIC_AUTH_TOKEN carries the key; remove it from here.']);
  assert.deepEqual(issues({}, 'terminal', { hasSecret: false }), ['secret: Enter the key or token, or choose "No key here".']);
  assert.deepEqual(issues({ backend: 'vertex', vertexProject: 'my-proj-1', vertexRegion: 'global' }, 'helper'), ['secretMode: Choose where the key goes: this option is not available with these settings.']);
  assert.deepEqual(core.validate(claude, { ...profile(claude, {}), name: ' ' }).map((i) => i.field), ['name']);
});

test('applying without a saved key fails before anything is planned', () => {
  assert.throws(() => applyText(claude, '{}', profile(claude, {}, 'config')), /No key or token is saved/);
});

test('the project file is planned the same way, with its own record', () => {
  const p = { ...profile(claude, { model: 'haiku' }, 'none'), scope: 'project' };
  const r = applyText(claude, '{\n  "permissions": {"allow": []}\n}\n', p, { format: 'json' });
  assert.deepEqual(JSON.parse(r.text), { permissions: { allow: [] }, model: 'haiku' });
});

test('a credential in the extra request headers is refused, not imported, masked and not exported', () => {
  const token = fakeKey();
  for (const h of [`x-litellm-api-key: Bearer ${token}`, `Authorization: Bearer ${token}`, `x-portkey-api-key: ${token}`]) {
    const p = profile(claude, { backend: 'anthropic', baseUrl: 'https://gw.test', customHeaders: `X-Team: platform\n${h}` }, 'none');
    assert.ok(core.validate(claude, p).some((i) => i.field === 'customHeaders'), h);
    const out = core.exportProfiles([p], core.AGENTS);
    assert.ok(!out.includes(token), h);
    assert.ok(out.includes('X-Team: platform'));
    const cfg = { env: { ANTHROPIC_CUSTOM_HEADERS: `X-Team: platform\n${h}` } };
    assert.ok(!core.maskText(JSON.stringify(cfg), core.secretsIn(cfg)).includes(token), h);
    const r = core.importConfig(claude, cfg, { id: 'i', name: 'I' });
    assert.equal(r.profile.values.customHeaders, 'X-Team: platform');
    assert.ok(r.notes.some((n) => /credential/.test(n)));
  }
  const plain = profile(claude, { backend: 'anthropic', customHeaders: 'X-Team: platform' }, 'none');
  assert.deepEqual(core.validate(claude, plain), []);
});
