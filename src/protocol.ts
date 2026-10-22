// Messages between the extension and the profiles webview. Keys never travel to the
// webview except when the person asks to see one (reveal), and never come back in state.
import type { AgentDef, Profile, Scope } from './core/types';

export interface ProfileView extends Profile {
  hasSecret: boolean;
  /** "••••••••abcd", never the key. */
  maskedSecret: string;
  /** Applied to the user config of its agent. */
  active: boolean;
  /** Applied to this workspace's project config. */
  activeProject: boolean;
  /** The workspace default for its agent. */
  workspaceDefault: boolean;
}

export interface AgentView {
  def: AgentDef;
  file: string;
  /** The file as the form saw it, to notice an edit made elsewhere before applying. */
  hash: string;
  /** The same for the project file, when there is exactly one folder it could be. */
  projectHash?: string;
  exists: boolean;
  /** Text shown when the config can't be read (a syntax error). */
  problem?: string;
  /** The agent's config was changed outside this extension since the last apply. */
  drift?: boolean;
  projectFile?: string;
}

export interface State {
  agents: AgentView[];
  profiles: ProfileView[];
  trusted: boolean;
  hasWorkspace: boolean;
  /** At least one workspace folder is on disk, so it can have project settings. */
  diskFolder: boolean;
  /** Open this profile in the form (after creating or importing one). */
  select?: string;
}

export interface TestOutcome {
  ok: boolean;
  message: string;
  latencyMs: number;
  status?: number;
  models?: string[];
  url: string;
  /** Reachable, but the key was not checked. */
  unverified?: boolean;
}

export type ToHost =
  | { type: 'ready' }
  | { type: 'create'; agent: string; preset?: string }
  | { type: 'save'; profile: Profile; secret?: string | null; apply?: { scope: Scope; hash: string } }
  | { type: 'delete'; id: string }
  | { type: 'duplicate'; id: string }
  | { type: 'apply'; id: string; scope: Scope; hash: string }
  | { type: 'test'; profile: Profile; secret?: string; nonce: number }
  | { type: 'reveal'; id: string }
  | { type: 'importCurrent'; agent: string }
  | { type: 'exportProfiles' }
  | { type: 'importProfiles' }
  | { type: 'restore'; agent: string }
  | { type: 'workspaceDefault'; agent: string; id: string | null }
  | { type: 'openConfig'; agent: string }
  | { type: 'openDocs'; url: string }
  | { type: 'selected'; id: string | null };

export type ToWebview =
  | { type: 'state'; state: State }
  | { type: 'saved'; id: string }
  | { type: 'secret'; id: string; value: string }
  | { type: 'test'; nonce: number; result: TestOutcome }
  | { type: 'busy'; busy: boolean };
