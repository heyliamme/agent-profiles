// Applying key operations to JSON and TOML text while keeping everything else as it was:
// key order, indentation, comments, other tables. A file with a syntax error is refused,
// never replaced.
import { parse as tomlParse, patch as tomlPatch } from '@decimalturn/toml-patch';
import { applyEdits, modify, parse as jsoncParse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import type { Format, Op } from './types';

export class ConfigSyntaxError extends Error {}

export function read(format: Format, text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  if (format === 'json') {
    const errors: ParseError[] = [];
    const v = jsoncParse(text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length) {
      const e = errors[0];
      const line = text.slice(0, e.offset).split('\n').length;
      throw new ConfigSyntaxError(`${printParseErrorCode(e.error)} on line ${line}`);
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ConfigSyntaxError('the file is not a JSON object');
    return v;
  }
  try {
    return tomlParse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigSyntaxError(String((e as Error).message).split('\n')[0]);
  }
}

export function get(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const s of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

/** The object after the operations, with tables emptied by a removal pruned. */
export function applyToObject(obj: Record<string, unknown>, ops: Op[]): Record<string, unknown> {
  const out = clone(obj) as Record<string, unknown>;
  const emptied: string[][] = [];
  for (const op of ops) {
    const parent = op.path.slice(0, -1);
    const last = op.path[op.path.length - 1];
    if (op.value === undefined) {
      const holder = get(out, parent);
      if (isObj(holder) && last in holder) {
        delete holder[last];
        emptied.push(parent);
      }
      continue;
    }
    let cur: Record<string, unknown> = out;
    for (const s of parent) {
      if (!isObj(cur[s])) cur[s] = {};
      cur = cur[s] as Record<string, unknown>;
    }
    cur[last] = op.value;
  }
  pruneEmpty(out, emptied);
  return out;
}

/**
 * A deep copy of tables and arrays. Everything else is shared: TOML dates are toml-patch
 * objects that remember how they were written, and structuredClone would turn them into
 * plain Dates that print differently, so the result would never match the file.
 */
function clone(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
  return v;
}

function pruneEmpty(obj: Record<string, unknown>, emptied: string[][]) {
  for (const p of emptied) {
    for (let n = p.length; n > 0; n--) {
      const at = p.slice(0, n);
      const v = get(obj, at);
      if (!isObj(v) || Object.keys(v).length) break;
      const holder = get(obj, at.slice(0, -1)) as Record<string, unknown>;
      delete holder[at[at.length - 1]];
    }
  }
}

export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}
function canon(v: unknown): unknown {
  // toml-patch's dates print the text they were read from; the instant is compared too.
  if (v instanceof Date) return { $date: v.toISOString(), $t: v.getTime() };
  if (typeof v === 'bigint') return { $big: v.toString() };
  if (Array.isArray(v)) return v.map(canon);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

export function applyOps(format: Format, text: string, ops: Op[]): string {
  const before = read(format, text);
  const expected = applyToObject(before, ops);
  const result = format === 'json' ? jsonApply(text, before, ops) : tomlApply(text, before, ops, expected);
  if (!same(read(format, result), expected)) throw new Error('The edited file would not hold the expected values; nothing was written.');
  return result;
}

// ---- JSON ---------------------------------------------------------------------------

function detectIndent(text: string): { insertSpaces: boolean; tabSize: number } {
  const m = text.match(/\n([ \t]+)\S/);
  if (!m) return { insertSpaces: true, tabSize: 2 };
  if (m[1].startsWith('\t')) return { insertSpaces: false, tabSize: 1 };
  return { insertSpaces: true, tabSize: m[1].length };
}

function jsonApply(text: string, before: Record<string, unknown>, ops: Op[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let out = text.trim() ? text : '{}' + eol;
  const formattingOptions = { ...detectIndent(text), eol };
  const emptied: string[][] = [];
  let cur = before;
  for (const op of ops) {
    if (op.value === undefined) {
      if (get(cur, op.path) === undefined) continue;
      emptied.push(op.path.slice(0, -1));
    }
    out = applyEdits(out, modify(out, op.path, op.value, { formattingOptions }));
    cur = read('json', out);
  }
  for (const p of emptied) {
    for (let n = p.length; n > 0; n--) {
      const at = p.slice(0, n);
      const v = get(cur, at);
      if (!isObj(v) || Object.keys(v).length) break;
      out = applyEdits(out, modify(out, at, undefined, { formattingOptions }));
      cur = read('json', out);
    }
  }
  if (!out.endsWith('\n')) out += eol;
  return out;
}

// ---- TOML ---------------------------------------------------------------------------
// A small line-level editor for what profiles change: top-level keys and keys of one
// [a.b] table, with scalar or inline-table values. It keeps comments and layout. If the
// file is shaped in a way it doesn't handle (dotted keys, an inline provider table,
// multi-line values), it falls back to toml-patch, and either way the result is checked
// against the expected document before anything is returned.

const BARE = /^[A-Za-z0-9_-]+$/;
export const tomlKey = (k: string) => (BARE.test(k) ? k : JSON.stringify(k));

export function tomlValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('not a finite number');
    return String(v);
  }
  if (typeof v === 'boolean') return String(v);
  if (isObj(v)) {
    const parts = Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  throw new Error(`can't write ${typeof v} to TOML`);
}

interface Section {
  /** Header path, [] for the top of the file. */
  path: string[] | null;
  /** Line of the header (-1 for the top). */
  header: number;
  /** First line after the section's last line. */
  end: number;
}

const HEADER = /^\s*\[(?!\[)\s*((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*\]\s*(#.*)?$/;
const ARRAY_HEADER = /^\s*\[\[/;

function splitKey(k: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:\.|$)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(k)) && m[0]) out.push(m[1] ?? (m[2] !== undefined ? JSON.parse(`"${m[2]}"`) : m[3]));
  return out;
}

function sections(lines: string[]): Section[] {
  const out: Section[] = [{ path: [], header: -1, end: lines.length }];
  lines.forEach((l, i) => {
    const m = l.match(HEADER);
    if (m || ARRAY_HEADER.test(l)) {
      out[out.length - 1].end = i;
      out.push({ path: m ? splitKey(m[1]) : null, header: i, end: lines.length });
    }
  });
  return out;
}

/** The line where key `name` is assigned directly in a section, if it is on one line. */
function findKey(lines: string[], s: Section, name: string): number | 'complex' | undefined {
  for (let i = s.header + 1; i < s.end; i++) {
    const m = lines[i].match(/^\s*((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=/);
    if (!m) continue;
    const key = splitKey(m[1]);
    if (key.length === 1 && key[0] === name) {
      // A value that continues on the next lines can't be replaced line by line.
      try {
        tomlParse(lines[i]);
        return i;
      } catch {
        return 'complex';
      }
    }
    if (key.length > 1 && key[0] === name) return 'complex';
  }
  return undefined;
}

function trailingComment(line: string): string {
  // The part after the value: only for a line that parses on its own, so a # inside a
  // string isn't mistaken for a comment.
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i] !== '#') continue;
    const head = line.slice(0, i).trimEnd();
    try {
      tomlParse(head);
      return ' ' + line.slice(i);
    } catch {
      /* the # is inside a value */
    }
  }
  return '';
}

class Unhandled extends Error {}

function lineEdit(text: string, before: Record<string, unknown>, ops: Op[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let cur = before;
  for (const op of ops) {
    const tablePath = op.path.slice(0, -1);
    const name = op.path[op.path.length - 1];
    const secs = sections(lines);
    const sec = secs.find((s) => s.path && s.path.length === tablePath.length && s.path.every((x, i) => x === tablePath[i]));
    if (op.value === undefined) {
      if (get(cur, op.path) === undefined) continue;
      if (!sec) throw new Unhandled();
      const at = findKey(lines, sec, name);
      if (typeof at !== 'number') throw new Unhandled();
      lines.splice(at, 1);
      const s2 = sections(lines).find((s) => s.header === sec.header)!;
      // A table left with nothing but blank lines and comments goes too.
      if (tablePath.length && lines.slice(s2.header + 1, s2.end).every((l) => !l.trim() || /^\s*#/.test(l))) {
        const isEmptyObj = (() => {
          const after = applyToObject(cur, [op]);
          return get(after, tablePath) === undefined;
        })();
        if (isEmptyObj) {
          let end = s2.end;
          // Keep comments that introduce the next table.
          while (end > s2.header + 1 && /^\s*#/.test(lines[end - 1])) end--;
          lines.splice(s2.header, end - s2.header);
          while (s2.header > 0 && s2.header < lines.length && !lines[s2.header - 1].trim() && !lines[s2.header]?.trim()) lines.splice(s2.header, 1);
        }
      }
    } else {
      const value = `${tomlKey(name)} = ${tomlValue(op.value)}`;
      if (sec) {
        const at = findKey(lines, sec, name);
        if (at === 'complex') throw new Unhandled();
        if (typeof at === 'number') {
          const indent = lines[at].match(/^\s*/)![0];
          lines[at] = indent + value + trailingComment(lines[at]);
        } else {
          if (get(cur, op.path) !== undefined) throw new Unhandled();
          // After the section's last key line.
          let pos = sec.header + 1;
          for (let i = sec.header + 1; i < sec.end; i++) if (lines[i].trim() && !/^\s*#/.test(lines[i])) pos = i + 1;
          if (sec.header === -1 && pos === 0) {
            // No top-level keys yet. A comment block at the top followed by a blank line
            // heads the file and stays above; a comment right above a table belongs to it.
            let j = 0;
            while (j < lines.length && /^\s*#/.test(lines[j])) j++;
            pos = j === lines.length ? j : j > 0 && !lines[j].trim() ? j + 1 : 0;
            lines.splice(pos, 0, value);
            if (pos + 1 < lines.length && lines[pos + 1].trim()) lines.splice(pos + 1, 0, '');
          } else lines.splice(pos, 0, value);
        }
      } else {
        // A new table at the end of the file, unless it exists in another form.
        if (get(cur, tablePath) !== undefined) throw new Unhandled();
        for (let n = 1; n < tablePath.length; n++) {
          const v = get(cur, tablePath.slice(0, n));
          if (v !== undefined && !isObj(v)) throw new Unhandled();
        }
        if (lines.length && lines[lines.length - 1].trim()) lines.push('');
        lines.push(`[${tablePath.map(tomlKey).join('.')}]`, value);
      }
    }
    cur = read('toml', lines.join('\n'));
  }
  return lines.join(eol) + eol;
}

function tomlApply(text: string, before: Record<string, unknown>, ops: Op[], expected: Record<string, unknown>): string {
  try {
    const out = lineEdit(text, before, ops);
    if (same(read('toml', out), expected)) return out;
  } catch (e) {
    // The original text was read before this point, so a syntax error here comes from the
    // line edit itself (a new [table] that clashes with an inline one): not the file's fault.
    if (!(e instanceof Unhandled) && !(e instanceof ConfigSyntaxError)) throw e;
  }
  return tomlPatch(text, expected);
}
