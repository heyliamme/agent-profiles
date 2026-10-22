import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { after } from 'node:test';

export const core = createRequire(import.meta.url)('../dist/core.js');
export const claude = core.agent('claude-code');
export const codex = core.agent('codex');

// Every test works in a throwaway folder that stands in for the home directory; nothing
// here ever looks at the real ~/.claude or ~/.codex.
const made = [];
export function tmp(prefix = 'agent-profiles-test-') {
  const d = realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A fake key that looks like one, unique per call, so tests can grep for leaks. */
let n = 0;
export const fakeKey = (p = 'sk-test') => `${p}-${'FAKEKEY'}${String(++n).padStart(4, '0')}abcdefghijklmnop`;

export function profile(def, values, secretMode = 'none', extra = {}) {
  const p = core.newProfile(def, extra.name ?? 'Test', extra.id ?? `p${++n}`);
  p.values = { ...p.values, ...values };
  p.secretMode = secretMode;
  return { ...p, ...extra };
}

export function applyText(def, text, prof, { secret, prev, keyFile = '/k/user.key', format } = {}) {
  const pl = core.plan({ def, profile: prof, secret, prev, keyFile, configDir: '/cfg', platform: 'linux' });
  return { text: core.applyOps(format ?? def.config.format, text, pl.ops), plan: pl, record: pl.record };
}
