// Everything that touches the agents' files on behalf of a command or the webview:
// applying a profile (preview, confirm, write), restoring a backup, importing the current
// config, testing a connection, and handing keys to VS Code terminals.
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENTS, agent } from './core/defs';
import {
  Backups,
  commitApply,
  commitRestore,
  ConfigSyntaxError,
  ConflictError,
  configDir,
  configFile,
  addExclude,
  gitStatus,
  importConfig,
  isNoop,
  managedDigest,
  maskText,
  needsSecret,
  prepare,
  prepareApply,
  prepareRestore,
  read,
  readState,
  runTest,
  secretMode,
  secretsIn,
  secretsInDotenv,
  sha,
  uniqueName,
  validate,
  writePrivate,
  removeFile,
  editDotenv,
  tilde,
  type BackupEntry,
  type PreparedApply,
} from './core/index';
import type { AgentDef, AppliedRecord, Profile, Scope } from './core/types';

export { tilde };
import type { TestOutcome } from './protocol';
import { Store } from './store';

export const PREVIEW_SCHEME = 'agent-profiles-preview';

export interface Target {
  def: AgentDef;
  scope: Scope;
  file: string;
  format: 'json' | 'toml';
  configDir: string;
  keyFile: string;
  folder?: vscode.WorkspaceFolder;
  /** A project file must stay inside its folder, without symlinks. */
  confine?: string;
}

/** Workspace folders on disk. A virtual folder (vscode-vfs, memfs) has no project file. */
export function diskFolders(): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file');
}

/** Read-only documents for the diff preview, with keys masked. */
export class PreviewDocs implements vscode.TextDocumentContentProvider {
  private readonly docs = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private n = 0;
  provideTextDocumentContent(uri: vscode.Uri) {
    return this.docs.get(uri.toString()) ?? '';
  }
  pair(name: string, before: string, after: string): [vscode.Uri, vscode.Uri] {
    const id = ++this.n;
    const a = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${id}/current/${name}` });
    const b = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${id}/new/${name}` });
    this.docs.set(a.toString(), before);
    this.docs.set(b.toString(), after);
    // Old previews are dropped, so masked copies don't pile up.
    for (const k of [...this.docs.keys()]) if (!k.includes(`/${id}/`) && this.docs.size > 8) this.docs.delete(k);
    return [a, b];
  }
}

export class Service {
  readonly backups: Backups;
  readonly previews = new PreviewDocs();
  private readonly busy = new Set<string>();

  constructor(
    readonly ctx: vscode.ExtensionContext,
    readonly store: Store,
  ) {
    this.backups = new Backups(path.join(ctx.globalStorageUri.fsPath, 'backups'), () => vscode.workspace.getConfiguration('agentProfiles').get<number>('backups', 10));
    ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, this.previews));
  }

  // ---- Targets ---------------------------------------------------------------------

  userTarget(def: AgentDef): Target {
    const dir = configDir(def);
    return { def, scope: 'user', file: configFile(def), format: def.config.format, configDir: dir, keyFile: path.join(dir, 'agent-profiles', 'user.key') };
  }

  projectTarget(def: AgentDef, folder: vscode.WorkspaceFolder): Target {
    if (!def.projectConfig) throw new Error(`${def.label} has no project config.`);
    const dir = configDir(def);
    return {
      def,
      scope: 'project',
      file: path.join(folder.uri.fsPath, ...def.projectConfig.file.split('/')),
      format: def.projectConfig.format,
      configDir: dir,
      keyFile: path.join(dir, 'agent-profiles', `project-${sha(folder.uri.fsPath).slice(0, 12)}.key`),
      folder,
      confine: folder.uri.fsPath,
    };
  }

  async target(def: AgentDef, scope: Scope): Promise<Target | undefined> {
    if (scope === 'user') return this.userTarget(def);
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(`Writing ${def.projectConfig?.file ?? 'project settings'} needs a trusted workspace. In Restricted Mode, profiles apply to your user settings only.`, 'Manage Workspace Trust').then((a) => {
        if (a) void vscode.commands.executeCommand('workbench.trust.manage');
      });
      return undefined;
    }
    const folders = diskFolders();
    if (!folders.length) {
      void vscode.window.showWarningMessage(vscode.workspace.workspaceFolders?.length ? 'Project settings need a folder on disk; this workspace has none. Apply the profile to your user settings instead.' : 'Open a folder to apply a profile to its project settings.');
      return undefined;
    }
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which project?' });
    return folder ? this.projectTarget(def, folder) : undefined;
  }

  /** Every file a profile of this agent may have been applied to, in this window. */
  targets(def: AgentDef): Target[] {
    const out = [this.userTarget(def)];
    if (def.projectConfig) for (const f of diskFolders()) out.push(this.projectTarget(def, f));
    return out;
  }

  activeRecord(def: AgentDef, scope: Scope = 'user'): AppliedRecord | undefined {
    if (scope === 'user') return this.store.applied()[this.userTarget(def).file];
    for (const t of this.targets(def).filter((x) => x.scope === 'project')) {
      const r = this.store.applied()[t.file];
      if (r) return r;
    }
    return undefined;
  }

  /** The user config changed since the last apply (by hand, or by another tool). */
  async drift(def: AgentDef): Promise<boolean> {
    const t = this.userTarget(def);
    const rec = this.store.applied()[t.file];
    if (!rec?.hash) return false;
    // A file that can't be read (permissions, a directory) is reported where it's read for
    // the form; here it just isn't "changed".
    let st;
    try {
      st = await readState(t.file);
    } catch {
      return false;
    }
    if (st.hash === rec.hash) return false;
    // Only the keys the profile owns: the agents write elsewhere in the same file.
    if (rec.watch && rec.managedHash) {
      try {
        return managedDigest(t.format, st.text, rec.watch) !== rec.managedHash;
      } catch {
        return true;
      }
    }
    return true;
  }

  /** The record with the hashes of the file as it is now (`text`). */
  stamp(rec: Omit<AppliedRecord, 'hash' | 'at'>, format: 'json' | 'toml', text: string, hash: string): AppliedRecord {
    let managedHash: string | undefined;
    try {
      managedHash = rec.watch ? managedDigest(format, text, rec.watch) : undefined;
    } catch {
      managedHash = undefined;
    }
    return { ...rec, hash, managedHash, at: Date.now() };
  }

  // ---- Apply -----------------------------------------------------------------------

  /**
   * Applies a profile: works out the change, shows it as a diff with keys hidden, and
   * writes only after an explicit Apply. Returns true when the profile is now active.
   */
  async apply(profile: Profile, scope: Scope = profile.scope, opts: { formHash?: string } = {}): Promise<boolean> {
    const def = agent(profile.agent);
    const t = await this.target(def, def.projectConfig ? scope : 'user');
    if (!t) return false;
    if (this.busy.has(t.file)) {
      void vscode.window.showInformationMessage(`A change to ${path.basename(t.file)} is already waiting for your answer.`);
      return false;
    }
    this.busy.add(t.file);
    try {
      return await this.applyTo(profile, t, opts);
    } finally {
      this.busy.delete(t.file);
    }
  }

  private async applyTo(profile: Profile, t: Target, opts: { formHash?: string }): Promise<boolean> {
    const { def } = t;
    const secret = needsSecret(def, profile) ? await this.store.secret(profile.id) : undefined;
    const issues = validate(def, profile, { hasSecret: needsSecret(def, profile) ? !!secret : undefined });
    if (issues.length) {
      const a = await vscode.window.showErrorMessage(`"${profile.name}" can't be applied yet: ${issues[0].message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''}`, 'Edit Profile');
      if (a) await vscode.commands.executeCommand('agentProfiles.open', profile.id);
      return false;
    }
    if (t.scope === 'user' && def.config.dirMustExist && def.config.dirEnv && process.env[def.config.dirEnv]?.trim()) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(t.configDir));
      } catch {
        void vscode.window.showErrorMessage(`${def.config.dirEnv} points to ${t.configDir}, which doesn't exist. ${def.label} won't start until it does; nothing was written.`);
        return false;
      }
    }
    for (;;) {
      let prep: PreparedApply;
      const prev = this.store.applied()[t.file];
      try {
        prep = await prepareApply({ def, profile, secret, prev, keyFile: t.keyFile, configDir: t.configDir, platform: process.platform, file: t.file, format: t.format, confine: t.confine });
      } catch (e) {
        if (e instanceof ConfigSyntaxError) {
          const a = await vscode.window.showErrorMessage(`${tilde(t.file)} can't be read (${e.message}). Fix it first; nothing was written.`, 'Open File');
          if (a) await vscode.window.showTextDocument(vscode.Uri.file(t.file));
        } else void vscode.window.showErrorMessage(`Couldn't apply "${profile.name}": ${this.clean(e, [secret])}`);
        return false;
      }
      if (opts.formHash && opts.formHash !== prep.config.before.hash) {
        const a = await vscode.window.showWarningMessage(`${tilde(t.file)} changed outside VS Code since the form was opened. The preview shows the change against the file as it is now.`, 'Show Preview', 'Cancel');
        if (a !== 'Show Preview') return false;
        opts = {};
      }
      const record = (hash: string, text: string): AppliedRecord => this.stamp(prep.plan.record, t.format, text, hash);
      if (isNoop(prep)) {
        await this.store.setApplied(t.file, record(prep.config.before.hash, prep.config.before.text));
        await this.syncTerminals();
        void vscode.window.showInformationMessage(`${def.label} uses "${profile.name}"; ${path.basename(t.file)} already matched it, nothing was written.${this.terminalNote(def, profile)}`);
        return true;
      }
      // A key in plain text in a project file must not end up in a commit.
      const git = t.scope === 'project' && t.folder && secretMode(def, profile).kind === 'config' && secret ? await gitStatus(t.file, t.folder.uri.fsPath) : undefined;
      if (git?.kind === 'tracked') {
        void vscode.window.showErrorMessage(`${tilde(t.file)} is tracked by Git, so a key written to it would be committed. Choose another place for the key; nothing was written.`);
        return false;
      }
      const { answer, uris } = await this.preview(prep, t, profile, secret, git?.kind === 'untracked' ? ` It is not ignored by Git, so it will be added to ${tilde(git.exclude)} (this clone only).` : '');
      if (answer !== 'Apply') {
        await this.closePreviews(uris);
        return false;
      }
      try {
        if (git?.kind === 'untracked' && t.folder) {
          await addExclude(git);
          // A .gitignore rule such as !settings.local.json wins over info/exclude.
          if ((await gitStatus(t.file, t.folder.uri.fsPath)).kind !== 'ignored') {
            void vscode.window.showErrorMessage(`A .gitignore rule in this repository un-ignores ${tilde(t.file)}, so a key written to it could be committed. Choose another place for the key; nothing was written.`);
            return false;
          }
        }
        const { hash } = await commitApply(prep, this.backups, def.id, `Apply "${profile.name}"`, prev);
        await this.store.setApplied(t.file, record(hash, prep.config.after ?? ''));
      } catch (e) {
        if (e instanceof ConflictError) {
          const a = await vscode.window.showWarningMessage(`${tilde(e.file)} changed while the preview was open. Nothing was written.`, 'Preview Again', 'Cancel');
          if (a === 'Preview Again') continue;
          return false;
        }
        void vscode.window.showErrorMessage(`Couldn't write ${tilde(t.file)}: ${this.clean(e, [secret])}`);
        return false;
      } finally {
        await this.closePreviews(uris);
      }
      await this.syncTerminals();
      void vscode.window.showInformationMessage(`${def.label} now uses "${profile.name}"${t.scope === 'project' ? ` in ${t.folder?.name}` : ''}. The previous file is backed up.${this.terminalNote(def, profile)}`, 'Restore Previous').then((a) => {
        if (a) void this.restore(def.id);
      });
      return true;
    }
  }

  private terminalNote(def: AgentDef, p: Profile): string {
    return secretMode(def, p).kind === 'terminal' ? ' Open a new terminal for the key to take effect.' : '';
  }

  private clean(e: unknown, secrets: (string | undefined)[]): string {
    return maskText(String(e instanceof Error ? e.message : e), secrets);
  }

  private async preview(prep: PreparedApply, t: Target, profile: Profile, secret: string | undefined, extra = ''): Promise<{ answer: string | undefined; uris: vscode.Uri[] }> {
    const before = prep.config.before.text;
    const after = prep.config.after ?? '';
    const secrets = [secret, ...this.secretsOf(t.format, before), ...this.secretsOf(t.format, after)];
    const name = path.basename(t.file);
    const uris = this.previews.pair(name, maskText(before, secrets), maskText(after, secrets));
    await vscode.commands.executeCommand('vscode.diff', uris[0], uris[1], `${name}: now ↔ "${profile.name}" (keys hidden)`, { preview: true });
    const mode = secretMode(t.def, profile);
    const also: string[] = [];
    for (const k of prep.keyFiles) also.push(k.content === null ? `remove the key file ${tilde(k.file)}` : `write the key to ${tilde(k.file)} (readable only by you)`);
    if (prep.dotenv && prep.dotenv.before.text !== prep.dotenv.after) also.push(`update ${tilde(prep.dotenv.before.path)}`);
    const plain = mode.plaintext && mode.kind === 'config' ? ` The key is written to ${name} in plain text.` : '';
    if (prep.plan.terminal) also.push(`set ${prep.plan.terminal.name} to the key in VS Code terminals opened from now on`);
    const where = t.scope === 'project' ? `${t.folder?.name}/${t.def.projectConfig!.file}` : tilde(t.file);
    const msg = `Apply "${profile.name}" to ${where}?${also.length ? ` This will also ${also.join(' and ')}.` : ''}${plain}${extra} The current file is backed up first.`;
    return { answer: await vscode.window.showInformationMessage(msg, 'Apply', 'Cancel'), uris };
  }

  private secretsOf(format: 'json' | 'toml', text: string): string[] {
    try {
      return secretsIn(read(format, text));
    } catch {
      return [];
    }
  }

  /** Closes the diff tabs of one flow; others may still be waiting for an answer. */
  async closePreviews(uris: vscode.Uri[]) {
    const mine = new Set(uris.map((u) => u.toString()));
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((tab) => tab.input instanceof vscode.TabInputTextDiff && mine.has(tab.input.modified.toString()));
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  }

  // ---- Restore ---------------------------------------------------------------------

  async restore(agentId?: string): Promise<boolean> {
    const def = agentId ? agent(agentId) : await this.pickAgent('Restore whose config?');
    if (!def) return false;
    // A project file is written only in a trusted workspace, by a restore too.
    const allowed = this.targets(def).filter((t) => t.scope === 'user' || vscode.workspace.isTrusted);
    const entries = (await this.backups.list(def.id)).filter((e) => allowed.some((t) => t.file === e.file) || path.basename(e.file) === '.env');
    if (!entries.length) {
      void vscode.window.showInformationMessage(`No backups of ${def.label}'s config yet. One is taken before every change this extension makes.`);
      return false;
    }
    type Item = vscode.QuickPickItem & { e: BackupEntry };
    const items: Item[] = entries.map((e) => ({
      label: new Date(e.at).toLocaleString(),
      description: `before: ${e.reason}`,
      detail: `${tilde(e.file)}${e.absent ? ' (the file did not exist: restoring removes it)' : ''}`,
      e,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: `Restore ${def.label} config`, placeHolder: 'The newest copy is the state before the last change', matchOnDescription: true, matchOnDetail: true });
    if (!pick) return false;
    const target = allowed.find((t) => t.file === pick.e.file);
    const confine = target?.confine;
    for (;;) {
      let r;
      try {
        r = await prepareRestore(pick.e, this.backups, confine);
      } catch (e) {
        void vscode.window.showErrorMessage(`Couldn't restore ${tilde(pick.e.file)}: ${this.clean(e, [])}`);
        return false;
      }
      const format = r.entry.file.endsWith('.toml') ? 'toml' : r.entry.file.endsWith('.json') ? 'json' : undefined;
      const secrets = format ? [...this.secretsOf(format, r.before.text), ...this.secretsOf(format, r.after ?? '')] : [...secretsInDotenv(r.before.text), ...secretsInDotenv(r.after ?? '')];
      const name = path.basename(r.entry.file);
      const uris = this.previews.pair(name, maskText(r.before.text, secrets), maskText(r.after ?? '', secrets));
      await vscode.commands.executeCommand('vscode.diff', uris[0], uris[1], `${name}: now ↔ backup from ${pick.label} (keys hidden)`, { preview: true });
      // The key file or .env line of the apply being undone goes with it, and the one the
      // restored config relies on comes back.
      const current = name === '.env' ? undefined : this.store.applied()[r.entry.file];
      const restored = name === '.env' ? undefined : (pick.e.record ?? null);
      const side = name === '.env' ? [] : await this.restoreSideFiles(def.id, current, restored ?? undefined);
      const also = side.length ? ` This will also ${side.map((x) => x.what).join(' and ')}.` : '';
      const answer = await vscode.window.showInformationMessage(`Restore ${tilde(r.entry.file)} as it was on ${pick.label}?${r.after === null ? ' The file did not exist then, so it will be removed.' : ''}${also} The current file is backed up first.`, 'Restore', 'Cancel');
      if (answer !== 'Restore') {
        await this.closePreviews(uris);
        return false;
      }
      try {
        await commitRestore(r, this.backups, current ?? this.store.applied()[r.entry.file], confine);
      } catch (e) {
        await this.closePreviews(uris);
        if (e instanceof ConflictError) {
          const again = await vscode.window.showWarningMessage(`${tilde(e.file)} changed while the preview was open. Nothing was restored.`, 'Preview Again', 'Cancel');
          if (again === 'Preview Again') continue;
          return false;
        }
        void vscode.window.showErrorMessage(`Couldn't restore ${tilde(r.entry.file)}: ${this.clean(e, [])}`);
        return false;
      }
      await this.closePreviews(uris);
      if (name !== '.env') {
        const rec = restored ?? null;
        const now = await readState(r.entry.file);
        await this.store.setApplied(r.entry.file, rec ? this.stamp(rec, target?.format ?? def.config.format, now.text, now.hash) : null);
        const failed: string[] = [];
        for (const x of side) {
          try {
            await x.run();
          } catch (e) {
            failed.push(`${x.what} (${this.clean(e, [])})`);
          }
        }
        if (failed.length) void vscode.window.showWarningMessage(`Restored ${tilde(r.entry.file)}, but couldn't ${failed.join(' or ')}.`);
      }
      await this.syncTerminals();
      void vscode.window.showInformationMessage(`Restored ${tilde(r.entry.file)}.`);
      return true;
    }
  }

  /**
   * The key files and .env lines that go with restoring a config: what the current record
   * wrote and the restored one doesn't use is removed, and what the restored one uses is
   * written again from secret storage.
   */
  private async restoreSideFiles(agentId: string, cur: AppliedRecord | undefined, rec: AppliedRecord | undefined): Promise<{ what: string; run: () => Promise<void> }[]> {
    const out: { what: string; run: () => Promise<void> }[] = [];
    if (cur?.keyFile && cur.keyFile !== rec?.keyFile) {
      const file = cur.keyFile;
      out.push({ what: `remove the key file ${tilde(file)}`, run: () => removeFile(file) });
    }
    if (rec?.keyFile) {
      const s = await this.store.secret(rec.profileId);
      const file = rec.keyFile;
      if (s) out.push({ what: `write the key of "${rec.profileName}" to ${tilde(file)}`, run: () => writePrivate(file, s) });
    }
    // .env files: one edit per file, so removing one name and setting another don't clash.
    const env = new Map<string, { set?: { name: string; value: string }; remove: string[] }>();
    const at = (file: string) => env.get(file) ?? (env.set(file, { remove: [] }), env.get(file)!);
    if (cur?.dotenv && !(rec?.dotenv && rec.dotenv.file === cur.dotenv.file && rec.dotenv.name === cur.dotenv.name)) at(cur.dotenv.file).remove.push(cur.dotenv.name);
    if (rec?.dotenv) {
      const s = await this.store.secret(rec.profileId);
      if (s) at(rec.dotenv.file).set = { name: rec.dotenv.name, value: s };
    }
    for (const [file, e] of env) {
      const now = await readState(file);
      if (editDotenv(now.text, e.set, e.remove) === now.text) continue;
      out.push({
        what: `update ${tilde(file)}`,
        run: async () => {
          const before = await readState(file);
          const after = editDotenv(before.text, e.set, e.remove);
          if (after === before.text) return;
          await this.backups.take(agentId, before, 'Restore a config', cur);
          if (after) await writePrivate(file, after);
          else await removeFile(file);
        },
      });
    }
    return out;
  }

  // ---- Import ----------------------------------------------------------------------

  async importCurrent(agentId?: string): Promise<string | undefined> {
    const def = agentId ? agent(agentId) : await this.pickAgent('Import whose config?');
    if (!def) return undefined;
    const t = this.userTarget(def);
    const st = await readState(t.file);
    if (!st.exists) {
      void vscode.window.showInformationMessage(`There is no ${tilde(t.file)} yet, so there is nothing to import.`);
      return undefined;
    }
    let value: Record<string, unknown>;
    try {
      value = read(t.format, st.text);
    } catch (e) {
      void vscode.window.showErrorMessage(`${tilde(t.file)} can't be read: ${(e as Error).message}`);
      return undefined;
    }
    const dotenvMode = def.secret.modes.find((m) => m.kind === 'dotenv');
    const dotenvText = dotenvMode?.file ? (await readState(path.join(t.configDir, dotenvMode.file))).text : undefined;
    const name = uniqueName(`Current ${def.label} settings`, this.store.profiles().map((p) => p.name));
    const r = importConfig(def, value, { id: newId(), name, dotenvText });
    let keep = false;
    if (r.secret) {
      const a = await vscode.window.showInformationMessage(`Found a key in ${r.secretFrom}. Keep a copy in VS Code's secret storage for this profile? The file is not changed.`, { modal: true }, 'Keep in Secret Storage', "Don't Import the Key");
      if (a === undefined) return undefined;
      keep = a === 'Keep in Secret Storage';
    }
    await this.store.put(r.profile);
    if (keep && r.secret) await this.store.setSecret(r.profile.id, r.secret);
    // The config already holds this profile (give or take defaults the form fills in):
    // remember it as applied, so switching away later takes its keys back.
    if (!this.store.applied()[t.file]) {
      try {
        const prep = await prepareApply({ def, profile: r.profile, secret: keep ? r.secret : undefined, configDir: t.configDir, keyFile: t.keyFile, platform: process.platform, file: t.file, format: t.format });
        await this.store.setApplied(t.file, this.stamp(prep.plan.record, t.format, st.text, st.hash));
      } catch {
        /* not exactly representable: leave it unapplied */
      }
    }
    const notes = r.notes.length ? ` ${r.notes.join(' ')}` : '';
    void vscode.window.showInformationMessage(`Imported "${r.profile.name}" from ${tilde(t.file)}.${notes}`);
    return r.profile.id;
  }

  // ---- Test ------------------------------------------------------------------------

  async test(profile: Profile, secretOverride?: string): Promise<TestOutcome> {
    const def = agent(profile.agent);
    const secret = secretOverride?.trim() || (needsSecret(def, profile) ? await this.store.secret(profile.id) : undefined);
    const timeoutMs = Math.max(1, vscode.workspace.getConfiguration('agentProfiles').get<number>('testTimeoutSeconds', 15)) * 1000;
    const r = await runTest(prepare(def, profile, secret), { fetch: fetch as never, timeoutMs, secrets: [secret ?? ''] });
    return { ok: r.ok, message: r.message, latencyMs: r.latencyMs, status: r.status, models: r.models, url: r.url, unverified: r.unverified };
  }

  // ---- Terminals -------------------------------------------------------------------

  /**
   * Keys of active profiles in "VS Code terminals only" mode go into the environment of
   * new integrated terminals. The collection isn't persisted: VS Code keeps nothing on
   * disk, and it is rebuilt from secret storage when the extension starts.
   */
  async syncTerminals(): Promise<void> {
    const coll = this.ctx.environmentVariableCollection;
    coll.persistent = false;
    coll.description = 'Agent Profiles: keys of the active profiles';
    coll.clear();
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const f of folders) coll.getScoped({ workspaceFolder: f }).clear();
    const applied = this.store.applied();
    for (const def of AGENTS) {
      for (const t of this.targets(def)) {
        const rec = applied[t.file];
        if (!rec?.terminalVar) continue;
        const s = await this.store.secret(rec.profileId);
        if (!s) continue;
        const target = t.folder ? coll.getScoped({ workspaceFolder: t.folder }) : coll;
        target.replace(rec.terminalVar, s);
      }
    }
  }

  async pickAgent(placeHolder: string): Promise<AgentDef | undefined> {
    const pick = await vscode.window.showQuickPick(
      AGENTS.map((d) => ({ label: d.label, description: tilde(configFile(d)), d })),
      { placeHolder },
    );
    return pick?.d;
  }
}

export function newId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
