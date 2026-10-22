import * as path from 'path';
import * as vscode from 'vscode';
import { AGENTS, agent } from './core/defs';
import { exportProfiles, fromPreset, importProfiles, newProfile, readState, uniqueName } from './core/index';
import { ProfilesPanel, VIEW_TYPE } from './panel';
import { newId, Service, tilde } from './service';
import { quickSwitch, StatusBar } from './statusBar';
import { Store } from './store';

export function activate(ctx: vscode.ExtensionContext) {
  const store = new Store(ctx);
  const svc = new Service(ctx, store);
  const status = new StatusBar(svc);
  ctx.subscriptions.push(status);
  const refresh = () => {
    void status.update();
    ProfilesPanel.current?.refresh();
  };

  const open = (id?: string) => ProfilesPanel.show(ctx, svc, typeof id === 'string' ? id : undefined);
  const cmd = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('agentProfiles.open', (id?: string) => open(id));
  cmd('agentProfiles.switch', (agentId?: string) => quickSwitch(svc, typeof agentId === 'string' ? agentId : undefined));
  cmd('agentProfiles.newProfile', async (agentId?: string) => {
    const def = typeof agentId === 'string' ? agent(agentId) : await svc.pickAgent('A profile for which agent?');
    if (!def) return;
    const pick = await vscode.window.showQuickPick(
      [
        ...def.presets.map((p) => ({ label: p.label, detail: p.description, id: p.id })),
        { label: '', kind: vscode.QuickPickItemKind.Separator, id: '' },
        { label: '$(file) Blank profile', detail: 'Every field empty', id: '#blank' },
        { label: '$(cloud-download) Import current config', detail: `From ${tilde(svc.userTarget(def).file)}`, id: '#import' },
      ],
      { title: `New ${def.label} profile`, placeHolder: 'Start from a preset; every field stays editable' },
    );
    if (!pick) return;
    if (pick.id === '#import') {
      const id = await svc.importCurrent(def.id);
      if (id) open(id);
      return;
    }
    const preset = def.presets.find((p) => p.id === pick.id);
    const id = newId();
    const taken = store.profiles().map((p) => p.name);
    await store.put(preset ? fromPreset(def, preset, id, uniqueName(preset.label, taken)) : newProfile(def, uniqueName(`New ${def.short} profile`, taken), id));
    open(id);
  });
  cmd('agentProfiles.importCurrent', async (agentId?: string) => {
    const id = await svc.importCurrent(typeof agentId === 'string' ? agentId : undefined);
    if (id) open(id);
  });
  cmd('agentProfiles.restore', (agentId?: string) => svc.restore(typeof agentId === 'string' ? agentId : undefined));
  cmd('agentProfiles.exportProfiles', async () => {
    const profiles = store.profiles();
    if (!profiles.length) return void vscode.window.showInformationMessage('There are no profiles to export yet.');
    const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(require('os').homedir());
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(base, 'agent-profiles.json'), filters: { JSON: ['json'] }, title: 'Export profiles (without keys)' });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, Buffer.from(exportProfiles(profiles, AGENTS), 'utf8'));
    void vscode.window.showInformationMessage(`Exported ${profiles.length} profile${profiles.length === 1 ? '' : 's'} to ${tilde(uri.fsPath)}. Keys are not included.`);
  });
  cmd('agentProfiles.importProfiles', async () => {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ['json'] }, title: 'Import profiles' })) ?? [];
    if (!uri) return;
    try {
      const r = importProfiles(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), AGENTS);
      const taken = store.profiles().map((p) => p.name);
      let first: string | undefined;
      for (const p of r.profiles) {
        const id = newId();
        first ??= id;
        const name = uniqueName(p.name, taken);
        taken.push(name);
        await store.put({ ...p, id, name });
      }
      const skipped = r.skipped.length ? ` Skipped: ${r.skipped.join('; ')}.` : '';
      void vscode.window.showInformationMessage(`Imported ${r.profiles.length} profile${r.profiles.length === 1 ? '' : 's'}. Enter their keys before applying them.${skipped}`);
      if (first) open(first);
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't import ${path.basename(uri.fsPath)}: ${(e as Error).message}`);
    }
  });
  cmd('agentProfiles.setWorkspaceDefault', async (agentId?: string) => {
    if (!vscode.workspace.workspaceFolders?.length) return void vscode.window.showInformationMessage('Open a folder or workspace first.');
    const def = typeof agentId === 'string' ? agent(agentId) : await svc.pickAgent('Default profile for which agent?');
    if (!def) return;
    const items = [{ label: '$(close) No default', id: '' }, ...store.profiles().filter((p) => p.agent === def.id).map((p) => ({ label: p.name, id: p.id }))];
    const pick = await vscode.window.showQuickPick(items, { title: `${def.label}: default profile for this workspace`, placeHolder: "Suggested when you open this workspace; it's only applied when you say so" });
    if (!pick) return;
    await store.setDefault(def.id, pick.id || null);
  });
  cmd('agentProfiles.applyWorkspaceDefault', () => offerWorkspaceDefaults(svc, true));
  cmd('agentProfiles.testConnection', async () => {
    const items = store.profiles().map((p) => ({ label: p.name, description: agent(p.agent).label, p }));
    if (!items.length) return void vscode.window.showInformationMessage('There are no profiles yet.');
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Test which profile? (one request to its endpoint)' });
    if (!pick) return;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Testing "${pick.p.name}"…` }, () => svc.test(pick.p));
    const msg = `"${pick.p.name}": ${r.message}${r.latencyMs ? ` (${r.latencyMs} ms)` : ''}`;
    if (r.ok) void vscode.window.showInformationMessage(msg);
    else void vscode.window.showWarningMessage(msg);
  });
  cmd('agentProfiles.openConfig', async (agentId?: string) => {
    const def = typeof agentId === 'string' ? agent(agentId) : await svc.pickAgent('Open whose config?');
    if (!def) return;
    const f = svc.userTarget(def).file;
    if (!(await readState(f)).exists) return void vscode.window.showInformationMessage(`${tilde(f)} doesn't exist yet. Applying a profile creates it.`);
    await vscode.window.showTextDocument(vscode.Uri.file(f));
  });

  ctx.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel) {
        new ProfilesPanel(panel, ctx, svc);
      },
    }),
    store.onDidChange(() => void status.update()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentProfiles')) refresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void svc.syncTerminals();
      refresh();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) refresh();
    }),
  );
  // Notice edits made to the agents' config files elsewhere.
  for (const def of AGENTS) {
    const t = svc.userTarget(def);
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(t.file)), path.basename(t.file)));
    w.onDidChange(refresh);
    w.onDidCreate(refresh);
    w.onDidDelete(refresh);
    ctx.subscriptions.push(w);
  }

  void svc.syncTerminals();
  void status.update();
  setTimeout(() => void offerWorkspaceDefaults(svc, false), 1500);
}

/** Suggests the workspace's default profiles that aren't active. Never applies on its own. */
async function offerWorkspaceDefaults(svc: Service, explicit: boolean) {
  const defaults = svc.store.defaults();
  let offered = false;
  for (const def of AGENTS) {
    const id = defaults[def.id];
    const p = id ? svc.store.get(id) : undefined;
    if (!p) continue;
    const active = svc.activeRecord(def, p.scope)?.profileId === p.id;
    if (active) continue;
    offered = true;
    if (explicit) {
      await svc.apply(p);
      continue;
    }
    const a = await vscode.window.showInformationMessage(`This workspace's default ${def.label} profile is "${p.name}", but it isn't active. Switch to it?`, 'Switch…', 'Not Now');
    if (a === 'Switch…') await svc.apply(p);
  }
  if (explicit && !offered) void vscode.window.showInformationMessage(Object.keys(defaults).length ? "This workspace's default profiles are already active." : 'This workspace has no default profile. Set one with "Agent Profiles: Set Workspace Default Profile".');
}

export function deactivate() {}
