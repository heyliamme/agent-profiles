// Agent definitions are data. This checks one is well-formed, so a mistake in a JSON file
// fails the tests instead of writing a wrong key into someone's config.
import claudeCode from './agents/claude-code.json';
import codex from './agents/codex.json';
import type { AgentDef, When } from './types';

const FIELD_TYPES = ['string', 'url', 'select', 'number', 'boolean', 'map', 'text', 'id', 'constant'];
const KINDS = ['none', 'config', 'helper', 'terminal', 'dotenv'];
const GROUPS = ['connection', 'models', 'advanced'];

export function checkAgentDef(raw: unknown): string[] {
  const errs: string[] = [];
  const d = raw as AgentDef;
  const err = (m: string) => errs.push(`${d?.id ?? '?'}: ${m}`);
  if (!d || typeof d !== 'object') return ['not an object'];
  if (!/^[a-z][a-z0-9-]*$/.test(d.id ?? '')) err('id must be lowercase letters, digits and -');
  for (const k of ['label', 'short', 'statusField', 'statusFallback'] as const) if (typeof d[k] !== 'string' || !d[k]) err(`${k} is required`);
  if (!Array.isArray(d.docs) || d.docs.some((u) => !/^https:\/\//.test(u))) err('docs must be https URLs');
  if (!d.config || !['json', 'toml'].includes(d.config.format)) err('config.format must be json or toml');
  if (!d.config?.file || /[\\/]/.test(d.config.file)) err('config.file must be a file name');
  if (!d.config?.defaultDir?.startsWith('~')) err('config.defaultDir must start with ~');
  if (d.projectConfig && (!['json', 'toml'].includes(d.projectConfig.format) || d.projectConfig.file.startsWith('/') || d.projectConfig.file.includes('..'))) err('projectConfig must be a relative file');
  const fields = Array.isArray(d.fields) ? d.fields : [];
  if (!fields.length) err('fields are required');
  const ids = new Set<string>();
  for (const f of fields) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(f.id ?? '')) err(`field id ${f.id} is not an identifier`);
    if (ids.has(f.id)) err(`field ${f.id} is defined twice`);
    if (f.id === 'secretMode' || f.id === 'name') err(`field id ${f.id} is reserved`);
    ids.add(f.id);
  }
  const known = new Set([...ids, 'secretMode']);
  const checkWhen = (w: When | When[] | undefined, where: string) => {
    for (const c of w ? (Array.isArray(w) ? w : [w]) : []) {
      if (!known.has(c.field)) err(`${where}: condition on unknown field ${c.field}`);
      const tests = ['equals', 'notEquals', 'in', 'notIn', 'set'].filter((k) => k in c);
      if (!tests.length) err(`${where}: condition on ${c.field} tests nothing`);
    }
  };
  const checkPath = (p: unknown, where: string) => {
    if (!Array.isArray(p) || !p.length || p.some((s) => typeof s !== 'string' || !s)) return err(`${where}: target must be a non-empty list of names`);
    for (const s of p as string[]) for (const m of s.matchAll(/\{(\w+)\}/g)) if (!ids.has(m[1])) err(`${where}: placeholder {${m[1]}} is not a field`);
  };
  const targets = new Map<string, string>();
  for (const f of fields) {
    const where = `field ${f.id}`;
    if (!FIELD_TYPES.includes(f.type)) err(`${where}: unknown type ${f.type}`);
    if (!GROUPS.includes(f.group)) err(`${where}: unknown group ${f.group}`);
    if (!f.label || !f.help) err(`${where}: label and help are required`);
    if (f.target !== undefined) {
      checkPath(f.target, where);
      const key = (f.target ?? []).join('.') + (f.spread ? '.*' : '');
      // Two fields may share a target only if they can never both be visible: not checked
      // here beyond exact duplicates without conditions.
      if (targets.has(key) && !f.when) err(`${where}: same target as ${targets.get(key)}`);
      targets.set(key, f.id);
    }
    if (f.type === 'constant' && (f.value === undefined || !f.target)) err(`${where}: a constant needs a value and a target`);
    if (f.type === 'select' && (!f.options || !f.options.length)) err(`${where}: a select needs options`);
    if (f.spread && f.type !== 'map') err(`${where}: only a map can spread`);
    if (f.write && !['string', 'number', 'boolean', 'flag'].includes(f.write)) err(`${where}: unknown write ${f.write}`);
    if (f.write === 'flag' && f.type !== 'boolean') err(`${where}: flag is for booleans`);
    if (f.pattern) {
      try {
        new RegExp(f.pattern);
      } catch {
        err(`${where}: pattern is not a regular expression`);
      }
    }
    if (f.reserved?.pattern) {
      try {
        new RegExp(f.reserved.pattern, 'i');
      } catch {
        err(`${where}: reserved.pattern is not a regular expression`);
      }
    }
    if (f.headerLines && f.type !== 'text') err(`${where}: headerLines is for text fields`);
    if (f.default !== undefined && f.options && !f.freeform && !f.options.some((o) => o.value === f.default)) err(`${where}: default is not an option`);
    checkWhen(f.when, where);
    checkWhen(f.requiredWhen, where);
  }
  const modes = d.secret?.modes ?? [];
  if (!d.secret?.label || !d.secret?.help) err('secret.label and secret.help are required');
  if (!modes.some((m) => m.kind === 'none' && !m.when)) err('secret needs an unconditional mode of kind none');
  const mids = new Set<string>();
  for (const m of modes) {
    const where = `secret mode ${m.id}`;
    if (mids.has(m.id)) err(`${where} is defined twice`);
    mids.add(m.id);
    if (!KINDS.includes(m.kind)) err(`${where}: unknown kind ${m.kind}`);
    if ((m.kind === 'config' || m.kind === 'helper') && !m.target) err(`${where}: needs a target`);
    if (m.target) checkPath(m.target, where);
    if ((m.kind === 'terminal' || m.kind === 'dotenv') && !m.envVar) err(`${where}: needs envVar`);
    if (m.envVar) checkPath([m.envVar], where);
    if (m.kind === 'dotenv' && (!m.file || /[\\/]/.test(m.file))) err(`${where}: needs a file name`);
    if (typeof m.plaintext !== 'boolean') err(`${where}: plaintext must be true or false`);
    if (m.kind === 'config' || m.kind === 'helper' || m.kind === 'dotenv') {
      if (!m.plaintext) err(`${where}: a key written to a file is plain text`);
    }
    if (!m.label || !m.help) err(`${where}: label and help are required`);
    checkWhen(m.when, where);
  }
  for (const p of d.secret?.clearPaths ?? []) checkPath(p, 'secret.clearPaths');
  const pids = new Set<string>();
  for (const p of d.presets ?? []) {
    const where = `preset ${p.id}`;
    if (pids.has(p.id)) err(`${where} is defined twice`);
    pids.add(p.id);
    if (!mids.has(p.secretMode)) err(`${where}: unknown secret mode ${p.secretMode}`);
    for (const k of Object.keys(p.values ?? {})) if (!ids.has(k)) err(`${where}: unknown field ${k}`);
    if (p.docs && !/^https:\/\//.test(p.docs)) err(`${where}: docs must be https`);
    if (!p.label || !p.description) err(`${where}: label and description are required`);
  }
  if (!ids.has(d.statusField)) err(`statusField ${d.statusField} is not a field`);
  if (d.test) {
    const t = d.test;
    for (const f of [t.baseUrlField, t.authBy, t.headersField, t.queryField, t.defaultBaseUrlBy, t.probe?.modelField]) if (f && !ids.has(f)) err(`test: unknown field ${f}`);
    if (!t.list?.path?.startsWith('/') || !t.probe?.path?.startsWith('/')) err('test: paths must start with /');
    if (!t.unsupported) err('test.unsupported is required');
    for (const [a, f] of Object.entries(t.probe?.aliases ?? {})) if (f && !ids.has(f)) err(`test: alias ${a} names unknown field ${f}`);
    checkWhen(t.when, 'test');
  }
  return errs;
}

export const AGENTS: AgentDef[] = [claudeCode as unknown as AgentDef, codex as unknown as AgentDef];

export function agent(id: string): AgentDef {
  const d = AGENTS.find((a) => a.id === id);
  if (!d) throw new Error(`Unknown agent ${id}`);
  return d;
}
