// The profiles editor. Builds the DOM with textContent only (no HTML from data), validates
// with the same code the extension uses, and never keeps a key unless the person typed it
// or asked to see it.
import { availableModes, holds, context, validate, secretMode as modeOf } from '../src/core/profile';
import type { AgentDef, FieldDef, Issue, Profile, Scope } from '../src/core/types';
import type { AgentView, ProfileView, State, TestOutcome, ToHost, ToWebview } from '../src/protocol';

declare function acquireVsCodeApi(): { postMessage(m: ToHost): void; getState(): any; setState(s: any): void };
const vscode = acquireVsCodeApi();
const post = (m: ToHost) => vscode.postMessage(m);

type Children = (Node | string | null | undefined | false)[];
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: Children): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  // A button inside the form would submit it (and save) unless it says otherwise.
  if (el instanceof HTMLButtonElement && !('type' in attrs)) el.type = 'button';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}
const icon = (name: string, label?: string) => h('span', { class: `codicon codicon-${name}`, 'aria-hidden': label ? undefined : 'true', role: label ? 'img' : undefined, 'aria-label': label });

// ---- State ---------------------------------------------------------------------------

let state: State | undefined;
let selected: string | null = vscode.getState()?.selected ?? null;
/** "new:<agent>" shows the preset chooser. */
let creating: string | null = null;
let draft: Profile | undefined;
let secretDraft: string | null | undefined; // undefined: unchanged, null: remove
let revealed = false;
/** The saved key, only while the person has asked to see it. */
let shownSecret: string | undefined;
let showIssues = false;
let testResult: TestOutcome | undefined;
let testing = false;
let testNonce = 0;
const models = new Map<string, string[]>(); // agent -> model ids from the last test
/** The issues list was just opened by Apply: announce it once, not on every keystroke. */
let announceIssues = false;
/** Unsaved edits of profiles the person moved away from, kept until they come back. */
const stashed = new Map<string, { draft: Profile; secret: string | null | undefined }>();

// One live region for the whole session, outside the part that is rebuilt, so screen
// readers hear each message when it is set.
const live = h('div', { id: 'live', class: 'sr-only', role: 'status', 'aria-live': 'polite' });
document.body.append(live);
let liveTimer: ReturnType<typeof setTimeout> | undefined;
function announce(msg: string) {
  live.textContent = '';
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => (live.textContent = msg), 80);
}

const savedOf = (id: string | null) => state?.profiles.find((p) => p.id === id);
const agentOf = (id: string) => state!.agents.find((a) => a.def.id === id)!;
const strip = (p: ProfileView): Profile => ({ id: p.id, agent: p.agent, name: p.name, preset: p.preset, values: { ...p.values }, secretMode: p.secretMode, scope: p.scope });
/** A profile as saved: key order, surrounding spaces and empty values don't count as changes. */
const canon = (p: Profile) =>
  JSON.stringify({
    name: p.name.trim(),
    preset: p.preset ?? null,
    scope: p.scope,
    secretMode: p.secretMode,
    values: Object.keys(p.values)
      .sort()
      .map((k) => [k, (p.values[k] ?? '').replace(/\r\n/g, '\n').trim()])
      .filter(([, v]) => v !== ''),
  });
const dirty = () => {
  const s = savedOf(draft?.id ?? null);
  return !!draft && !!s && (canon(strip(s)) !== canon(draft) || secretDraft !== undefined);
};
/** The profile just saved: the next state replaces the draft with what was stored. */
let justSaved: string | undefined;

function select(id: string | null) {
  // Going back to the profile being edited (its sidebar entry, Cancel from "New profile",
  // or "Edit Profile" after a failed apply) keeps the unsaved edits and the typed key.
  if (draft && draft.id === id && dirty()) {
    selected = id;
    creating = null;
    vscode.setState({ ...vscode.getState(), selected });
    post({ type: 'selected', id });
    return;
  }
  if (draft && draft.id !== id && dirty()) {
    stashed.set(draft.id, { draft, secret: secretDraft });
    announce(`Unsaved changes to "${draft.name}" are kept until you go back to it.`);
  }
  selected = id;
  creating = null;
  const s = savedOf(id);
  const kept = id ? stashed.get(id) : undefined;
  if (id) stashed.delete(id);
  draft = kept && s ? kept.draft : s ? strip(s) : undefined;
  secretDraft = kept && s ? kept.secret : undefined;
  revealed = false;
  shownSecret = undefined;
  showIssues = false;
  testResult = undefined;
  vscode.setState({ ...vscode.getState(), selected });
  post({ type: 'selected', id });
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  if (m.type === 'state') {
    const keepDraft = draft && draft.id !== justSaved && dirty() && m.state.profiles.some((p) => p.id === draft!.id);
    if (draft && draft.id === justSaved) justSaved = undefined;
    state = m.state;
    for (const id of [...stashed.keys()]) if (!savedOf(id)) stashed.delete(id);
    if (m.state.select) select(m.state.select);
    else if (!keepDraft) {
      if (!savedOf(selected)) selected = state.profiles[0]?.id ?? null;
      const s = savedOf(selected);
      const keepSecret = secretDraft;
      draft = s ? strip(s) : undefined;
      secretDraft = draft && draft.id === s?.id ? keepSecret : undefined;
    }
    render();
  } else if (m.type === 'saved') {
    // save() already cleared the typed key; this can arrive after later clicks (a reveal),
    // so it changes nothing else.
    justSaved = m.id;
    announce('Saved.');
    refreshHead();
  } else if (m.type === 'secret') {
    if (draft?.id === m.id) {
      revealed = true;
      shownSecret = m.value;
      render();
      document.getElementById('secret')?.focus();
    }
  } else if (m.type === 'test') {
    if (m.nonce !== testNonce) return;
    testResult = m.result;
    if (m.result.models?.length && draft) models.set(draft.agent, m.result.models);
    announce(`${testHeading(m.result)}: ${m.result.message}`);
    render();
  } else if (m.type === 'busy') {
    testing = m.busy;
    render();
  }
});

// ---- Rendering -----------------------------------------------------------------------

const app = document.getElementById('app')!;

function render() {
  if (!state) return;
  const focus = document.activeElement?.id;
  const sel = (document.activeElement as HTMLInputElement | null)?.selectionStart;
  app.replaceChildren(sidebar(), h('main', { id: 'main', class: 'main', 'aria-label': 'Profile' }, mainArea()));
  announceIssues = false;
  if (focus) {
    const el = document.getElementById(focus) as HTMLInputElement | null;
    if (el) {
      el.focus();
      try {
        if (sel !== null && sel !== undefined && 'setSelectionRange' in el && el.type !== 'checkbox' && el.type !== 'radio') el.setSelectionRange(sel, sel);
      } catch {
        /* not a text field */
      }
    }
  }
}

function sidebar() {
  const nav = h('nav', { class: 'side', 'aria-label': 'Profiles' });
  for (const a of state!.agents) {
    const list = state!.profiles.filter((p) => p.agent === a.def.id);
    const sec = h(
      'section',
      { class: 'agent', 'aria-labelledby': `agent-${a.def.id}` },
      h(
        'div',
        { class: 'agent-head' },
        h('h2', { id: `agent-${a.def.id}` }, a.def.label),
        h('button', { class: 'icon-btn', id: `new-${a.def.id}`, title: `New ${a.def.label} profile`, 'aria-label': `New ${a.def.label} profile`, onClick: () => newProfile(a.def.id) }, icon('add')),
      ),
      h(
        'div',
        { class: 'file' },
        h('button', { class: 'link', id: `open-${a.def.id}`, title: `Open ${a.file}`, onClick: () => post({ type: 'openConfig', agent: a.def.id }) }, icon('file'), ' ', a.file),
        a.drift ? h('span', { class: 'warn', title: 'Changed outside Agent Profiles since the last apply' }, icon('warning'), h('span', { class: 'sr-only' }, ' changed outside Agent Profiles')) : null,
      ),
    );
    if (!list.length) sec.append(h('p', { class: 'muted small' }, 'No profiles yet.'));
    const ul = h('ul', { class: 'profiles', role: 'list' });
    for (const p of list) {
      const current = p.id === selected && !creating;
      const badges: Children = [];
      if (p.active) badges.push(h('span', { class: 'badge active' }, 'active'));
      if (p.activeProject) badges.push(h('span', { class: 'badge' }, 'project'));
      if (p.workspaceDefault) badges.push(h('span', { class: 'badge' }, 'workspace default'));
      if (stashed.has(p.id)) badges.push(h('span', { class: 'badge dirty' }, 'unsaved'));
      const sub = p.values[a.def.statusField] || a.def.statusFallback;
      ul.append(
        h(
          'li',
          {},
          h(
            'button',
            { class: `profile${current ? ' current' : ''}`, id: `profile-${p.id}`, 'aria-current': current ? 'true' : undefined, onClick: () => (select(p.id), render()) },
            h('span', { class: 'pname' }, p.active ? icon('pass-filled') : icon('circle-large-outline'), ' ', p.name),
            h('span', { class: 'psub' }, sub, ...badges),
          ),
        ),
      );
    }
    sec.append(ul);
    nav.append(sec);
  }
  nav.append(
    h(
      'div',
      { class: 'side-foot' },
      h('button', { class: 'secondary', id: 'import-profiles', onClick: () => post({ type: 'importProfiles' }) }, icon('cloud-download'), ' Import…'),
      h('button', { class: 'secondary', id: 'export-profiles', onClick: () => post({ type: 'exportProfiles' }), disabled: !state!.profiles.length }, icon('cloud-upload'), ' Export…'),
    ),
  );
  return nav;
}

function newProfile(agentId: string) {
  // The draft stays: Cancel comes back to it, and a new profile stashes it (select()).
  creating = agentId;
  render();
  document.querySelector<HTMLButtonElement>('.preset')?.focus();
}

function mainArea(): Node {
  if (creating) return chooser(agentOf(creating));
  if (!draft) return welcome();
  return form(agentOf(draft.agent), draft);
}

function welcome() {
  return h(
    'div',
    { class: 'welcome' },
    h('h1', {}, 'Agent Profiles'),
    h('p', {}, 'Keep the provider settings of Claude Code and Codex CLI as named profiles, and switch between them from the status bar. Keys stay in VS Code secret storage; every change to a config file is shown as a diff first and backed up.'),
    h('div', { class: 'row' }, ...state!.agents.map((a) => h('button', { class: 'primary', id: `welcome-${a.def.id}`, onClick: () => newProfile(a.def.id) }, icon('add'), ` New ${a.def.label} profile`))),
  );
}

function chooser(a: AgentView) {
  const grid = h('div', { class: 'presets', role: 'list' });
  for (const p of a.def.presets) {
    grid.append(
      h('div', { role: 'listitem' }, h('button', { class: 'preset', id: `preset-${p.id}`, onClick: () => post({ type: 'create', agent: a.def.id, preset: p.id }) }, h('strong', {}, p.label), h('span', {}, p.description))),
    );
  }
  grid.append(
    h('div', { role: 'listitem' }, h('button', { class: 'preset', id: 'preset-blank', onClick: () => post({ type: 'create', agent: a.def.id }) }, h('strong', {}, 'Blank'), h('span', {}, 'Every field empty.'))),
    h('div', { role: 'listitem' }, h('button', { class: 'preset', id: 'preset-import', onClick: () => post({ type: 'importCurrent', agent: a.def.id }) }, h('strong', {}, icon('cloud-download'), ' Import current config'), h('span', {}, `Make a profile from ${a.file} as it is now.`))),
  );
  return h(
    'div',
    { class: 'chooser' },
    h('h1', {}, `New ${a.def.label} profile`),
    h('p', { class: 'muted' }, 'Start from a preset. It only fills in the form: you can change every field before anything is written.'),
    grid,
    h('button', { class: 'secondary', id: 'cancel-new', onClick: () => ((creating = null), render()) }, 'Cancel'),
  );
}

function issuesFor(def: AgentDef, p: Profile): Issue[] {
  const s = savedOf(p.id);
  const hasSecret = secretDraft === null ? false : secretDraft ? true : !!s?.hasSecret;
  return validate(def, p, { hasSecret });
}

function form(a: AgentView, p: Profile) {
  const def = a.def;
  const saved = savedOf(p.id)!;
  const issues = issuesFor(def, p);
  const byField = new Map<string, Issue[]>();
  for (const i of issues) byField.set(i.field, [...(byField.get(i.field) ?? []), i]);
  const shown = (f: string) => (showIssues ? byField.get(f) : undefined);
  const ctx = context(def, p);

  const header = h(
    'header',
    { class: 'form-head' },
    h(
      'div',
      { class: 'title' },
      h('label', { for: 'name', class: 'sr-only' }, 'Profile name'),
      h('input', { id: 'name', class: 'name', value: p.name, 'aria-invalid': shown('name') ? 'true' : undefined, onInput: (e: Event) => update('name', (e.target as HTMLInputElement).value, false) }),
      h('span', { class: 'agent-label' }, def.label, saved.active ? h('span', { class: 'badge active' }, 'active') : null, dirty() ? h('span', { class: 'badge dirty' }, 'unsaved') : null),
    ),
    h(
      'div',
      { class: 'actions', role: 'toolbar', 'aria-label': 'Profile actions' },
      h('button', { class: 'primary', id: 'apply', onClick: () => apply() }, icon('check'), ' Apply…'),
      // Save is the form's only submit button, so Enter in a field saves. These two stay
      // focusable while unavailable (aria-disabled), so focus isn't lost when they change.
      h('button', { class: 'secondary', id: 'save', type: 'submit', 'aria-disabled': dirty() ? 'false' : 'true' }, icon('save'), ' Save'),
      h('button', { class: 'secondary', id: 'test', onClick: () => !testing && test(), 'aria-disabled': testing ? 'true' : 'false', 'aria-busy': testing ? 'true' : undefined }, icon(testing ? 'loading codicon-modifier-spin' : 'plug'), ' Test connection'),
      h('button', { class: 'icon-btn', id: 'duplicate', title: 'Duplicate', 'aria-label': 'Duplicate profile', onClick: () => post({ type: 'duplicate', id: p.id }) }, icon('copy')),
      h('button', { class: 'icon-btn', id: 'restore', title: 'Restore previous config…', 'aria-label': `Restore previous ${def.label} config`, onClick: () => post({ type: 'restore', agent: def.id }) }, icon('history')),
      h('button', { class: 'icon-btn danger', id: 'delete', title: 'Delete', 'aria-label': 'Delete profile', onClick: () => post({ type: 'delete', id: p.id }) }, icon('trash')),
    ),
  );

  const notices: Children = [];
  if (a.problem) notices.push(h('div', { class: 'notice error', role: 'alert' }, icon('error'), ' ', a.problem));
  if (a.drift && saved.active) notices.push(h('div', { class: 'notice warn' }, icon('warning'), ` ${a.file} changed outside Agent Profiles since this profile was applied. Applying again shows what differs.`));
  if (showIssues && issues.length) {
    notices.push(
      h(
        'div',
        { class: 'notice error', role: announceIssues ? 'alert' : undefined, id: 'issues' },
        h('strong', {}, `${issues.length} thing${issues.length === 1 ? '' : 's'} to fix before applying:`),
        h('ul', {}, ...issues.map((i) => h('li', {}, h('button', { class: 'link', onClick: () => focusField(fieldDomId(i.field)) }, labelOf(def, i.field)), `: ${i.message}`))),
      ),
    );
  }

  const groups = { connection: [] as Node[], models: [] as Node[], advanced: [] as Node[] };
  let advancedIssue = false;
  for (const f of def.fields) {
    if (!holds(f.when, ctx)) continue;
    groups[f.group].push(field(def, f, p, shown(f.id)));
    if (f.group === 'advanced' && shown(f.id)) advancedIssue = true;
  }

  const modeList = availableModes(def, p);
  const current = modeOf(def, p);
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, k) => ctx[k] || `<${k}>`);
  const needsKey = current.kind !== 'none';
  const keyStatus = secretDraft === null ? 'The saved key will be removed when you save.' : secretDraft ? 'A new key will be saved in secret storage when you save.' : saved.hasSecret ? `Saved in secret storage (${saved.maskedSecret}).` : 'No key saved.';
  const secretSection = h(
    'fieldset',
    { class: 'group' },
    h('legend', {}, def.secret.label),
    h('p', { class: 'help' }, def.secret.help),
    h(
      'div',
      { class: 'radios', role: 'radiogroup', 'aria-label': 'Where the key goes' },
      ...modeList.map((m) =>
        h(
          'label',
          { class: `radio${m.id === current.id ? ' checked' : ''}` },
          h('input', { type: 'radio', name: 'secretMode', id: `mode-${m.id}`, value: m.id, checked: m.id === current.id, 'aria-describedby': `mode-help-${m.id}`, onChange: () => update('secretMode', m.id, true) }),
          h('span', { class: 'radio-body' }, h('span', { class: 'radio-title' }, m.label, m.plaintext ? h('span', { class: 'badge plain' }, icon('unlock'), ' plain text on disk') : m.kind !== 'none' ? h('span', { class: 'badge safe' }, icon('lock'), ' not on disk') : null), h('span', { class: 'help', id: `mode-help-${m.id}` }, fill(m.help))),
        ),
      ),
    ),
    needsKey
      ? h(
          'div',
          { class: 'field' },
          h('label', { for: 'secret' }, def.secret.label),
          h(
            'div',
            { class: 'secret-row' },
            h('input', {
              id: 'secret',
              type: revealed ? 'text' : 'password',
              autocomplete: 'off',
              spellcheck: 'false',
              placeholder: saved.hasSecret ? `${saved.maskedSecret} (type to replace)` : 'Paste the key',
              value: revealed ? secretDraft ?? shownSecret ?? '' : secretDraft ?? '',
              'aria-describedby': 'secret-status',
              'aria-invalid': shown('secret') ? 'true' : undefined,
              onInput: (e: Event) => {
                secretDraft = (e.target as HTMLInputElement).value || undefined;
                if (showIssues) render();
                else refreshHead();
              },
            }),
            h(
              'button',
              { class: 'icon-btn', id: 'reveal', title: revealed ? 'Hide key' : 'Show key', 'aria-label': revealed ? 'Hide key' : 'Show key', 'aria-pressed': revealed ? 'true' : 'false', onClick: () => toggleReveal(p.id, saved.hasSecret) },
              icon(revealed ? 'eye-closed' : 'eye'),
            ),
            saved.hasSecret ? h('button', { class: 'icon-btn', id: 'clear-secret', title: 'Remove the saved key', 'aria-label': 'Remove the saved key', onClick: () => ((secretDraft = null), (revealed = false), (shownSecret = undefined), render()) }, icon('close')) : null,
          ),
          h('p', { class: 'help', id: 'secret-status' }, keyStatus),
          ...(shown('secret') ?? []).map((i) => h('p', { class: 'field-error' }, icon('error'), ' ', i.message)),
        )
      : null,
    ...(shown('secretMode') ?? []).map((i) => h('p', { class: 'field-error' }, icon('error'), ' ', i.message)),
  );

  const scope = def.projectConfig
    ? h(
        'fieldset',
        { class: 'group' },
        h('legend', {}, 'Apply to'),
        h(
          'div',
          { class: 'radios', role: 'radiogroup', 'aria-label': 'Apply to' },
          scopeRadio('user', `All projects (${a.file})`, 'Your user settings.', p, true),
          scopeRadio('project', `This workspace only (${a.projectFile ?? def.projectConfig.file})`, !state!.hasWorkspace ? 'Open a folder to use this.' : !state!.diskFolder ? 'Project settings need a folder on disk; this workspace has none.' : !state!.trusted ? 'Not available in Restricted Mode: trust this workspace to write its settings.' : def.projectConfig.note, p, state!.trusted && state!.diskFolder),
        ),
      )
    : null;

  const testBox = testResult
    ? h(
        'div',
        { class: `notice ${testResult.unverified ? 'warn' : testResult.ok ? 'ok' : 'error'}`, id: 'test-result' },
        icon(testResult.unverified ? 'warning' : testResult.ok ? 'pass' : 'error'),
        ' ',
        h('strong', {}, testHeading(testResult)),
        testResult.status ? ` · HTTP ${testResult.status}` : '',
        testResult.latencyMs ? ` · ${testResult.latencyMs} ms` : '',
        h('div', {}, testResult.message),
        testResult.url ? h('div', { class: 'muted small' }, testResult.url) : null,
        testResult.models?.length ? h('div', { class: 'muted small' }, 'Model fields now suggest the listed models.') : null,
      )
    : null;

  const wsDefault = state!.hasWorkspace
    ? h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', id: 'workspace-default', checked: saved.workspaceDefault, onChange: (e: Event) => post({ type: 'workspaceDefault', agent: def.id, id: (e.target as HTMLInputElement).checked ? p.id : null }) }),
        ` Suggest this profile when this workspace opens`,
      )
    : null;

  const presetDocs = def.presets.find((x) => x.id === p.preset)?.docs;
  return h(
    'form',
    { class: 'form', id: 'profile-form', 'aria-label': `${def.label} profile ${p.name}`, onSubmit: (e: Event) => (e.preventDefault(), dirty() && save()), novalidate: true },
    header,
    ...notices,
    h(
      'p',
      { class: 'muted small' },
      def.note ?? '',
      ' ',
      presetDocs ? h('button', { class: 'link', type: 'button', onClick: () => post({ type: 'openDocs', url: presetDocs }) }, icon('link-external'), ' Provider docs') : null,
    ),
    testBox,
    h('fieldset', { class: 'group' }, h('legend', {}, 'Connection'), ...groups.connection),
    secretSection,
    h('fieldset', { class: 'group' }, h('legend', {}, 'Models'), ...groups.models),
    h('details', { class: 'group', id: 'advanced', open: (vscode.getState()?.advanced ?? false) || advancedIssue, onToggle: (e: Event) => vscode.setState({ ...vscode.getState(), advanced: (e.target as HTMLDetailsElement).open }) }, h('summary', {}, 'Advanced'), ...groups.advanced),
    scope,
    wsDefault,
    models.get(def.id)?.length ? h('datalist', { id: `models-${def.id}` }, ...models.get(def.id)!.map((m) => h('option', { value: m }))) : null,
  );
}

function scopeRadio(value: Scope, title: string, help: string, p: Profile, enabled: boolean) {
  return h(
    'label',
    { class: `radio${p.scope === value ? ' checked' : ''}${enabled ? '' : ' disabled'}` },
    h('input', { type: 'radio', name: 'scope', id: `scope-${value}`, value, checked: p.scope === value, disabled: !enabled && p.scope !== value, 'aria-describedby': `scope-help-${value}`, onChange: () => update('scope', value, true) }),
    h('span', { class: 'radio-body' }, h('span', { class: 'radio-title' }, title), h('span', { class: 'help', id: `scope-help-${value}` }, help)),
  );
}

const testHeading = (r: TestOutcome) => (r.unverified ? 'Reachable, key not checked' : r.ok ? 'Connected' : 'Failed');

/** Moves to a field, opening the collapsed section it's in. */
function focusField(id: string) {
  const el = document.getElementById(id);
  const details = el?.closest('details');
  if (details && !details.open) {
    details.open = true;
    vscode.setState({ ...vscode.getState(), advanced: true });
  }
  el?.focus();
}

const fieldDomId = (f: string) => (f === 'name' ? 'name' : f === 'secret' ? 'secret' : f === 'secretMode' ? 'mode-none' : `f-${f}`);
const labelOf = (def: AgentDef, f: string) => (f === 'name' ? 'Name' : f === 'secret' ? def.secret.label : f === 'secretMode' ? 'Where the key goes' : def.fields.find((x) => x.id === f)?.label ?? f);

function field(def: AgentDef, f: FieldDef, p: Profile, errors: Issue[] | undefined): Node {
  const id = `f-${f.id}`;
  const value = p.values[f.id] ?? (f.type === 'constant' ? '' : f.default ?? '');
  const described = `${id}-help`;
  const common = { id, 'aria-describedby': errors ? `${described} ${id}-err` : described, 'aria-invalid': errors ? 'true' : undefined, 'aria-required': f.required ? 'true' : undefined };
  const structural = def.fields.some((x) => [x.when ?? [], x.requiredWhen ?? []].flat().some((w) => w.field === f.id)) || def.secret.modes.some((m) => [m.when ?? []].flat().some((w) => w.field === f.id) || (m.help.includes(`{${f.id}}`)));
  const onInput = (e: Event) => update(f.id, (e.target as HTMLInputElement).value, false);
  const onChange = (e: Event) => update(f.id, (e.target as HTMLInputElement).value, structural);
  let control: Node;
  if (f.type === 'constant') {
    return h('div', { class: 'field constant' }, h('span', { class: 'muted small' }, icon('info'), ' ', f.help));
  } else if (f.type === 'boolean') {
    control = h('label', { class: 'check' }, h('input', { ...common, type: 'checkbox', checked: value === 'true', onChange: (e: Event) => update(f.id, (e.target as HTMLInputElement).checked ? 'true' : 'false', structural) }), ' ', f.label);
    return h('div', { class: 'field' }, control, h('p', { class: 'help', id: described }, f.help), errs(errors, id));
  } else if (f.type === 'select' && !f.freeform) {
    control = h('select', { ...common, onChange }, ...f.options!.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  } else if (f.type === 'map' || f.type === 'text') {
    control = h('textarea', { ...common, rows: Math.max(2, Math.min(8, value.split('\n').length + 1)), placeholder: f.placeholder, spellcheck: 'false', onInput, onChange }, value);
  } else {
    const listId = f.models && models.get(def.id)?.length ? `models-${def.id}` : f.options ? `opts-${f.id}` : undefined;
    control = h('input', {
      ...common,
      type: f.type === 'number' ? 'text' : f.type === 'url' ? 'url' : 'text',
      inputmode: f.type === 'number' ? 'numeric' : undefined,
      value,
      placeholder: f.placeholder,
      spellcheck: 'false',
      autocomplete: 'off',
      list: listId,
      onInput,
      onChange,
    });
    if (listId === `opts-${f.id}`) control = h('span', { class: 'with-list' }, control, h('datalist', { id: listId }, ...f.options!.map((o) => h('option', { value: o.value }, o.label))));
  }
  return h('div', { class: 'field' }, h('label', { for: id }, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null), control, h('p', { class: 'help', id: described }, f.help), errs(errors, id));
}

const errs = (errors: Issue[] | undefined, id: string) => (errors?.length ? h('div', { id: `${id}-err` }, ...errors.map((i) => h('p', { class: 'field-error' }, icon('error'), ' ', i.message))) : null);

function update(key: string, value: string, structural: boolean) {
  if (!draft) return;
  if (key === 'name') draft.name = value;
  else if (key === 'secretMode') draft.secretMode = value;
  else if (key === 'scope') draft.scope = value as Scope;
  else draft.values[key] = value;
  testResult = undefined;
  if (structural || showIssues) render();
  else refreshHead();
}

/** Updates the unsaved badge and Save button without rebuilding the form. */
function refreshHead() {
  document.getElementById('save')?.setAttribute('aria-disabled', dirty() ? 'false' : 'true');
  const label = document.querySelector('.agent-label');
  const badge = label?.querySelector('.dirty');
  if (dirty() && !badge) label?.append(h('span', { class: 'badge dirty' }, 'unsaved'));
  if (!dirty() && badge) badge.remove();
}

function toggleReveal(id: string, hasSecret: boolean) {
  if (revealed) {
    revealed = false;
    shownSecret = undefined;
    render();
    return;
  }
  if (secretDraft || !hasSecret) {
    revealed = true;
    render();
    return;
  }
  post({ type: 'reveal', id });
}

function save(apply = false) {
  if (!draft) return;
  const def = agentOf(draft.agent).def;
  if (apply) {
    const issues = issuesFor(def, draft);
    if (issues.length) {
      showIssues = true;
      announceIssues = true;
      render();
      document.getElementById('issues')?.querySelector('button')?.focus();
      return;
    }
  }
  post({ type: 'save', profile: draft, secret: secretDraft, apply: apply ? { scope: draft.scope, hash: formHash(draft) } : undefined });
  secretDraft = undefined;
  revealed = false;
  shownSecret = undefined;
}

function apply() {
  if (!draft) return;
  if (dirty()) return save(true);
  const def = agentOf(draft.agent).def;
  const issues = issuesFor(def, draft);
  if (issues.length) {
    showIssues = true;
    announceIssues = true;
    render();
    document.getElementById('issues')?.querySelector('button')?.focus();
    return;
  }
  post({ type: 'apply', id: draft.id, scope: draft.scope, hash: formHash(draft) });
}

/** The hash of the file the apply will write, as the form saw it ('' when not known). */
function formHash(p: Profile): string {
  const a = agentOf(p.agent);
  return p.scope === 'project' && a.def.projectConfig ? (a.projectHash ?? '') : a.hash;
}

function test() {
  if (!draft) return;
  testNonce++;
  testResult = undefined;
  post({ type: 'test', profile: draft, secret: secretDraft || undefined, nonce: testNonce });
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (dirty()) save();
  }
});

post({ type: 'ready' });
