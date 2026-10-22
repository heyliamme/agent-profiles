// "Test connection": one small request to the configured endpoint, only when asked. First
// the models list; if the endpoint has none, a minimal request to the model. The key is
// sent only to the configured address (redirects are not followed) and never appears in
// the result.
import { context, holds, parseHeaderLines, parseMap, secretMode } from './profile';
import { scrub } from './mask';
import type { AgentDef, Profile, TestAuth } from './types';

export interface TestRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface TestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  message: string;
  models?: string[];
  /** The address tried last, without query parameters. */
  url: string;
  /** The endpoint answered, but nothing it said shows that the key works. */
  unverified?: boolean;
}

export type Prepared =
  | { supported: false; reason: string }
  | {
      supported: true;
      list: TestRequest;
      probe?: TestRequest;
      probeMissing?: string;
      /** The header that carries the key, to tell a public models list from one that checked it. */
      authHeader?: string;
    };

export function prepare(def: AgentDef, p: Profile, secret: string | undefined): Prepared {
  const t = def.test;
  if (!t) return { supported: false, reason: `Testing isn't available for ${def.label}.` };
  const ctx = context(def, p);
  if (!holds(t.when, ctx)) return { supported: false, reason: t.unsupported };
  // Only what the agent will use: a value kept in a field that's hidden now is not written
  // on apply, so it isn't tested either.
  const value = (id: string | undefined) => {
    const f = id ? def.fields.find((x) => x.id === id) : undefined;
    return f && holds(f.when, ctx) ? (p.values[f.id] ?? '') : '';
  };
  let base = value(t.baseUrlField).trim();
  if (!base) {
    const d = t.defaultBaseUrl;
    base = typeof d === 'string' ? d : (d && t.defaultBaseUrlBy ? d[ctx[t.defaultBaseUrlBy]] : undefined) ?? '';
  }
  if (!base) return { supported: false, reason: 'Enter the base URL first.' };
  let root: URL;
  try {
    root = new URL(base);
    if (!/^https?:$/.test(root.protocol)) throw new Error();
  } catch {
    return { supported: false, reason: 'The base URL is not a valid http(s) address.' };
  }
  const headers: Record<string, string> = { ...(t.headers ?? {}) };
  if (t.headersField) {
    const raw = value(t.headersField);
    const f = def.fields.find((x) => x.id === t.headersField);
    Object.assign(headers, f?.type === 'map' ? parseMap(raw) : parseHeaderLines(raw));
  }
  const mode = secretMode(def, p);
  let authHeader: string | undefined;
  if (mode.kind !== 'none') {
    if (!secret) return { supported: false, reason: `Enter the ${def.secret.label.toLowerCase()} first.` };
    const auth: TestAuth | undefined = t.authBy ? (t.auth as Record<string, TestAuth>)[ctx[t.authBy]] : (t.auth as TestAuth);
    if (!auth) return { supported: false, reason: t.unsupported };
    headers[auth.header] = (auth.prefix ?? '') + secret;
    authHeader = auth.header;
  }
  const query = t.queryField ? parseMap(value(t.queryField)) : {};
  const url = (suffix: string) => {
    const u = new URL(root.href.replace(/\/+$/, '') + suffix);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.href;
  };
  const list: TestRequest = { method: 'GET', url: url(t.list.path), headers };
  let model = value(t.probe.modelField).trim();
  const modelLabel = (id: string) => def.fields.find((f) => f.id === id)?.label ?? id;
  // An alias the agent resolves itself (Claude Code's opus, sonnet, ...) is not a model id
  // the endpoint knows: test with the model it stands for, or not with a request at all.
  const aliasField = t.probe.aliases && Object.prototype.hasOwnProperty.call(t.probe.aliases, model) ? t.probe.aliases[model] : undefined;
  if (aliasField !== undefined) {
    const real = aliasField ? value(aliasField).trim() : '';
    if (!real) return { supported: true, list, authHeader, probeMissing: aliasField ? `${model} is an alias; set ${modelLabel(aliasField).toLowerCase()} to test with a request instead.` : `${model} is chosen by ${def.label}; set a model id to test with a request instead.` };
    model = real;
  }
  if (!model) return { supported: true, list, authHeader, probeMissing: `Set ${def.fields.find((f) => f.id === t.probe.modelField)?.label.toLowerCase() ?? 'a model'} to test with a request instead.` };
  const probe: TestRequest = { method: 'POST', url: url(t.probe.path), headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model, ...t.probe.body }) };
  return { supported: true, list, probe, authHeader };
}

type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'manual' },
) => Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string>; body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null }>;

/** More than any models list or error message needs; the rest of a body is not read. */
export const MAX_BODY = 200_000;

const strip = (u: string) => u.split('?')[0];

async function send(req: TestRequest, fetchImpl: Fetch, timeoutMs: number, now: () => number) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = now();
  try {
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ac.signal, redirect: 'manual' });
    const body = await readCapped(res, ac);
    return { status: res.status, body, location: res.headers.get('location'), ms: Math.round(now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

/** The start of the body, without buffering an endless or huge answer. */
async function readCapped(res: Awaited<ReturnType<Fetch>>, ac: AbortController): Promise<string> {
  const len = Number(res.headers.get('content-length'));
  if (!res.body) {
    if (len > MAX_BODY) {
      ac.abort();
      return '';
    }
    return (await res.text()).slice(0, MAX_BODY);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const room = MAX_BODY - bytes;
    out += dec.decode(value.subarray(0, room), { stream: true });
    bytes += value.byteLength;
    if (bytes >= MAX_BODY) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return out + dec.decode();
}

function modelIds(body: string): string[] | undefined {
  try {
    const j = JSON.parse(body);
    const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : undefined;
    if (!arr) return undefined;
    return arr
      .map((m: unknown) => (typeof m === 'string' ? m : (m as { id?: string; name?: string })?.id ?? (m as { name?: string })?.name))
      .filter((x: unknown): x is string => typeof x === 'string')
      .slice(0, 500);
  } catch {
    return undefined;
  }
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail;
    if (typeof m === 'string') return m;
  } catch {
    /* not JSON */
  }
  return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function explain(status: number, body: string, location: string | null, secrets: string[]): string {
  const detail = scrub(errorText(body), secrets).slice(0, 200);
  const tail = detail ? `: ${detail}` : '';
  if (status >= 300 && status < 400) return `Redirected to ${location ? strip(location) : 'another address'} (${status}). Check the base URL; the key was not sent there.`;
  if (status === 401 || status === 403) return `The key was refused (${status})${tail}`;
  if (status === 404) return `Nothing at this address (404). Check the base URL${tail}`;
  if (status === 429) return `Rate limited (429): the endpoint and key work, but you are over a limit${tail}`;
  return `HTTP ${status}${tail}`;
}

export async function runTest(prepared: Prepared, opts: { fetch: Fetch; timeoutMs: number; secrets: string[]; now?: () => number }): Promise<TestResult> {
  if (!prepared.supported) return { ok: false, latencyMs: 0, message: prepared.reason, url: '' };
  const now = opts.now ?? (() => performance.now());
  const attempt = async (req: TestRequest) => {
    try {
      return await send(req, opts.fetch, opts.timeoutMs, now);
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      if (err.name === 'AbortError') return { error: `No answer within ${Math.round(opts.timeoutMs / 1000)} s.` };
      const why = err.cause?.code ?? err.cause?.message ?? err.message;
      return { error: `Could not connect: ${scrub(String(why), opts.secrets)}` };
    }
  };
  const list = await attempt(prepared.list);
  if ('error' in list) return { ok: false, latencyMs: 0, message: list.error!, url: strip(prepared.list.url) };
  if (list.status >= 200 && list.status < 300) {
    const models = modelIds(list.body);
    const listed = models ? `${models.length} model${models.length === 1 ? '' : 's'} listed` : '';
    const ok = { ok: true, status: list.status, latencyMs: list.ms, models, url: strip(prepared.list.url) };
    // Some models lists are public (OpenRouter's is): asked again without the key, they
    // still answer, so a 200 says nothing about the key. Then the one-token request decides.
    if (prepared.authHeader) {
      const headers = Object.fromEntries(Object.entries(prepared.list.headers).filter(([k]) => k.toLowerCase() !== prepared.authHeader!.toLowerCase()));
      const anon = await attempt({ ...prepared.list, headers });
      if (!('error' in anon) && anon.status >= 200 && anon.status < 300) {
        if (!prepared.probe) return { ...ok, unverified: true, message: `Reachable${listed ? `, ${listed}` : ''}, but this models list answers without a key, so the key was not checked. ${prepared.probeMissing ?? ''}`.trim() };
        const probe = await attempt(prepared.probe);
        if ('error' in probe) return { ok: false, latencyMs: 0, models, message: probe.error!, url: strip(prepared.probe.url) };
        if (probe.status >= 200 && probe.status < 300) return { ...ok, status: probe.status, latencyMs: probe.ms, message: `Connected: the key works, the model answered a one-token request${listed ? `. ${listed[0].toUpperCase()}${listed.slice(1)}` : ''}.`, url: strip(prepared.probe.url) };
        return { ok: false, status: probe.status, latencyMs: probe.ms, models, message: explain(probe.status, probe.body, probe.location, opts.secrets), url: strip(prepared.probe.url) };
      }
    }
    return { ...ok, message: listed ? `Connected. ${listed[0].toUpperCase()}${listed.slice(1)}.` : 'Connected.' };
  }
  // No models endpoint: fall back to a minimal request.
  if ((list.status === 404 || list.status === 405) && (prepared.probe || prepared.probeMissing)) {
    if (!prepared.probe) return { ok: false, status: list.status, latencyMs: list.ms, message: `This endpoint has no models list (${list.status}). ${prepared.probeMissing}`, url: strip(prepared.list.url) };
    const probe = await attempt(prepared.probe);
    if ('error' in probe) return { ok: false, latencyMs: 0, message: probe.error!, url: strip(prepared.probe.url) };
    if (probe.status >= 200 && probe.status < 300) return { ok: true, status: probe.status, latencyMs: probe.ms, message: 'Connected: the model answered a one-token request.', url: strip(prepared.probe.url) };
    return { ok: false, status: probe.status, latencyMs: probe.ms, message: explain(probe.status, probe.body, probe.location, opts.secrets), url: strip(prepared.probe.url) };
  }
  return { ok: false, status: list.status, latencyMs: list.ms, message: explain(list.status, list.body, list.location, opts.secrets), url: strip(prepared.list.url) };
}
