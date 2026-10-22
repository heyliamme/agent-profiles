// Test connection, against a stub server on localhost: never a real provider.
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { after, before, test } from 'node:test';
import { claude, codex, core, fakeKey, profile } from './helpers.mjs';

let server;
let base;
const seen = [];
const routes = {};
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const h = routes[`${req.method} ${req.url.split('?')[0]}`];
      if (!h) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'not here' } }));
      }
      h(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const run = (def, p, secret, timeoutMs = 3000) => core.runTest(core.prepare(def, p, secret), { fetch, timeoutMs, secrets: [secret] });
const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};
/** A models list that wants a key, as most do. */
const authed = (obj) => (req, res) => (req.headers.authorization || req.headers['x-api-key'] ? json(res, 200, obj) : json(res, 401, { error: { message: 'no key' } }));
/** The last request that carried a key (the test also asks once without it). */
const keyed = () => seen.findLast((r) => r.headers.authorization || r.headers['x-api-key']);

test('Claude Code gateway: lists models with the token as a Bearer header and anthropic-version', async () => {
  routes['GET /api/v1/models'] = authed({ data: [{ id: 'claude-a' }, { id: 'claude-b' }] });
  const key = fakeKey();
  const p = profile(claude, { baseUrl: `${base}/api`, authVar: 'ANTHROPIC_AUTH_TOKEN', customHeaders: 'X-Team: core' }, 'terminal');
  const r = await run(claude, p, key);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.models, ['claude-a', 'claude-b']);
  assert.ok(r.latencyMs >= 0);
  assert.equal(r.message, 'Connected. 2 models listed.');
  const req = keyed();
  assert.equal(req.headers.authorization, `Bearer ${key}`);
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.equal(req.headers['x-team'], 'core');
  assert.equal(req.headers['x-api-key'], undefined);
  assert.ok(!JSON.stringify(r).includes(key));
});

test('X-Api-Key for ANTHROPIC_API_KEY', async () => {
  routes['GET /k/v1/models'] = authed({ data: [] });
  const key = fakeKey();
  await run(claude, profile(claude, { baseUrl: `${base}/k`, authVar: 'ANTHROPIC_API_KEY' }, 'config'), key);
  assert.equal(keyed().headers['x-api-key'], key);
  assert.equal(keyed().headers.authorization, undefined);
});

test('no models list: one minimal request to the model instead', async () => {
  routes['POST /p/v1/messages'] = (req, res, body) => {
    const b = JSON.parse(body);
    assert.equal(b.model, 'my-model');
    assert.equal(b.max_tokens, 1);
    json(res, 200, { content: [] });
  };
  const r = await run(claude, profile(claude, { baseUrl: `${base}/p`, authVar: 'ANTHROPIC_AUTH_TOKEN', model: 'my-model' }, 'terminal'), fakeKey());
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Connected: the model answered a one-token request.');
  const noModel = await run(claude, profile(claude, { baseUrl: `${base}/p`, authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'terminal'), fakeKey());
  assert.equal(noModel.ok, false);
  assert.match(noModel.message, /no models list \(404\)\. Set main model to test with a request instead\./);
});

test('Codex: Bearer key, query parameters and headers; built-in Ollama needs no key', async () => {
  routes['GET /v1/models'] = authed({ data: [{ id: 'gpt-x' }] });
  const key = fakeKey();
  const p = profile(codex, { provider: 'gw', baseUrl: `${base}/v1`, envKey: 'K', queryParams: 'api-version=2025-01-01', httpHeaders: 'X-A=b' }, 'terminal');
  const r = await run(codex, p, key);
  assert.equal(r.ok, true);
  const req = keyed();
  assert.equal(seen.at(-1).headers.authorization, undefined, 'the second ask goes without the key');
  assert.equal(req.url, '/v1/models?api-version=2025-01-01');
  assert.equal(req.headers.authorization, `Bearer ${key}`);
  assert.equal(req.headers['x-a'], 'b');
  assert.equal(r.url, `${base}/v1/models`, 'query parameters are left out of the result');
  const prep = core.prepare(codex, profile(codex, { provider: 'ollama' }, 'none'), undefined);
  assert.equal(prep.list.url, 'http://localhost:11434/v1/models');
  assert.equal(prep.list.headers.Authorization, undefined);
});

test('a refused key, a redirect (not followed) and an error body that echoes the key', async () => {
  const key = fakeKey();
  routes['GET /bad/v1/models'] = (req, res) => json(res, 401, { error: { message: `invalid key ${key}` } });
  const r = await run(claude, profile(claude, { baseUrl: `${base}/bad`, authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'terminal'), key);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.match(r.message, /^The key was refused \(401\): invalid key ••••••••/);
  assert.ok(!r.message.includes(key));
  let hit = false;
  routes['GET /elsewhere'] = (req, res) => {
    hit = true;
    json(res, 200, {});
  };
  routes['GET /redir/v1/models'] = (req, res) => {
    res.writeHead(302, { location: `${base}/elsewhere?token=x` });
    res.end();
  };
  const r2 = await run(claude, profile(claude, { baseUrl: `${base}/redir`, authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'terminal'), key);
  assert.equal(r2.ok, false);
  assert.match(r2.message, /^Redirected to http:\/\/127\.0\.0\.1:\d+\/elsewhere \(302\)\. Check the base URL; the key was not sent there\.$/);
  assert.equal(hit, false);
});

test('a timeout and an address nobody listens on', async () => {
  routes['GET /slow/v1/models'] = (req, res) => setTimeout(() => json(res, 200, { data: [] }), 1500);
  const r = await run(claude, profile(claude, { baseUrl: `${base}/slow`, authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'terminal'), fakeKey(), 200);
  assert.equal(r.ok, false);
  assert.match(r.message, /^No answer within 0 s\.|^No answer within/);
  const r2 = await run(claude, profile(claude, { baseUrl: 'http://127.0.0.1:9', authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'terminal'), fakeKey());
  assert.equal(r2.ok, false);
  assert.match(r2.message, /^Could not connect: /);
});

test('what cannot be tested says why, without a request', async () => {
  const n = seen.length;
  assert.match((await run(claude, core.fromPreset(claude, claude.presets.find((x) => x.id === 'bedrock'), 'b'))).message, /Bedrock, Vertex AI and signed-in accounts/);
  assert.match((await run(codex, profile(codex, { provider: 'openai' }, 'none'))).message, /codex login/);
  assert.match((await run(claude, profile(claude, { authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'terminal'), undefined)).message, /Enter the key or token first/);
  assert.equal(seen.length, n);
});

test('a models list that answers without a key: the one-token request checks the key', async () => {
  const good = fakeKey();
  routes['GET /pub/v1/models'] = (req, res) => json(res, 200, { data: [{ id: 'm1' }] });
  routes['POST /pub/v1/messages'] = (req, res) => (req.headers.authorization === `Bearer ${good}` ? json(res, 200, { content: [] }) : json(res, 401, { error: { message: 'bad key' } }));
  const p = (model) => profile(claude, { baseUrl: `${base}/pub`, authVar: 'ANTHROPIC_AUTH_TOKEN', ...(model ? { model } : {}) }, 'terminal');
  const ok = await run(claude, p('m1'), good);
  assert.equal(ok.ok, true);
  assert.equal(ok.unverified, undefined);
  assert.match(ok.message, /^Connected: the key works/);
  assert.deepEqual(ok.models, ['m1']);
  const wrong = await run(claude, p('m1'), fakeKey());
  assert.equal(wrong.ok, false, 'a wrong key is not reported as connected');
  assert.equal(wrong.status, 401);
  const noModel = await run(claude, p(), fakeKey());
  assert.equal(noModel.unverified, true);
  assert.match(noModel.message, /the key was not checked/);
});

test('hidden fields are not tested: Codex on built-in Ollama ignores a stored gateway address', async () => {
  const prof = profile(codex, { provider: 'ollama', baseUrl: 'https://openrouter.ai/api/v1', queryParams: 'a=b', httpHeaders: 'X-A=b' }, 'none');
  const prep = core.prepare(codex, prof, undefined);
  assert.equal(prep.list.url, 'http://localhost:11434/v1/models');
  assert.equal(prep.list.headers['X-A'], undefined);
});

test('a huge answer is read only up to the cap', async () => {
  routes['GET /huge/v1/models'] = (req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    const chunk = 'x'.repeat(64 * 1024);
    let sent = 0;
    const more = () => {
      while (sent < 64 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once('drain', more);
      }
      res.end();
    };
    res.on('close', () => (sent = Infinity));
    more();
  };
  const r = await run(claude, profile(claude, { baseUrl: `${base}/huge`, authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'terminal'), fakeKey(), 10000);
  assert.equal(r.ok, false);
  assert.equal(r.status, 500);
  assert.ok(r.message.length < 400);
});

test('a model alias is tested as the model it stands for, or not with a request', () => {
  const key = fakeKey();
  const p = (values) => profile(claude, { backend: 'anthropic', baseUrl: 'https://openrouter.test/api', authVar: 'ANTHROPIC_AUTH_TOKEN', ...values }, 'terminal');
  const mapped = core.prepare(claude, p({ model: 'opus', opusModel: 'anthropic/claude-opus-4.1' }), key);
  assert.equal(JSON.parse(mapped.probe.body).model, 'anthropic/claude-opus-4.1');
  const unmapped = core.prepare(claude, p({ model: 'sonnet' }), key);
  assert.equal(unmapped.probe, undefined);
  assert.match(unmapped.probeMissing, /sonnet is an alias/);
  assert.equal(core.prepare(claude, p({ model: 'default' }), key).probe, undefined);
  assert.equal(JSON.parse(core.prepare(claude, p({ model: 'claude-x-1' }), key).probe.body).model, 'claude-x-1');
});
