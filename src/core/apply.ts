// Applying a profile in two steps: prepare (read the files, work out their new content, for
// the preview) and commit (check nothing changed since, back up, write atomically).
import { applyOps, get, read } from './edit';
import { sha, assertConfined, atomicWrite, Backups, editDotenv, readState, removeFile, writePrivate, type BackupEntry, type FileState } from './files';
import { plan, type Plan, type PlanInput } from './plan';
import type { AppliedRecord } from './types';

export class ConflictError extends Error {
  constructor(readonly file: string) {
    super(`${file} changed after the preview was made.`);
  }
}

export interface FileChange {
  before: FileState;
  after: string | null;
}

export interface PreparedApply {
  plan: Plan;
  config: FileChange;
  dotenv?: FileChange;
  keyFiles: { file: string; content: string | null }[];
  /** The folder a project config must stay inside, without symlinks. */
  confine?: string;
}

export async function prepareApply(input: PlanInput & { file: string; format: 'json' | 'toml'; confine?: string }): Promise<PreparedApply> {
  const p = plan(input);
  if (input.confine) await assertConfined(input.file, input.confine);
  const before = await readState(input.file);
  const after = applyOps(input.format, before.text, p.ops);
  const out: PreparedApply = { plan: p, config: { before, after }, keyFiles: p.keyFile ?? [], confine: input.confine };
  if (p.dotenv) {
    const b = await readState(p.dotenv.file);
    out.dotenv = { before: b, after: editDotenv(b.text, p.dotenv.set, p.dotenv.remove) };
  }
  return out;
}

/** True when applying would change nothing on disk. */
export function isNoop(prep: PreparedApply): boolean {
  const same = (c?: FileChange) => !c || (c.before.exists ? c.before.text === c.after : !c.after);
  return same(prep.config) && same(prep.dotenv) && prep.keyFiles.length === 0;
}

async function unchanged(c: FileChange) {
  const now = await readState(c.before.path);
  if (now.hash !== c.before.hash) throw new ConflictError(c.before.path);
}

/**
 * Writes the .env file and key files, then the config. If any write fails, the files
 * written before it are put back as they were, so the agent never pairs one profile's
 * config with another profile's key.
 */
export async function commitApply(prep: PreparedApply, backups: Backups, agent: string, reason: string, current?: AppliedRecord): Promise<{ hash: string; backup: BackupEntry }> {
  await unchanged(prep.config);
  if (prep.dotenv) await unchanged(prep.dotenv);
  if (prep.confine) await assertConfined(prep.config.before.path, prep.confine);
  const undo: (() => Promise<void>)[] = [];
  const put = (file: string, before: FileState) => async () => {
    if (before.exists) await writePrivate(file, before.text);
    else await removeFile(file);
  };
  try {
    if (prep.dotenv && prep.dotenv.before.text !== prep.dotenv.after) {
      await backups.take(agent, prep.dotenv.before, reason, current);
      undo.push(put(prep.dotenv.before.path, prep.dotenv.before));
      if (prep.dotenv.after) await writePrivate(prep.dotenv.before.path, prep.dotenv.after);
      else await removeFile(prep.dotenv.before.path);
    }
    for (const k of prep.keyFiles) {
      undo.push(put(k.file, await readState(k.file)));
      if (k.content === null) await removeFile(k.file);
      else await writePrivate(k.file, k.content);
    }
    const backup = await backups.take(agent, prep.config.before, reason, current);
    const after = prep.config.after ?? '';
    // A config with nothing left in it is still written: the agent expects the file.
    await atomicWrite(prep.config.before.path, after, { confine: prep.confine });
    const hash = (await readState(prep.config.before.path)).hash;
    return { hash, backup };
  } catch (e) {
    for (const u of undo.reverse()) await u().catch(() => {});
    throw e;
  }
}

export interface PreparedRestore {
  entry: BackupEntry;
  before: FileState;
  after: string | null;
}

export async function prepareRestore(entry: BackupEntry, backups: Backups, confine?: string): Promise<PreparedRestore> {
  if (confine) await assertConfined(entry.file, confine);
  const before = await readState(entry.file);
  const after = (await backups.content(entry)) ?? null;
  return { entry, before, after };
}

export async function commitRestore(r: PreparedRestore, backups: Backups, current?: AppliedRecord, confine?: string): Promise<void> {
  await unchanged({ before: r.before, after: r.after });
  if (confine) await assertConfined(r.entry.file, confine);
  await backups.take(r.entry.agent, r.before, `Before restoring the copy from ${new Date(r.entry.at).toLocaleString()}`, current);
  if (r.after === null) await removeFile(r.entry.file);
  else await atomicWrite(r.entry.file, r.after, { confine });
}

/**
 * A hash of the values at the paths a profile owns. The agents write to the same files
 * (Codex trusts a project, Claude Code remembers a setting); that is not a change to the
 * profile, so drift is measured on these values only. Throws if the text can't be read.
 */
export function managedDigest(format: 'json' | 'toml', text: string, paths: string[][]): string {
  const v = read(format, text);
  return sha(JSON.stringify(paths.map((p) => [p, get(v, p) ?? null])));
}

/** Reads a config file into an object, or explains why it can't. */
export async function readConfig(file: string, format: 'json' | 'toml') {
  const s = await readState(file);
  return { state: s, value: read(format, s.text) };
}
