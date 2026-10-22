// Keeping a project file that holds a key out of Git. Claude Code adds its own ignore rule
// only for a settings.local.json it creates itself; one written by this extension has to be
// covered here.
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';

export type GitStatus =
  /** Not in a Git work tree (or Git isn't installed): nothing to do. */
  | { kind: 'none' }
  | { kind: 'ignored' }
  /** Git would list the file as untracked: `exclude` is where a rule can go. */
  | { kind: 'untracked'; exclude: string; pattern: string }
  /** Already committed: an ignore rule wouldn't help. */
  | { kind: 'tracked' };

function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 10_000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, out: String(stdout).trim() });
    });
  });
}

export async function gitStatus(file: string, folder: string): Promise<GitStatus> {
  const top = await git(folder, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.out) return { kind: 'none' };
  const root = await fs.realpath(top.out).catch(() => top.out);
  const realFolder = await fs.realpath(folder).catch(() => folder);
  const rel = path.relative(root, path.join(realFolder, path.relative(folder, file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { kind: 'none' };
  const relPosix = rel.split(path.sep).join('/');
  if ((await git(root, ['ls-files', '--error-unmatch', '--', relPosix])).code === 0) return { kind: 'tracked' };
  const ign = await git(root, ['check-ignore', '-q', '--', relPosix]);
  if (ign.code === 0) return { kind: 'ignored' };
  if (ign.code !== 1) return { kind: 'none' };
  const ex = await git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (ex.code !== 0 || !ex.out) return { kind: 'none' };
  return { kind: 'untracked', exclude: path.resolve(root, ex.out), pattern: '/' + relPosix };
}

/** Adds the rule to .git/info/exclude, which is local to this clone and never committed. */
export async function addExclude(status: Extract<GitStatus, { kind: 'untracked' }>): Promise<void> {
  let text = '';
  try {
    text = await fs.readFile(status.exclude, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (text.split(/\r?\n/).includes(status.pattern)) return;
  await fs.mkdir(path.dirname(status.exclude), { recursive: true });
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  await fs.writeFile(status.exclude, `${text}${sep}# Holds a key written by Agent Profiles\n${status.pattern}\n`);
}
