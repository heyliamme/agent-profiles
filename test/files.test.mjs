// Writing safely: atomic writes, permissions, symlinks, backups, conflicts, restore.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { test } from 'node:test';
import { claude, codex, core, fakeKey, profile, tmp } from './helpers.mjs';

const posix = process.platform !== 'win32';
const modeOf = (f) => statSync(f).mode & 0o777;

test('an atomic write keeps the file mode and leaves no temporary files', { skip: !posix }, async () => {
  const d = tmp();
  const f = path.join(d, 'settings.json');
  writeFileSync(f, '{}');
  chmodSync(f, 0o640);
  await core.atomicWrite(f, '{"a":1}\n');
  assert.equal(readFileSync(f, 'utf8'), '{"a":1}\n');
  assert.equal(modeOf(f), 0o640);
  assert.deepEqual(readdirSync(d), ['settings.json']);
});

test('a new file is created owner-only, in a new owner-only directory', { skip: !posix }, async () => {
  const d = tmp();
  const f = path.join(d, 'new', 'config.toml');
  await core.atomicWrite(f, 'a = 1\n');
  assert.equal(modeOf(f), 0o600);
  assert.equal(modeOf(path.dirname(f)), 0o700);
});

test('a symlinked config (dotfiles) is written through, the link stays a link', { skip: !posix }, async () => {
  const d = tmp();
  mkdirSync(path.join(d, 'dotfiles'));
  const real = path.join(d, 'dotfiles', 'settings.json');
  writeFileSync(real, '{}');
  const link = path.join(d, 'settings.json');
  symlinkSync(real, link);
  await core.atomicWrite(link, '{"b":2}');
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readFileSync(real, 'utf8'), '{"b":2}');
});

test('writePrivate makes a 600 key file', { skip: !posix }, async () => {
  const d = tmp();
  const f = path.join(d, 'agent-profiles', 'user.key');
  await core.writePrivate(f, fakeKey());
  assert.equal(modeOf(f), 0o600);
  assert.equal(modeOf(path.dirname(f)), 0o700);
});

test('backups rotate: only the newest N per file are kept, and they are owner-only', async () => {
  const d = tmp();
  let keep = 3;
  const b = new core.Backups(path.join(d, 'backups'), () => keep);
  const f = path.join(d, 'settings.json');
  for (let i = 0; i < 5; i++) {
    writeFileSync(f, `{"v":${i}}`);
    await b.take('claude-code', await core.readState(f), `change ${i}`);
  }
  const other = path.join(d, 'other.json');
  writeFileSync(other, '{}');
  await b.take('claude-code', await core.readState(other), 'other');
  const list = await b.list('claude-code', f);
  assert.deepEqual(
    list.map((e) => e.reason),
    ['change 4', 'change 3', 'change 2'],
  );
  assert.equal(await b.content(list[0]), '{"v":4}');
  assert.equal((await b.list('claude-code')).length, 4, 'the other file has its own rotation');
  if (posix) for (const n of readdirSync(path.join(d, 'backups', 'claude-code'))) assert.equal(modeOf(path.join(d, 'backups', 'claude-code', n)), 0o600, n);
  keep = 1;
  await b.take('claude-code', await core.readState(f), 'last');
  assert.deepEqual((await b.list('claude-code', f)).map((e) => e.reason), ['last']);
});

async function setup(def, text) {
  const home = tmp();
  const env = { [def.config.dirEnv]: path.join(home, 'cfg') };
  const dir = core.configDir(def, env, home);
  mkdirSync(dir, { recursive: true });
  const file = core.configFile(def, env, home);
  if (text !== undefined) writeFileSync(file, text);
  const backups = new core.Backups(path.join(home, 'storage', 'backups'), () => 10);
  return { home, dir, file, backups };
}

test('prepare writes nothing; commit backs up, then writes; restore puts the old file back', async () => {
  const s = await setup(claude, '{\n  "model": "haiku"\n}\n');
  const key = fakeKey();
  const p = profile(claude, { baseUrl: 'https://gw.test', authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'helper');
  const keyFile = path.join(s.dir, 'agent-profiles', 'user.key');
  const prep = await core.prepareApply({ def: claude, profile: p, secret: key, keyFile, configDir: s.dir, platform: process.platform, file: s.file, format: 'json' });
  assert.equal(readFileSync(s.file, 'utf8'), '{\n  "model": "haiku"\n}\n', 'untouched by prepare');
  assert.ok(!existsSync(keyFile), 'no key file before commit');
  assert.ok(!core.isNoop(prep));
  const { backup } = await core.commitApply(prep, s.backups, 'claude-code', 'Apply profile Test');
  assert.equal(readFileSync(keyFile, 'utf8'), key);
  const j = JSON.parse(readFileSync(s.file, 'utf8'));
  assert.equal(j.env.ANTHROPIC_BASE_URL, 'https://gw.test');
  assert.ok(!readFileSync(s.file, 'utf8').includes(key));
  assert.equal(backup.reason, 'Apply profile Test');
  const restore = await core.prepareRestore(backup, s.backups);
  await core.commitRestore(restore, s.backups);
  assert.equal(readFileSync(s.file, 'utf8'), '{\n  "model": "haiku"\n}\n');
  assert.equal((await s.backups.list('claude-code', s.file)).length, 2, 'the restore was backed up too');
});

test('an edit made between preview and apply is a conflict, and nothing is written', async () => {
  const s = await setup(codex, 'model = "a"\n');
  const p = profile(codex, { provider: 'openai', model: 'b' }, 'none');
  const prep = await core.prepareApply({ def: codex, profile: p, configDir: s.dir, platform: 'linux', file: s.file, format: 'toml' });
  writeFileSync(s.file, 'model = "edited elsewhere"\n');
  await assert.rejects(core.commitApply(prep, s.backups, 'codex', 'x'), (e) => e instanceof core.ConflictError && e.file === s.file);
  assert.equal(readFileSync(s.file, 'utf8'), 'model = "edited elsewhere"\n');
  assert.deepEqual(await s.backups.list('codex'), []);
});

test('a config file that did not exist: backed up as absent, restore removes it', async () => {
  const s = await setup(codex);
  const p = profile(codex, { provider: 'openai', model: 'b' }, 'none');
  const prep = await core.prepareApply({ def: codex, profile: p, configDir: s.dir, platform: 'linux', file: s.file, format: 'toml' });
  const { backup } = await core.commitApply(prep, s.backups, 'codex', 'first');
  assert.equal(readFileSync(s.file, 'utf8'), 'model_provider = "openai"\nmodel = "b"\n');
  assert.equal(backup.absent, true);
  await core.commitRestore(await core.prepareRestore(backup, s.backups), s.backups);
  assert.ok(!existsSync(s.file));
});

test('.env mode writes CODEX_HOME/.env owner-only and keeps its other lines', async () => {
  const s = await setup(codex, '');
  writeFileSync(path.join(s.dir, '.env'), 'OTHER=1\n');
  const key = fakeKey();
  const p = profile(codex, { provider: 'gw', providerName: 'G', baseUrl: 'https://gw.test/v1', envKey: 'GW_KEY' }, 'dotenv');
  const prep = await core.prepareApply({ def: codex, profile: p, secret: key, configDir: s.dir, platform: 'linux', file: s.file, format: 'toml' });
  await core.commitApply(prep, s.backups, 'codex', 'x');
  assert.equal(readFileSync(path.join(s.dir, '.env'), 'utf8'), `OTHER=1\nGW_KEY=${key}\n`);
  if (posix) assert.equal(modeOf(path.join(s.dir, '.env')), 0o600);
  assert.ok(!readFileSync(s.file, 'utf8').includes(key));
});

test('applying the same profile twice changes nothing the second time', async () => {
  const s = await setup(claude, '{}\n');
  const p = profile(claude, { model: 'opus' }, 'none');
  const args = { def: claude, profile: p, configDir: s.dir, platform: 'linux', file: s.file, format: 'json' };
  const first = await core.prepareApply(args);
  const { hash } = await core.commitApply(first, s.backups, 'claude-code', 'x');
  const second = await core.prepareApply({ ...args, prev: { ...first.plan.record, hash, at: 0 } });
  assert.ok(core.isNoop(second));
});

test('a failed config write puts the key file back: no profile is left with another profile\'s key', { skip: !posix || process.getuid?.() === 0 }, async () => {
  const s = await setup(claude, '{}\n');
  const keyFile = path.join(s.dir, 'agent-profiles', 'user.key');
  const args = (p, secret) => ({ def: claude, profile: p, secret, keyFile, configDir: s.dir, platform: 'linux', file: s.file, format: 'json' });
  const a = profile(claude, { baseUrl: 'https://gw-a.test', authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'helper');
  await core.commitApply(await core.prepareApply(args(a, 'KEY-A')), s.backups, 'claude-code', 'a');
  const configA = readFileSync(s.file, 'utf8');
  const b = profile(claude, { baseUrl: 'https://gw-b.test', authVar: 'ANTHROPIC_AUTH_TOKEN' }, 'helper');
  const prep = await core.prepareApply(args(b, 'KEY-B'));
  chmodSync(s.dir, 0o555); // the config's directory turns read-only; the key file's doesn't
  try {
    await assert.rejects(core.commitApply(prep, s.backups, 'claude-code', 'b'));
  } finally {
    chmodSync(s.dir, 0o755);
  }
  assert.equal(readFileSync(s.file, 'utf8'), configA);
  assert.equal(readFileSync(keyFile, 'utf8'), 'KEY-A');
});

test('project files are not written through symlinks or outside their folder', { skip: !posix }, async () => {
  const repo = tmp();
  writeFileSync(path.join(repo, 'package.json'), '{"name":"x"}\n');
  mkdirSync(path.join(repo, '.claude'));
  const file = path.join(repo, '.claude', 'settings.local.json');
  symlinkSync('../package.json', file);
  await assert.rejects(core.atomicWrite(file, '{"env":{"ANTHROPIC_API_KEY":"sk-x"}}', { confine: repo }), /symbolic link/);
  await assert.rejects(core.prepareApply({ def: claude, profile: profile(claude, { model: 'opus' }, 'none'), configDir: repo, platform: 'linux', file, format: 'json', confine: repo }), /symbolic link/);
  assert.equal(readFileSync(path.join(repo, 'package.json'), 'utf8'), '{"name":"x"}\n');
  const repo2 = tmp();
  const outside = tmp();
  symlinkSync(outside, path.join(repo2, '.claude'));
  await assert.rejects(core.atomicWrite(path.join(repo2, '.claude', 'settings.local.json'), '{}', { confine: repo2 }), /symbolic link/);
  assert.deepEqual(readdirSync(outside), []);
  await assert.rejects(core.atomicWrite(path.join(outside, 'x.json'), '{}', { confine: repo2 }), /outside/);
  const plain = path.join(repo2, 'sub', 'settings.local.json');
  await core.atomicWrite(plain, '{}\n', { confine: repo2 });
  assert.equal(readFileSync(plain, 'utf8'), '{}\n');
});

const hasGit = (() => {
  try {
    return execFileSync('git', ['--version']).length > 0;
  } catch {
    return false;
  }
})();

test('a project file with a key is kept out of Git', { skip: !hasGit }, async () => {
  // No global or system ignore rules: this machine's own must not decide the result.
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: tmp() });
  const repo = tmp();
  const git = (...a) => execFileSync('git', ['-c', 'core.excludesFile=/dev/null', ...a], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).toString();
  git('init', '-q');
  const file = path.join(repo, '.claude', 'settings.local.json');
  mkdirSync(path.dirname(file));
  writeFileSync(file, '{}');
  const st = await core.gitStatus(file, repo);
  assert.equal(st.kind, 'untracked');
  assert.equal(st.pattern, '/.claude/settings.local.json');
  await core.addExclude(st);
  await core.addExclude(st);
  assert.equal(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '/.claude/settings.local.json').length, 1);
  assert.equal((await core.gitStatus(file, repo)).kind, 'ignored');
  assert.equal(git('status', '--porcelain'), '');
  const tracked = path.join(repo, 'tracked.json');
  writeFileSync(tracked, '{}');
  git('add', 'tracked.json');
  assert.equal((await core.gitStatus(tracked, repo)).kind, 'tracked');
  assert.equal((await core.gitStatus(path.join(tmp(), 'x.json'), tmp())).kind, 'none');
});

test('a .gitignore rule that un-ignores the project file is noticed after the exclude rule', { skip: !hasGit }, async () => {
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: tmp() });
  const repo = tmp();
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(path.join(repo, '.gitignore'), '!/.claude/settings.local.json\n');
  const file = path.join(repo, '.claude', 'settings.local.json');
  const st = await core.gitStatus(file, repo);
  assert.equal(st.kind, 'untracked');
  await core.addExclude(st);
  // The apply checks again and refuses: the rule in .gitignore wins over info/exclude.
  assert.equal((await core.gitStatus(file, repo)).kind, 'untracked');
});

test('drift counts only the keys a profile owns', () => {
  const key = fakeKey();
  const p = profile(codex, { provider: 'gw', providerName: 'GW', baseUrl: 'https://gw.test/v1', envKey: 'GW_KEY', model: 'm1' }, 'terminal');
  const pl = core.plan({ def: codex, profile: p, secret: key, configDir: '/cfg', platform: 'linux' });
  const text = core.applyOps('toml', '', pl.ops);
  const d = core.managedDigest('toml', text, pl.record.watch);
  // Codex trusting a project is not a change to the profile.
  const trusted = text + '\n[projects."/work/x"]\ntrust_level = "trusted"\n';
  assert.equal(core.managedDigest('toml', trusted, pl.record.watch), d);
  assert.notEqual(core.managedDigest('toml', text.replace('m1', 'm2'), pl.record.watch), d);
  // A credential key added back after the apply cleared it is a change.
  assert.notEqual(core.managedDigest('toml', text.replace('env_key', 'experimental_bearer_token = "x"\nenv_key'), pl.record.watch), d);
});
