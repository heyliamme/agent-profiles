// The profiles editor: a webview with the profile list and the form. It holds no keys;
// it asks for one only when the person clicks the eye button.
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { AGENTS, agent } from './core/defs';
import { ConfigSyntaxError, normalize, read, readState, secretMode, uniqueName, fromPreset, newProfile } from './core/index';
import type { Profile } from './core/types';
import type { AgentView, State, ToHost, ToWebview } from './protocol';
import { diskFolders, newId, Service, tilde } from './service';

export const VIEW_TYPE = 'agentProfiles';

export class ProfilesPanel {
  static current: ProfilesPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private ready = false;
  private pendingSelect: string | undefined;

  static show(ctx: vscode.ExtensionContext, svc: Service, select?: string) {
    if (ProfilesPanel.current) {
      ProfilesPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (select) void ProfilesPanel.current.post(select);
      return ProfilesPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Agent Profiles', vscode.ViewColumn.Active, ProfilesPanel.options(ctx));
    return new ProfilesPanel(panel, ctx, svc, select);
  }

  static options(ctx: vscode.ExtensionContext): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist')] };
  }

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly ctx: vscode.ExtensionContext,
    private readonly svc: Service,
    select?: string,
  ) {
    ProfilesPanel.current = this;
    this.pendingSelect = select;
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.png');
    panel.webview.options = ProfilesPanel.options(ctx);
    panel.webview.html = this.html();
    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((m: ToHost) => this.onMessage(m)),
      svc.store.onDidChange(() => void this.post()),
    );
  }

  refresh() {
    void this.post();
  }

  private send(m: ToWebview) {
    void this.panel.webview.postMessage(m);
  }

  async state(select?: string): Promise<State> {
    const agents: AgentView[] = [];
    for (const def of AGENTS) {
      const t = this.svc.userTarget(def);
      let problem: string | undefined;
      const st = await readState(t.file).catch((e: NodeJS.ErrnoException) => {
        problem = `${tilde(t.file)} can't be read (${e.code ?? e.message}). Fix its permissions before applying a profile.`;
        return { exists: true, hash: 'unreadable', text: '' };
      });
      try {
        read(def.config.format, st.text);
      } catch (e) {
        if (e instanceof ConfigSyntaxError) problem = `${tilde(t.file)} can't be read: ${e.message}. Fix it before applying a profile.`;
      }
      const folders = diskFolders();
      const folder = folders[0];
      // With several folders the apply asks which one, so there's no single hash to compare.
      const project = def.projectConfig && folders.length === 1 && vscode.workspace.isTrusted ? this.svc.projectTarget(def, folder) : undefined;
      agents.push({
        def,
        file: tilde(t.file),
        hash: st.hash,
        projectHash: project ? (await readState(project.file).catch(() => undefined))?.hash : undefined,
        exists: st.exists,
        problem,
        drift: await this.svc.drift(def),
        projectFile: def.projectConfig && folder ? `${folder.name}/${def.projectConfig.file}` : undefined,
      });
    }
    const applied = this.svc.store.applied();
    const defaults = this.svc.store.defaults();
    const profiles = await Promise.all(
      this.svc.store.profiles().map(async (p) => {
        const def = AGENTS.find((d) => d.id === p.agent);
        const masked = await this.svc.store.masked(p.id);
        const user = def ? applied[this.svc.userTarget(def).file] : undefined;
        const project = def ? this.svc.targets(def).filter((t) => t.scope === 'project').some((t) => applied[t.file]?.profileId === p.id) : false;
        return { ...p, hasSecret: !!masked, maskedSecret: masked, active: user?.profileId === p.id, activeProject: project, workspaceDefault: defaults[p.agent] === p.id };
      }),
    );
    return { agents, profiles, trusted: vscode.workspace.isTrusted, hasWorkspace: !!vscode.workspace.workspaceFolders?.length, diskFolder: diskFolders().length > 0, select };
  }

  async post(select?: string) {
    if (!this.ready) {
      if (select) this.pendingSelect = select;
      return;
    }
    this.send({ type: 'state', state: await this.state(select) });
  }

  private async onMessage(m: ToHost) {
    const store = this.svc.store;
    try {
      switch (m.type) {
        case 'ready': {
          this.ready = true;
          const s = this.pendingSelect;
          this.pendingSelect = undefined;
          await this.post(s);
          break;
        }
        case 'create': {
          const def = agent(m.agent);
          const preset = def.presets.find((p) => p.id === m.preset);
          const id = newId();
          const taken = store.profiles().map((p) => p.name);
          const p = preset ? fromPreset(def, preset, id, uniqueName(preset.label, taken)) : newProfile(def, uniqueName(`New ${def.short} profile`, taken), id);
          await store.put(p);
          await this.post(id);
          break;
        }
        case 'save': {
          const def = agent(m.profile.agent);
          const existing = store.get(m.profile.id);
          const p: Profile = normalize(def, { ...m.profile, agent: def.id, scope: def.projectConfig && m.profile.scope === 'project' ? 'project' : 'user' });
          if (!p.name) p.name = existing?.name ?? 'Profile';
          await store.put(p);
          if (m.secret !== undefined) await store.setSecret(p.id, m.secret);
          this.send({ type: 'saved', id: p.id });
          if (m.apply) {
            await this.svc.apply(p, m.apply.scope, { formHash: m.apply.hash });
            break;
          }
          const rec = this.svc.activeRecord(def);
          if (rec?.profileId !== p.id) break;
          // Only what can change the files counts: a new name or scope doesn't, a new key
          // does when it is written to disk (settings.json, a key file, .env).
          const planned = (x: Profile | undefined) => (x ? JSON.stringify([x.secretMode, Object.entries(normalize(def, x).values).sort(([a], [b]) => a.localeCompare(b))]) : '');
          const kind = secretMode(def, p).kind;
          const onDisk = kind === 'config' || kind === 'helper' || kind === 'dotenv';
          if (rec.profileName !== p.name) await store.setApplied(this.svc.userTarget(def).file, { ...rec, profileName: p.name });
          if (m.secret === null && onDisk && planned(existing) === planned(p)) {
            void vscode.window.showWarningMessage(`The key of "${p.name}" was removed from secret storage, but ${tilde(this.svc.userTarget(def).file)} or its key file still holds the old one. Choose "No key here" and apply, or enter a new key and apply, to replace it.`);
          } else if (planned(existing) !== planned(p) || (m.secret !== undefined && onDisk)) {
            const what = planned(existing) !== planned(p) ? 'the changes' : 'the new key';
            const a = await vscode.window.showInformationMessage(`"${p.name}" is the active ${def.label} profile. Apply ${what}?`, 'Preview and Apply');
            if (a) await this.svc.apply(p, 'user');
            else if (m.secret !== undefined) await this.svc.syncTerminals();
          } else if (m.secret !== undefined) {
            await this.svc.syncTerminals();
          }
          break;
        }
        case 'delete': {
          const p = store.get(m.id);
          if (!p) break;
          const a = await vscode.window.showWarningMessage(`Delete the profile "${p.name}"? Its key is removed from secret storage. The agent's config files are not changed.`, { modal: true }, 'Delete');
          if (a !== 'Delete') break;
          await store.remove(m.id);
          await this.svc.syncTerminals();
          break;
        }
        case 'duplicate': {
          const p = store.get(m.id);
          if (!p) break;
          const id = newId();
          await store.put({ ...p, id, name: uniqueName(`${p.name} (copy)`, store.profiles().map((x) => x.name)) });
          const s = await store.secret(m.id);
          if (s) await store.setSecret(id, s);
          await this.post(id);
          break;
        }
        case 'apply': {
          const p = store.get(m.id);
          if (p) await this.svc.apply(p, m.scope, { formHash: m.hash });
          break;
        }
        case 'test': {
          this.send({ type: 'busy', busy: true });
          try {
            const result = await this.svc.test(normalize(agent(m.profile.agent), m.profile), m.secret);
            this.send({ type: 'test', nonce: m.nonce, result });
          } finally {
            this.send({ type: 'busy', busy: false });
          }
          break;
        }
        case 'reveal': {
          const s = await store.secret(m.id);
          this.send({ type: 'secret', id: m.id, value: s ?? '' });
          break;
        }
        case 'importCurrent': {
          const id = await this.svc.importCurrent(m.agent);
          if (id) await this.post(id);
          break;
        }
        case 'exportProfiles':
          await vscode.commands.executeCommand('agentProfiles.exportProfiles');
          break;
        case 'importProfiles':
          await vscode.commands.executeCommand('agentProfiles.importProfiles');
          break;
        case 'restore':
          await this.svc.restore(m.agent);
          break;
        case 'workspaceDefault':
          await store.setDefault(m.agent, m.id);
          break;
        case 'openConfig': {
          const t = this.svc.userTarget(agent(m.agent));
          const st = await readState(t.file);
          if (!st.exists) void vscode.window.showInformationMessage(`${tilde(t.file)} doesn't exist yet. Applying a profile creates it.`);
          else await vscode.window.showTextDocument(vscode.Uri.file(t.file), { preview: true });
          break;
        }
        case 'openDocs': {
          // Only the documentation links the agent definitions name.
          const known = AGENTS.flatMap((d) => [...d.docs, ...d.presets.map((p) => p.docs ?? '')]);
          if (known.includes(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
          break;
        }
        case 'selected':
          break;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Agent Profiles: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private html() {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('hex');
    const asset = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', f));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}'; font-src ${w.cspSource}; img-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('codicon.css')}">
<link rel="stylesheet" href="${asset('webview.css')}">
<title>Agent Profiles</title>
</head>
<body>
<div id="app" class="app"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    if (ProfilesPanel.current === this) ProfilesPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
