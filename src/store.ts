// Where profiles live: the profiles themselves (no keys) in global state, keys in VS Code's
// SecretStorage, what was applied to which file in global state (key names only), and the
// per-workspace default in workspace state.
import * as vscode from 'vscode';
import { mask } from './core/mask';
import type { AppliedRecord, Profile } from './core/types';

const PROFILES = 'agentProfiles.profiles';
const APPLIED = 'agentProfiles.applied';
const DEFAULTS = 'agentProfiles.workspaceDefaults';
const secretKey = (id: string) => `agentProfiles.secret.${id}`;

export class Store {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      this.changed,
      ctx.secrets.onDidChange((e) => {
        if (e.key.startsWith('agentProfiles.secret.')) this.changed.fire();
      }),
    );
  }

  profiles(): Profile[] {
    return (this.ctx.globalState.get<Profile[]>(PROFILES) ?? []).filter((p) => p && typeof p.id === 'string');
  }

  get(id: string): Profile | undefined {
    return this.profiles().find((p) => p.id === id);
  }

  async put(p: Profile): Promise<void> {
    const all = this.profiles();
    const i = all.findIndex((x) => x.id === p.id);
    // Only known fields are stored, so nothing else (a key pasted into the wrong place)
    // ends up in global state by accident.
    const clean: Profile = { id: p.id, agent: p.agent, name: p.name, preset: p.preset, values: { ...p.values }, secretMode: p.secretMode, scope: p.scope };
    if (i >= 0) all[i] = clean;
    else all.push(clean);
    await this.ctx.globalState.update(PROFILES, all);
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    await this.ctx.globalState.update(
      PROFILES,
      this.profiles().filter((p) => p.id !== id),
    );
    await this.ctx.secrets.delete(secretKey(id));
    const d = this.defaults();
    for (const k of Object.keys(d)) if (d[k] === id) delete d[k];
    await this.ctx.workspaceState.update(DEFAULTS, d);
    this.changed.fire();
  }

  async secret(id: string): Promise<string | undefined> {
    return (await this.ctx.secrets.get(secretKey(id))) || undefined;
  }

  async setSecret(id: string, value: string | null): Promise<void> {
    if (value === null || !value.trim()) await this.ctx.secrets.delete(secretKey(id));
    else await this.ctx.secrets.store(secretKey(id), value.trim());
    this.changed.fire();
  }

  async masked(id: string): Promise<string> {
    const s = await this.secret(id);
    return s ? mask(s) : '';
  }

  /** What was applied, keyed by config file path. */
  applied(): Record<string, AppliedRecord> {
    return this.ctx.globalState.get<Record<string, AppliedRecord>>(APPLIED) ?? {};
  }

  async setApplied(file: string, rec: AppliedRecord | null | undefined): Promise<void> {
    const all = this.applied();
    if (rec) all[file] = rec;
    else delete all[file];
    await this.ctx.globalState.update(APPLIED, all);
    this.changed.fire();
  }

  defaults(): Record<string, string> {
    return { ...(this.ctx.workspaceState.get<Record<string, string>>(DEFAULTS) ?? {}) };
  }

  async setDefault(agent: string, id: string | null): Promise<void> {
    const d = this.defaults();
    if (id) d[agent] = id;
    else delete d[agent];
    await this.ctx.workspaceState.update(DEFAULTS, d);
    this.changed.fire();
  }

  fire() {
    this.changed.fire();
  }
}
