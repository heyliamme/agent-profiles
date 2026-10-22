// What applying a profile changes, as a list of key operations on the agent's config file
// plus the files around it (a key file, a .env file). Pure: no file is read or written.
//
// The rule that keeps switching safe: every key a profile can manage is either set to the
// new profile's value or removed, and every key the previous apply set is removed unless
// set again. Nothing from the old profile carries over; keys no profile manages are never
// touched.
import { context, fillPath, holds, parseMap, secretMode } from './profile';
import type { AgentDef, AppliedRecord, Op, Profile } from './types';

export interface PlanInput {
  def: AgentDef;
  profile: Profile;
  /** The key, when the profile's secret mode needs one. */
  secret?: string;
  /** What the extension wrote to the same file last time. */
  prev?: AppliedRecord;
  /** Where a helper key file goes. */
  keyFile?: string;
  /** The agent's config directory (for a .env file). */
  configDir: string;
  platform: string;
}

export interface Plan {
  ops: Op[];
  keyFile?: { file: string; content: string | null }[];
  dotenv?: { file: string; set?: { name: string; value: string }; remove: string[] };
  terminal?: { name: string; value: string };
  record: Omit<AppliedRecord, 'hash' | 'at'>;
}

const k = (p: string[]) => JSON.stringify(p);

export function helperCommand(file: string, platform: string): string {
  if (platform === 'win32') return `type "${file.replace(/"/g, '')}"`;
  return `cat '${file.replace(/'/g, `'\\''`)}'`;
}

function join(dir: string, name: string, platform: string) {
  const sep = platform === 'win32' ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

export function plan(input: PlanInput): Plan {
  const { def, profile: p, prev } = input;
  const ctx = context(def, p);
  const ops = new Map<string, Op>();
  const del = (path: string[]) => ops.set(k(path), { path, value: undefined });
  const set = (path: string[], value: unknown) => ops.set(k(path), { path, value });
  const tryFill = (path: string[]) => {
    try {
      return fillPath(path, ctx);
    } catch {
      return undefined;
    }
  };

  // 1. Take back what the last apply wrote, and clear every credential key.
  for (const path of prev?.paths ?? []) del(path);
  for (const path of def.secret.clearPaths ?? []) {
    const r = tryFill(path);
    if (r) del(r);
  }
  // 2. Every managed key: the profile's value, or removed.
  for (const f of def.fields) {
    if (!f.target) continue;
    const path = tryFill(f.target);
    if (!path) continue;
    const visible = holds(f.when, ctx);
    const raw = (p.values[f.id] ?? (f.type === 'constant' ? '' : f.default) ?? '').trim();
    if (f.type === 'map' && f.spread) {
      if (!visible) continue;
      for (const [name, value] of Object.entries(parseMap(raw))) set([...path, name], value);
      continue;
    }
    if (!visible) {
      del(path);
      continue;
    }
    if (f.type === 'constant') {
      set(path, f.value);
      continue;
    }
    if (!raw) {
      del(path);
      continue;
    }
    if (f.type === 'map') {
      const m = parseMap(raw);
      if (Object.keys(m).length) set(path, m);
      else del(path);
    } else if (f.write === 'flag') {
      if (raw === 'true') set(path, '1');
      else del(path);
    } else if (f.write === 'boolean') set(path, raw === 'true');
    else if (f.write === 'number') set(path, Number(raw));
    else set(path, raw);
  }

  // 3. The key.
  const mode = secretMode(def, p);
  const record: Plan['record'] = { profileId: p.id, profileName: p.name, paths: [] };
  const out: Plan = { ops: [], record };
  const needKey = () => {
    if (!input.secret) throw new Error(`No ${def.secret.label.toLowerCase()} is saved for "${p.name}".`);
    return input.secret;
  };
  // Helper modes own their target (apiKeyHelper) only while they are in use, or if the
  // last apply set it: someone's own apiKeyHelper is otherwise left alone.
  for (const m of def.secret.modes) {
    if (m.kind !== 'helper' || !m.target || m.id === mode.id) continue;
    const r = tryFill(m.target);
    if (r && prev?.keyFile && prev.paths.some((x) => k(x) === k(r))) del(r);
  }
  if (mode.kind === 'config') set(fillPath(mode.target!, ctx), needKey());
  if (mode.kind === 'helper') {
    if (!input.keyFile) throw new Error('No place for the key file.');
    set(fillPath(mode.target!, ctx), helperCommand(input.keyFile, input.platform));
    out.keyFile = [{ file: input.keyFile, content: needKey() }];
    record.keyFile = input.keyFile;
  }
  if (prev?.keyFile && prev.keyFile !== record.keyFile) (out.keyFile ??= []).push({ file: prev.keyFile, content: null });
  if (mode.kind === 'terminal') {
    const name = fillPath([mode.envVar!], ctx)[0];
    out.terminal = { name, value: needKey() };
    record.terminalVar = name;
  }
  if (mode.kind === 'dotenv') {
    const name = fillPath([mode.envVar!], ctx)[0];
    const file = join(input.configDir, mode.file!, input.platform);
    out.dotenv = { file, set: { name, value: needKey() }, remove: prev?.dotenv && prev.dotenv.file === file && prev.dotenv.name !== name ? [prev.dotenv.name] : [] };
    record.dotenv = { file, name };
  }
  if (prev?.dotenv && !(record.dotenv && record.dotenv.file === prev.dotenv.file)) out.dotenv = { file: prev.dotenv.file, remove: [prev.dotenv.name] };

  out.ops = [...ops.values()];
  record.paths = out.ops.filter((o) => o.value !== undefined).map((o) => o.path);
  record.watch = out.ops.map((o) => o.path);
  return out;
}

/** The parts of the profile a person would recognise in a summary, without the key. */
export function describe(def: AgentDef, p: Profile): string[] {
  const ctx = context(def, p);
  const lines: string[] = [];
  for (const f of def.fields) {
    if (!holds(f.when, ctx) || f.type === 'constant') continue;
    const v = p.values[f.id];
    if (v) lines.push(`${f.label}: ${v.split('\n').join(', ')}`);
  }
  lines.push(`Key: ${secretMode(def, p).label}`);
  return lines;
}
