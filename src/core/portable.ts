// Moving profiles in and out: reading the agent's current config into a profile, and
// exporting / importing profiles as JSON. Exports never hold keys.
import { readDotenv } from './files';
import { context, fillPath, formatMap, holds, isCredentialHeader, looksSecretName, newProfile, parseMap } from './profile';
import { get } from './edit';
import type { AgentDef, Profile } from './types';

export interface Imported {
  profile: Profile;
  /** A key found in the config (or its .env), to offer to move into secret storage. */
  secret?: string;
  /** Where the key was found, for the message. */
  secretFrom?: string;
  notes: string[];
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : typeof v === 'object' ? undefined : String(v));
const TRUE = /^(1|true|yes|on)$/i;
const FALSE = /^(0|false|no|off|)$/i;
/** A flag such as CLAUDE_CODE_USE_BEDROCK counts as on for any of the truthy spellings. */
const constantHolds = (actual: string | undefined, expected: string | undefined) =>
  actual !== undefined && (actual === expected || (TRUE.test(expected ?? '') && TRUE.test(actual.trim())));

export function importConfig(def: AgentDef, config: Record<string, unknown>, opts: { id: string; name: string; dotenvText?: string }): Imported {
  const p = newProfile(def, opts.name, opts.id);
  const notes: string[] = [];
  // Selects without a target (Claude Code's "Service") are told by the constants they turn on.
  for (const sel of def.fields.filter((f) => f.type === 'select' && !f.target && f.options)) {
    for (const o of sel.options!) {
      const ctx = context(def, { ...p, values: { ...p.values, [sel.id]: o.value } });
      const constants = def.fields.filter((f) => f.type === 'constant' && f.target && f.when && holds(f.when, ctx) && [f.when].flat().some((w) => w.field === sel.id));
      if (constants.length && constants.every((f) => constantHolds(str(get(config, f.target!)), f.value))) {
        p.values[sel.id] = o.value;
        break;
      }
    }
  }
  // Fields whose path has no placeholder first, then the rest (e.g. Codex's provider table).
  const ordered = [...def.fields].sort((a, b) => Number((a.target ?? []).some((s) => s.includes('{'))) - Number((b.target ?? []).some((s) => s.includes('{'))));
  const owned = new Set<string>();
  const fromConfig = new Set<string>();
  for (const f of ordered) {
    if (!f.target) continue;
    let path: string[];
    try {
      path = fillPath(f.target, context(def, p));
    } catch {
      continue;
    }
    if (f.type === 'constant') {
      // A constant that is set but whose select wasn't chosen for it (an unusual spelling,
      // or a field hidden by another choice) stays as an extra variable, not lost.
      const v = str(get(config, path));
      if (holds(f.when, context(def, p)) || v === undefined || FALSE.test(v.trim())) owned.add(JSON.stringify(path));
      else notes.push(`${path.join('.')}=${v} was kept as an extra setting: it doesn't match a choice of this form.`);
      continue;
    }
    if (!(f.type === 'map' && f.spread)) owned.add(JSON.stringify(path));
    const v = get(config, path);
    if (v === undefined) continue;
    if (f.type === 'map') {
      if (!v || typeof v !== 'object') continue;
      const entries = Object.entries(v as Record<string, unknown>).filter(([k, x]) => {
        if (f.spread && owned.has(JSON.stringify([...path, k]))) return false;
        // A credential variable set to "" (OpenRouter's ANTHROPIC_API_KEY=) is a setting, not a key.
        if (f.spread && String(x) !== '' && (def.secret.clearPaths ?? []).some((cp) => JSON.stringify(cp) === JSON.stringify([...path, k]))) return false;
        if (typeof x !== 'string' && typeof x !== 'number' && typeof x !== 'boolean') return false;
        if (looksSecretName(k) && String(x)) {
          notes.push(`${k} looks like a credential and was not imported.`);
          return false;
        }
        return true;
      });
      if (entries.length) p.values[f.id] = formatMap(Object.fromEntries(entries));
      continue;
    }
    let s = str(v);
    if (s === undefined) continue;
    if (f.headerLines) {
      s = withoutCredentialHeaders(s, (name) => notes.push(`The ${name} header looks like a credential and was not imported.`));
      if (!s) continue;
    }
    fromConfig.add(f.id);
    if (f.write === 'flag') p.values[f.id] = s && s !== '0' && s !== 'false' ? 'true' : 'false';
    else p.values[f.id] = s;
  }
  // Fields filled after the spread map was read must not stay in it.
  for (const f of def.fields.filter((x) => x.type === 'map' && x.spread && x.target)) {
    const raw = p.values[f.id];
    if (!raw) continue;
    const kept = raw.split('\n').filter((l) => !owned.has(JSON.stringify([...f.target!, l.split('=')[0]])));
    if (kept.length) p.values[f.id] = kept.join('\n');
    else delete p.values[f.id];
  }

  // The key: in the config, in a .env file, or nowhere this extension can read.
  const result: Imported = { profile: p, notes };
  const ctx0 = context(def, p);
  for (const m of def.secret.modes) {
    if (m.kind !== 'config' || !m.target || !holds(m.when, ctx0)) continue;
    // A placeholder from a select (Claude Code's "Send the key as") is tried with each option.
    const sel = def.fields.find((f) => m.target!.some((s) => s.includes(`{${f.id}}`)) && f.type === 'select');
    for (const opt of sel?.options?.map((o) => o.value) ?? [undefined]) {
      const values = sel && opt ? { ...p.values, [sel.id]: opt } : p.values;
      const ctx = context(def, { ...p, values });
      if (!holds(m.when, ctx)) continue;
      let path: string[];
      try {
        path = fillPath(m.target, ctx);
      } catch {
        continue;
      }
      const v = str(get(config, path));
      if (v) {
        p.values = values;
        p.secretMode = m.id;
        result.secret = v;
        result.secretFrom = `${def.config.file} (${path.join('.')})`;
        return result;
      }
    }
  }
  const helper = def.secret.modes.find((m) => m.kind === 'helper');
  if (helper?.target && str(get(config, helper.target))) notes.push(`${helper.target.join('.')} is set in ${def.config.file}; the key it prints was not read.`);
  // A .env holding the variable first; else the variable named in the config, read from
  // the environment (only when the config itself names it, as Codex's env_key does).
  const envModes = def.secret.modes.filter((m) => m.kind === 'dotenv').concat(def.secret.modes.filter((m) => m.kind === 'terminal'));
  for (const m of envModes) {
    const named = [...(m.envVar ?? '').matchAll(/\{(\w+)\}/g)].every((x) => fromConfig.has(x[1]));
    if (m.envVar && named && holds(m.when, ctx0)) {
      let name: string;
      try {
        name = fillPath([m.envVar], ctx0)[0];
      } catch {
        continue;
      }
      if (m.kind === 'dotenv' && opts.dotenvText) {
        const v = readDotenv(opts.dotenvText)[name];
        if (v) {
          p.secretMode = m.id;
          result.secret = v;
          result.secretFrom = `${m.file} (${name})`;
          return result;
        }
      }
      if (m.kind === 'terminal') {
        p.secretMode = m.id;
        notes.push(`The key is read from ${name}; enter it here to keep it in secret storage.`);
        return result;
      }
    }
  }
  return result;
}

// ---- Export / import ------------------------------------------------------------------

export const EXPORT_FORMAT = 'agent-profiles';

/** Header lines without the ones that carry a credential. */
function withoutCredentialHeaders(text: string, dropped?: (name: string) => void): string {
  return text
    .split(/\r?\n/)
    .filter((l) => {
      const i = l.indexOf(':');
      if (i <= 0) return true;
      const name = l.slice(0, i).trim();
      if (!isCredentialHeader(name, l.slice(i + 1).trim())) return true;
      dropped?.(name);
      return false;
    })
    .join('\n')
    .trim();
}

/**
 * The values without anything that looks like a credential: entries named like keys in a
 * map field, credential lines in a header list. Used for exports, which never hold keys.
 */
export function withoutCredentials(def: AgentDef | undefined, values: Record<string, string>): Record<string, string> {
  if (!def) return { ...values };
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(values)) {
    const f = def.fields.find((x) => x.id === id);
    let keep = v;
    if (f?.type === 'map') {
      const m = parseMap(v);
      if (Object.entries(m).some(([k, x]) => x && looksSecretName(k)))
        keep = v
          .split(/\r?\n/)
          .filter((l) => {
            const i = l.indexOf('=');
            return i <= 0 || !looksSecretName(l.slice(0, i).trim()) || !l.slice(i + 1).trim();
          })
          .join('\n')
          .trim();
    } else if (f?.headerLines) keep = withoutCredentialHeaders(v);
    if (keep) out[id] = keep;
  }
  return out;
}

export function exportProfiles(profiles: Profile[], defs: AgentDef[] = []): string {
  return (
    JSON.stringify(
      {
        format: EXPORT_FORMAT,
        version: 1,
        note: 'Keys are not included. Enter them again after importing.',
        profiles: profiles.map((p) => ({ agent: p.agent, name: p.name, preset: p.preset, scope: p.scope, secretMode: p.secretMode, values: withoutCredentials(defs.find((d) => d.id === p.agent), p.values) })),
      },
      null,
      2,
    ) + '\n'
  );
}

export interface ImportResult {
  profiles: Omit<Profile, 'id'>[];
  skipped: string[];
}

export function importProfiles(text: string, defs: AgentDef[]): ImportResult {
  if (text.length > 1_000_000) throw new Error('The file is larger than 1 MB.');
  let j: { format?: string; version?: number; profiles?: unknown };
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('The file is not JSON.');
  }
  if (j?.format !== EXPORT_FORMAT || !Array.isArray(j.profiles)) throw new Error('This is not an Agent Profiles export.');
  if ((j.version ?? 1) > 1) throw new Error('The file was exported by a newer version of Agent Profiles.');
  const out: ImportResult = { profiles: [], skipped: [] };
  for (const [i, raw] of (j.profiles as Record<string, unknown>[]).slice(0, 500).entries()) {
    const def = defs.find((d) => d.id === raw?.agent);
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 80) : '';
    if (!def || !name) {
      out.skipped.push(`#${i + 1}${name ? ` (${name})` : ''}: ${def ? 'no name' : `unknown agent ${String(raw?.agent)}`}`);
      continue;
    }
    const values: Record<string, string> = {};
    const rv = raw.values && typeof raw.values === 'object' ? (raw.values as Record<string, unknown>) : {};
    for (const f of def.fields) {
      const v = rv[f.id];
      if (typeof v === 'string' && v.length <= 10_000) values[f.id] = v;
    }
    const mode = def.secret.modes.some((m) => m.id === raw.secretMode) ? String(raw.secretMode) : def.secret.modes.find((m) => m.kind === 'none')!.id;
    const preset = typeof raw.preset === 'string' && def.presets.some((p) => p.id === raw.preset) ? raw.preset : undefined;
    out.profiles.push({ agent: def.id, name, preset, values, secretMode: mode, scope: raw.scope === 'project' && def.projectConfig ? 'project' : 'user' });
  }
  return out;
}

/** "Work", "Work (2)", ... */
export function uniqueName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) if (!taken.includes(`${name} (${n})`)) return `${name} (${n})`;
}
