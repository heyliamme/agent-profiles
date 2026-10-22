// Profiles: conditions, defaults, presets, validation, and placeholders in key paths.
import type { AgentDef, FieldDef, Issue, PresetDef, Profile, SecretMode, When } from './types';

/** The values a `when` can test: the profile's fields and its secret mode. */
export function context(def: AgentDef, p: Pick<Profile, 'values' | 'secretMode'>): Record<string, string> {
  const ctx: Record<string, string> = {};
  for (const f of def.fields) ctx[f.id] = p.values[f.id] ?? f.default ?? '';
  ctx.secretMode = p.secretMode;
  return ctx;
}

export function holds(when: When | When[] | undefined, ctx: Record<string, string>): boolean {
  if (!when) return true;
  const all = Array.isArray(when) ? when : [when];
  return all.every((w) => {
    const v = ctx[w.field] ?? '';
    if (w.equals !== undefined && v !== w.equals) return false;
    if (w.notEquals !== undefined && v === w.notEquals) return false;
    if (w.in && !w.in.includes(v)) return false;
    if (w.notIn && w.notIn.includes(v)) return false;
    if (w.set !== undefined && (v !== '') !== w.set) return false;
    return true;
  });
}

export function visibleFields(def: AgentDef, p: Pick<Profile, 'values' | 'secretMode'>): FieldDef[] {
  const ctx = context(def, p);
  return def.fields.filter((f) => holds(f.when, ctx));
}

export function availableModes(def: AgentDef, p: Pick<Profile, 'values' | 'secretMode'>): SecretMode[] {
  const ctx = context(def, p);
  return def.secret.modes.filter((m) => holds(m.when, ctx));
}

export function secretMode(def: AgentDef, p: Pick<Profile, 'secretMode'>): SecretMode {
  return def.secret.modes.find((m) => m.id === p.secretMode) ?? def.secret.modes.find((m) => m.kind === 'none')!;
}

/** Fills `{field}` placeholders. Throws when one is empty: a key path can't have a hole. */
export function fill(template: string, ctx: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = ctx[k];
    if (!v) throw new Error(`"${k}" is empty`);
    return v;
  });
}

export function fillPath(path: string[], ctx: Record<string, string>): string[] {
  return path.map((s) => fill(s, ctx));
}

/** `KEY=value` lines to an object. Blank lines and lines starting with # are skipped. */
export function parseMap(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function formatMap(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('\n');
}

/** Names that suggest a credential: those values belong in secret storage, not in a field. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?$|^AUTHORIZATION$|^X-API-KEY$/i;
export const looksSecretName = (name: string) => SECRET_NAME.test(name.replace(/-/g, '_')) || /^authorization$/i.test(name);

/** `Name: value` lines to an object. Lines without a colon are skipped. */
export function parseHeaderLines(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of (text ?? '').split(/\r?\n/)) {
    const i = l.indexOf(':');
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}

/** A header that carries a credential: named like one, or a Bearer/Basic token. */
export const isCredentialHeader = (name: string, value: string) => !!value && (looksSecretName(name) || /^proxy-authorization$/i.test(name) || /^(Bearer|Basic)\s+\S/i.test(value));

/** Names of the header lines that carry a credential. */
export function credentialHeaders(text: string | undefined): string[] {
  return Object.entries(parseHeaderLines(text))
    .filter(([k, v]) => isCredentialHeader(k, v))
    .map(([k]) => k);
}

export function newProfile(def: AgentDef, name: string, id: string): Profile {
  const values: Record<string, string> = {};
  for (const f of def.fields) if (f.default !== undefined) values[f.id] = f.default;
  const mode = def.secret.modes.find((m) => m.kind === 'none')!.id;
  return { id, agent: def.id, name, values, secretMode: mode, scope: 'user' };
}

export function fromPreset(def: AgentDef, preset: PresetDef, id: string, name = preset.label): Profile {
  const p = newProfile(def, name, id);
  p.preset = preset.id;
  p.values = { ...p.values, ...preset.values };
  p.secretMode = preset.secretMode;
  return p;
}

/** True when the profile needs a key from secret storage to be applied. */
export function needsSecret(def: AgentDef, p: Profile): boolean {
  const m = secretMode(def, p);
  return m.kind !== 'none' && availableModes(def, p).some((x) => x.id === m.id);
}

/** Problems that stop a profile from being applied, field by field. */
export function validate(def: AgentDef, p: Profile, opts: { hasSecret?: boolean } = {}): Issue[] {
  const issues: Issue[] = [];
  if (!p.name.trim()) issues.push({ field: 'name', message: 'Give the profile a name.' });
  if (p.agent !== def.id) issues.push({ field: 'agent', message: `This profile is for ${p.agent}, not ${def.id}.` });
  const ctx = context(def, p);
  const modes = availableModes(def, p);
  if (!modes.some((m) => m.id === p.secretMode)) issues.push({ field: 'secretMode', message: 'Choose where the key goes: this option is not available with these settings.' });
  const visible = visibleFields(def, p);
  const owned = new Set<string>();
  for (const f of visible) {
    if (f.target && !f.spread) {
      try {
        owned.add(fillPath(f.target, ctx).join('\u0000'));
      } catch {
        /* reported below */
      }
    }
  }
  for (const f of visible) {
    const v = (p.values[f.id] ?? f.default ?? '').trim();
    const required = f.required && (!f.requiredWhen || holds(f.requiredWhen, ctx));
    if (!v) {
      if (required) issues.push({ field: f.id, message: `${f.label} is required.` });
      continue;
    }
    if (f.type === 'url') {
      let u: URL | undefined;
      try {
        u = new URL(v);
      } catch {
        /* below */
      }
      if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) issues.push({ field: f.id, message: 'Enter a full http:// or https:// address.' });
      else if (u.username || u.password) issues.push({ field: f.id, message: "Don't put credentials in the address: use the key field." });
      else if (/YOUR_|example\.com$/i.test(u.hostname) || v === 'https://') issues.push({ field: f.id, message: 'Replace the placeholder with your own address.' });
    }
    if (f.type === 'number') {
      const n = Number(v);
      if (!/^-?\d+$/.test(v) || !Number.isSafeInteger(n)) issues.push({ field: f.id, message: 'Enter a whole number.' });
      else if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) issues.push({ field: f.id, message: `Between ${f.min ?? '…'} and ${f.max ?? '…'}.` });
    }
    if (f.type === 'boolean' && v !== 'true' && v !== 'false') issues.push({ field: f.id, message: 'true or false.' });
    if (f.type === 'select' && !f.freeform && f.options && !f.options.some((o) => o.value === v)) issues.push({ field: f.id, message: `Choose one of the options.` });
    if (f.pattern && !new RegExp(f.pattern).test(v.replace(/\r\n/g, '\n'))) issues.push({ field: f.id, message: f.patternMessage ?? 'Not in the expected format.' });
    if (f.reserved && (f.reserved.values?.includes(v) || (f.reserved.pattern && new RegExp(f.reserved.pattern, 'i').test(v)))) issues.push({ field: f.id, message: f.reserved.message });
    if (f.headerLines) {
      for (const name of credentialHeaders(v)) issues.push({ field: f.id, message: `${name} looks like a credential. Keys go in the key field, where they are kept in secret storage.` });
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) issues.push({ field: f.id, message: 'Contains control characters.' });
    if (f.type === 'map') {
      for (const [k, val] of Object.entries(parseMap(v))) {
        if (val && looksSecretName(k)) issues.push({ field: f.id, message: `${k} looks like a credential. Keys go in the key field, where they are kept in secret storage.` });
        if (f.spread && f.target && owned.has([...fillPath(f.target, ctx), k].join('\u0000'))) issues.push({ field: f.id, message: `${k} is set by another field of this form.` });
      }
    }
  }
  const mode = secretMode(def, p);
  if (mode.kind !== 'none' && opts.hasSecret === false) issues.push({ field: 'secret', message: `Enter the ${def.secret.label.toLowerCase()}, or choose "${def.secret.modes.find((m) => m.kind === 'none')!.label}".` });
  for (const t of [mode.target, mode.envVar ? [mode.envVar] : undefined]) {
    if (!t) continue;
    try {
      fillPath(t, ctx);
    } catch (e) {
      issues.push({ field: 'secretMode', message: `Can't use this option yet: ${(e as Error).message}.` });
    }
  }
  if (mode.kind === 'config' || mode.kind === 'terminal' || mode.kind === 'dotenv') {
    // A key passed as an environment variable must not collide with extra variables.
    const name = mode.envVar ? safeFill(mode.envVar, ctx) : mode.target ? safeFill(mode.target[mode.target.length - 1], ctx) : '';
    for (const f of visible.filter((x) => x.type === 'map' && x.spread)) {
      if (name && name in parseMap(p.values[f.id])) issues.push({ field: f.id, message: `${name} carries the key; remove it from here.` });
    }
  }
  return issues;
}

function safeFill(t: string, ctx: Record<string, string>) {
  try {
    return fill(t, ctx);
  } catch {
    return '';
  }
}

/** The profile with only the values its visible fields use, trimmed. */
export function normalize(def: AgentDef, p: Profile): Profile {
  const values: Record<string, string> = {};
  for (const f of def.fields) {
    const v = p.values[f.id];
    if (v !== undefined && v !== '') values[f.id] = f.type === 'text' || f.type === 'map' ? v.replace(/\r\n/g, '\n').trim() : v.trim();
  }
  return { ...p, name: p.name.trim(), values };
}

export function statusText(def: AgentDef, p: Profile | undefined): string {
  if (!p) return '';
  return p.values[def.statusField] || def.statusFallback;
}
