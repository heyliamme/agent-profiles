// One status bar item per agent: the active profile and its model. Clicking it opens a
// quick pick to switch.
import * as vscode from 'vscode';
import { AGENTS, agent } from './core/defs';
import { secretMode, statusText } from './core/index';
import type { AgentDef, Profile } from './core/types';
import { Service, tilde } from './service';

export class StatusBar implements vscode.Disposable {
  private readonly items = new Map<string, vscode.StatusBarItem>();

  constructor(private readonly svc: Service) {
    AGENTS.forEach((def, i) => {
      const item = vscode.window.createStatusBarItem(`agentProfiles.${def.id}`, vscode.StatusBarAlignment.Right, 100 - i);
      item.name = `Agent Profiles: ${def.label}`;
      item.command = { title: `Switch ${def.label} Profile`, command: 'agentProfiles.switch', arguments: [def.id] };
      this.items.set(def.id, item);
    });
  }

  async update() {
    const mode = vscode.workspace.getConfiguration('agentProfiles').get<string>('statusBar', 'auto');
    for (const def of AGENTS) {
      const item = this.items.get(def.id)!;
      const profiles = this.svc.store.profiles().filter((p) => p.agent === def.id);
      if (mode === 'never' || (mode === 'auto' && !profiles.length)) {
        item.hide();
        continue;
      }
      const rec = this.svc.activeRecord(def);
      const p = rec ? this.svc.store.get(rec.profileId) : undefined;
      const project = this.svc.activeRecord(def, 'project');
      const drift = await this.svc.drift(def);
      const name = p?.name ?? rec?.profileName ?? 'no profile';
      const model = p ? statusText(def, p) : '';
      item.text = `${drift ? '$(warning)' : '$(hubot)'} ${def.short}: ${name}${model ? ` · ${model}` : ''}${project ? ` (project: ${project.profileName})` : ''}`;
      const md = new vscode.MarkdownString(undefined, true);
      md.appendMarkdown(`**${def.label}**: ${rec ? `profile *${escape(name)}*${p ? '' : ' (deleted)'}` : 'no profile applied yet'}\n\n`);
      if (p) md.appendMarkdown(`Model: ${escape(model)}  \nKey: ${escape(secretMode(def, p).label)}\n\n`);
      if (project) md.appendMarkdown(`This workspace's project settings use *${escape(project.profileName)}*.\n\n`);
      md.appendMarkdown(`Config: \`${tilde(this.svc.userTarget(def).file)}\`\n\n`);
      if (drift) md.appendMarkdown(`$(warning) The file changed outside Agent Profiles since the profile was applied.\n\n`);
      md.appendMarkdown('Click to switch profile.');
      item.tooltip = md;
      item.accessibilityInformation = { label: `${def.label} profile: ${name}${model ? `, model ${model}` : ''}${drift ? ', config changed outside Agent Profiles' : ''}. Switch profile`, role: 'button' };
      item.backgroundColor = drift ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      item.show();
    }
  }

  dispose() {
    for (const i of this.items.values()) i.dispose();
  }
}

const escape = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

type Pick = vscode.QuickPickItem & { profile?: Profile; action?: string };

export async function quickSwitch(svc: Service, agentId?: string): Promise<void> {
  const def: AgentDef | undefined = agentId ? agent(agentId) : await svc.pickAgent('Switch which agent?');
  if (!def) return;
  const rec = svc.activeRecord(def);
  const profiles = svc.store.profiles().filter((p) => p.agent === def.id);
  const items: Pick[] = profiles.map((p) => {
    const active = rec?.profileId === p.id;
    const v = p.values;
    const where = v.baseUrl ? hostOf(v.baseUrl) : v.provider ?? v.backend ?? '';
    return {
      label: `${active ? '$(check)' : '$(blank)'} ${p.name}`,
      description: [statusText(def, p), where].filter(Boolean).join(' · '),
      detail: `${secretMode(def, p).label}${p.scope === 'project' ? ' · this workspace only' : ''}${active ? ' · active' : ''}`,
      profile: p,
    };
  });
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) New Profile…', action: 'new' },
    { label: '$(gear) Manage Profiles…', action: 'open' },
    { label: '$(history) Restore Previous Config…', action: 'restore' },
  );
  const pick = await vscode.window.showQuickPick(items, { title: `${def.label} profile`, placeHolder: profiles.length ? 'Switch to… (the change is previewed before anything is written)' : 'No profiles yet', matchOnDescription: true });
  if (!pick) return;
  if (pick.profile) await svc.apply(pick.profile);
  else if (pick.action === 'new') await vscode.commands.executeCommand('agentProfiles.newProfile', def.id);
  else if (pick.action === 'open') await vscode.commands.executeCommand('agentProfiles.open');
  else if (pick.action === 'restore') await svc.restore(def.id);
}

function hostOf(u: string) {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}
