// File handling for the config files: where they are, atomic writes that keep permissions
// (and write through symlinks, so dotfile managers keep working), rotating backups, and
// small text formats around the config (.env). Node only, no VS Code.
import { createHash, randomBytes } from 'crypto';
import { promises as fs, constants } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentDef, AppliedRecord } from './types';

export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** The agent's config directory: its environment variable, else the default under home. */
export function configDir(def: AgentDef, env: Record<string, string | undefined> = process.env, home = os.homedir()): string {
  const fromEnv = def.config.dirEnv ? env[def.config.dirEnv]?.trim() : undefined;
  if (fromEnv) return path.resolve(fromEnv.replace(/^~(?=$|[\\/])/, home));
  return path.join(home, def.config.defaultDir.replace(/^~[\\/]?/, ''));
}

export function configFile(def: AgentDef, env?: Record<string, string | undefined>, home?: string): string {
  return path.join(configDir(def, env, home), def.config.file);
}

export interface FileState {
  path: string;
  exists: boolean;
  text: string;
  /** Hash of the content, or "absent". */
  hash: string;
}

export async function readState(file: string): Promise<FileState> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return { path: file, exists: true, text, hash: sha(text) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { path: file, exists: false, text: '', hash: 'absent' };
    throw e;
  }
}

/** Where a write really lands: the target of a symlink, followed. */
async function realTarget(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch {
    return file;
  }
}

/**
 * Refuses a path under `root` that goes through a symbolic link, or that leaves `root`.
 * Project settings live in a folder the repository controls: a link committed there could
 * send a write (and a key) into a tracked file or out of the workspace.
 */
export async function assertConfined(file: string, root: string): Promise<void> {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is outside ${root}.`);
  let cur = root;
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error(`${path.relative(root, cur)} is a symbolic link. Project settings are not written through links; nothing was written.`);
  }
}

/**
 * Writes atomically: a temporary file next to the target, flushed, then renamed over it.
 * An existing file keeps its permissions; a new one gets `mode` (default 600). Symlinks are
 * followed, unless `confine` names the folder the file must stay in without links.
 */
export async function atomicWrite(file: string, content: string, opts: { mode?: number; dirMode?: number; confine?: string } = {}): Promise<void> {
  if (opts.confine) await assertConfined(file, opts.confine);
  const target = opts.confine ? file : await realTarget(file);
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: opts.dirMode ?? 0o700 });
  let mode = opts.mode ?? 0o600;
  try {
    mode = (await fs.stat(target)).mode & 0o7777;
  } catch {
    /* new file */
  }
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  const h = await fs.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await h.writeFile(content, 'utf8');
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Writes a file only its owner can read, in a directory only its owner can enter. */
export async function writePrivate(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, content, { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
}

export async function removeFile(file: string): Promise<void> {
  await fs.rm(file, { force: true });
}

// ---- Backups -------------------------------------------------------------------------

export interface BackupEntry {
  id: string;
  agent: string;
  /** The file it is a copy of. */
  file: string;
  /** The file didn't exist: restoring removes it. */
  absent: boolean;
  at: number;
  /** What the change it preceded was, such as "Apply profile Work". */
  reason: string;
  /** What this extension had applied to the file at the time (key names only, no values). */
  record?: AppliedRecord | null;
}

/** Rotating copies of config files taken before each write, newest first. */
export class Backups {
  constructor(
    private readonly dir: string,
    private readonly keep: () => number,
  ) {}

  private agentDir(agent: string) {
    return path.join(this.dir, agent.replace(/[^a-z0-9-]/gi, '_'));
  }

  async take(agent: string, state: FileState, reason: string, record?: AppliedRecord | null): Promise<BackupEntry> {
    const dir = this.agentDir(agent);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const at = Date.now();
    const id = `${new Date(at).toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
    const entry: BackupEntry = { id, agent, file: state.path, absent: !state.exists, at, reason, record: record ?? null };
    // Copies can hold keys a config file had in plain text: owner-only, like the original.
    if (state.exists) await writePrivate(path.join(dir, `${id}.bak`), state.text);
    await writePrivate(path.join(dir, `${id}.json`), JSON.stringify(entry, null, 2));
    await this.rotate(agent, state.path);
    return entry;
  }

  async list(agent: string, file?: string): Promise<BackupEntry[]> {
    const dir = this.agentDir(agent);
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: BackupEntry[] = [];
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      try {
        const e = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8')) as BackupEntry;
        if (!file || e.file === file) out.push(e);
      } catch {
        /* a broken entry is skipped */
      }
    }
    return out.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  }

  async content(e: BackupEntry): Promise<string | undefined> {
    if (e.absent) return undefined;
    return fs.readFile(path.join(this.agentDir(e.agent), `${e.id}.bak`), 'utf8');
  }

  private async rotate(agent: string, file: string) {
    const keep = Math.max(1, Math.floor(this.keep()));
    const all = await this.list(agent, file);
    for (const e of all.slice(keep)) {
      await fs.rm(path.join(this.agentDir(agent), `${e.id}.bak`), { force: true });
      await fs.rm(path.join(this.agentDir(agent), `${e.id}.json`), { force: true });
    }
  }
}

// ---- .env ---------------------------------------------------------------------------

const ENV_LINE = (name: string) => new RegExp(`^\\s*(?:export\\s+)?${name.replace(/[^A-Za-z0-9_]/g, '')}\\s*=`);

export function dotenvValue(v: string): string {
  if (/[\r\n\0]/.test(v)) throw new Error('A key with a line break cannot go into a .env file.');
  if (/^[A-Za-z0-9_\-.~+/=:@]*$/.test(v)) return v;
  // Codex reads .env with dotenvy, which expands $NAME inside double quotes but not single.
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/[\\"$]/g, '\\$&')}"`;
}

/** Sets and removes variables in .env text, leaving every other line as it was. */
export function editDotenv(text: string, set: { name: string; value: string } | undefined, remove: string[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const name of remove) lines = lines.filter((l) => !ENV_LINE(name).test(l));
  if (set) {
    const line = `${set.name}=${dotenvValue(set.value)}`;
    const i = lines.findIndex((l) => ENV_LINE(set.name).test(l));
    if (i >= 0) {
      lines[i] = line;
      lines = lines.filter((l, j) => j <= i || !ENV_LINE(set.name).test(l));
    } else lines.push(line);
  }
  return lines.length ? lines.join(eol) + eol : '';
}

/** Reads NAME=value lines the way dotenvy does: quotes, and a trailing # comment. */
export function readDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const raw = m[2];
    let v: string;
    let q: RegExpMatchArray | null;
    if ((q = raw.match(/^"((?:[^"\\]|\\.)*)"/))) v = q[1].replace(/\\(["\\$])/g, '$1');
    else if ((q = raw.match(/^'([^']*)'/))) v = q[1];
    else v = raw.replace(/\s#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}
