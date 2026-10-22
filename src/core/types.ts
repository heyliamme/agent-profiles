// The shapes the rest of the extension works with. An agent (Claude Code, Codex, ...) is
// described entirely by an AgentDef, loaded from a JSON file in src/core/agents: which
// file it reads, in which format, which keys a profile writes, how a key is handed over,
// presets and how to test a connection. Supporting a new agent is a new data file.

export type Format = 'json' | 'toml';

/** A condition on the profile's values. `secretMode` can be tested like a field. */
export interface When {
  field: string;
  equals?: string;
  notEquals?: string;
  in?: string[];
  notIn?: string[];
  /** The field has a non-empty value. */
  set?: boolean;
}

export type FieldType = 'string' | 'url' | 'select' | 'number' | 'boolean' | 'map' | 'text' | 'id' | 'constant';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  id: string;
  label: string;
  type: FieldType;
  help: string;
  group: 'connection' | 'models' | 'advanced';
  /**
   * Where the value goes in the config file. Segments may contain `{field}` placeholders
   * (such as `{provider}`), filled from the profile's values. No target: the field only
   * steers others (a placeholder, a `when`).
   */
  target?: string[];
  /** How the value is written. `flag` writes "1" when true and removes the key when false. */
  write?: 'string' | 'number' | 'boolean' | 'flag';
  /** For `map`: each entry becomes its own key under `target`, instead of one object. */
  spread?: boolean;
  /** For `constant`: what is written while the field is visible. */
  value?: string;
  required?: boolean;
  /** Required only while this holds (in addition to `when`). */
  requiredWhen?: When;
  when?: When | When[];
  options?: FieldOption[];
  /** Options may be typed freely too (a datalist rather than a fixed select). */
  freeform?: boolean;
  placeholder?: string;
  default?: string;
  /** A regular expression the whole value must match. */
  pattern?: string;
  patternMessage?: string;
  min?: number;
  max?: number;
  /** Values the field must not take (exactly, or matching `pattern` in any case), with the reason. */
  reserved?: { values?: string[]; pattern?: string; message: string };
  /** For `text`: `Name: value` header lines. Credential headers are refused like keys in a map. */
  headerLines?: boolean;
  /** Suggested model ids are offered from a connection test. */
  models?: boolean;
}

export type SecretKind = 'none' | 'config' | 'helper' | 'terminal' | 'dotenv';

export interface SecretMode {
  id: string;
  kind: SecretKind;
  label: string;
  /** The key ends up readable in a file on disk. */
  plaintext: boolean;
  help: string;
  when?: When | When[];
  /** config: where the key is written. helper: where the helper command is written. */
  target?: string[];
  /** terminal / dotenv: the environment variable (placeholders allowed). */
  envVar?: string;
  /** dotenv: the file, relative to the agent's config directory. */
  file?: string;
}

export interface SecretDef {
  label: string;
  help: string;
  modes: SecretMode[];
  /**
   * Keys that hold a credential and are cleared on every apply unless the active profile
   * writes them, so a key from another profile never lingers and overrides this one.
   */
  clearPaths?: string[][];
}

export interface PresetDef {
  id: string;
  label: string;
  description: string;
  values: Record<string, string>;
  secretMode: string;
  docs?: string;
}

export interface TestAuth {
  header: string;
  prefix?: string;
}

export interface TestDef {
  /** Testing is possible only while this holds; otherwise `unsupported` explains why. */
  when?: When | When[];
  unsupported: string;
  baseUrlField: string;
  defaultBaseUrl?: Record<string, string> | string;
  /** Default base URL keyed by this field's value (e.g. the provider id). */
  defaultBaseUrlBy?: string;
  /** Header for the key, chosen by a field's value, or one for all. */
  authBy?: string;
  auth: Record<string, TestAuth> | TestAuth;
  headers?: Record<string, string>;
  /** A field holding extra headers as `Name: value` lines, or a map field. */
  headersField?: string;
  queryField?: string;
  list: { path: string };
  probe: {
    path: string;
    body: Record<string, unknown>;
    modelField: string;
    /** Model aliases the agent resolves itself: alias -> the field holding the real id ("" for none). */
    aliases?: Record<string, string>;
  };
}

export interface AgentDef {
  id: string;
  label: string;
  /** Short label for the status bar. */
  short: string;
  docs: string[];
  config: {
    format: Format;
    file: string;
    /** Environment variable that moves the config directory. */
    dirEnv?: string;
    /** Default config directory, `~` for the home directory. */
    defaultDir: string;
    /** The tool refuses to start when `dirEnv` names a directory that doesn't exist. */
    dirMustExist?: boolean;
  };
  /** A per-project file the profile can be applied to instead (relative to the folder). */
  projectConfig?: { format: Format; file: string; note: string };
  fields: FieldDef[];
  secret: SecretDef;
  presets: PresetDef[];
  test?: TestDef;
  /** The field shown next to the profile name in the status bar. */
  statusField: string;
  statusFallback: string;
  /** A note shown above the form. */
  note?: string;
}

export type Scope = 'user' | 'project';

export interface Profile {
  id: string;
  agent: string;
  name: string;
  preset?: string;
  /** Field id -> value, all as text. Booleans are "true"/"false"; maps are `KEY=value` lines. */
  values: Record<string, string>;
  secretMode: string;
  scope: Scope;
}

/** What the extension wrote on the last apply, so the next one can take it back. */
export interface AppliedRecord {
  profileId: string;
  profileName: string;
  /** Every key path the apply set in the main config file. */
  paths: string[][];
  keyFile?: string;
  dotenv?: { file: string; name: string };
  terminalVar?: string;
  /** Hash of the config file just after the write, to notice later edits. */
  hash?: string;
  /** Every key path the apply set or removed: the part of the file the profile owns. */
  watch?: string[][];
  /** Hash of the values at `watch` just after the write. Edits elsewhere in the file don't count as a change. */
  managedHash?: string;
  at: number;
}

export interface Op {
  path: string[];
  /** undefined deletes the key. */
  value: unknown;
}

export interface SideEdit {
  file: string;
  kind: 'keyfile' | 'dotenv';
  /** New content; null deletes the file. */
  content: string | null;
}

export interface Issue {
  field: string;
  message: string;
}
