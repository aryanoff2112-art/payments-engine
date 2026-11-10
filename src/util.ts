import { createHash } from 'crypto';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Deterministic JSON: object keys sorted recursively, so {a,b} and {b,a} hash identically. */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, canonicalize(x)]),
    );
  }
  return v;
}

export const requestHash = (endpoint: string, body: unknown) =>
  sha256(endpoint + '\n' + JSON.stringify(canonicalize(body)));
