// Keeping keys out of sight: in previews, messages and logs a key shows as dots and its
// last four characters, so you can tell two keys apart without seeing either.
import { isCredentialHeader, looksSecretName, parseHeaderLines } from './profile';

export function mask(secret: string): string {
  const s = secret.trim();
  if (!s) return '';
  if (s.length < 12) return '••••••••';
  return `••••••••${s.slice(-4)}`;
}

/** Replaces every occurrence of each secret in the text. */
export function maskText(text: string, secrets: Iterable<string | undefined>): string {
  const list = [...new Set([...secrets].filter((s): s is string => !!s && s.trim().length >= 4))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const s of list) out = out.split(s).join(mask(s));
  return out;
}

/**
 * Values in a config object that look like credentials: under names such as
 * ANTHROPIC_AUTH_TOKEN, *_API_KEY, experimental_bearer_token or Authorization. Used to
 * mask a config file before it is shown, including keys this extension didn't write.
 */
export function secretsIn(obj: unknown, out: string[] = [], depth = 0): string[] {
  if (!obj || typeof obj !== 'object' || depth > 8) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length >= 8 && (looksSecretName(k) || /bearer_token$/i.test(k))) out.push(v);
    else if (typeof v === 'string') {
      // A token anywhere in the value, and credential lines of a header list such as
      // ANTHROPIC_CUSTOM_HEADERS ("x-api-key: ...").
      for (const m of v.matchAll(/\b(?:Bearer|Basic)\s+(\S{8,})/gi)) out.push(m[1]);
      if (v.includes(':')) for (const [name, val] of Object.entries(parseHeaderLines(v))) if (val.length >= 8 && isCredentialHeader(name, val)) out.push(val);
    } else if (typeof v === 'object') secretsIn(v, out, depth + 1);
  }
  return out;
}

/** Credentials in .env text: values of variables named like keys. */
export function secretsInDotenv(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']?([^"'\s]*)/);
    if (m && m[2].length >= 8) out.push(m[2]);
  }
  return out;
}

/** An error message with any secret in it masked, and nothing past the first lines. */
export function scrub(message: string, secrets: Iterable<string | undefined>): string {
  return maskText(message, secrets).split('\n').slice(0, 3).join(' ').slice(0, 400);
}
