import { lookup as dnsLookup } from 'dns';
import { isIP } from 'net';
import http from 'http';
import https from 'https';
import { isBlockedIp } from './ipGuard';

export class UnsafeUrlError extends Error {
  constructor(public reason: string) { super(`unsafe webhook url: ${reason}`); }
}

export interface UrlPolicy {
  /** Test/dev escape hatch: permit http and private/loopback targets. Never enable in production. */
  allowPrivateTargets: boolean;
}

const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.localdomain|metadata\.google\.internal|instance-data)\.?$/i;

/**
 * Static checks that need no DNS. Used at registration (fast feedback) AND again at delivery time.
 * Returns the parsed URL; throws UnsafeUrlError otherwise.
 */
export function assertSafeWebhookUrl(raw: string, policy: UrlPolicy): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UnsafeUrlError('not a valid URL'); }
  if (policy.allowPrivateTargets) {
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UnsafeUrlError('scheme must be http or https');
    return u;
  }
  if (u.protocol !== 'https:') throw new UnsafeUrlError('scheme must be https');
  if (u.username || u.password) throw new UnsafeUrlError('credentials in URL are not allowed');
  if (u.port && u.port !== '443') throw new UnsafeUrlError('only port 443 is allowed');
  if (raw.length > 2048) throw new UnsafeUrlError('URL too long');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // WHATWG URL already normalises decimal/octal/hex IPv4 forms (http://2130706433, 0x7f.1) to dotted quads.
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new UnsafeUrlError('target address is not publicly routable');
  } else if (BLOCKED_HOSTS.test(host) || !host.includes('.')) {
    throw new UnsafeUrlError('hostname is not allowed');
  }
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/**
 * DNS lookup used for the actual TCP connection. It resolves, rejects the connection if ANY returned
 * address is non-public, and hands that exact address to the socket. Because validation and connection
 * use the same answer, there is no gap for DNS rebinding to exploit.
 */
export function guardedLookup(policy: UrlPolicy) {
  return (hostname: string, options: any, cb: LookupCb) => {
    dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs: any) => {
      if (err) return cb(err, '', 0);
      const list: { address: string; family: number }[] = Array.isArray(addrs) ? addrs : [{ address: addrs, family: isIP(addrs) }];
      if (!policy.allowPrivateTargets) {
        const bad = list.find((a) => isBlockedIp(a.address));
        if (bad) return cb(Object.assign(new UnsafeUrlError('resolves to a non-public address'), { code: 'EBLOCKED' }) as any, '', 0);
      }
      if (options?.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

export interface SafePostInit { headers: Record<string, string>; body: string; timeoutMs: number; maxResponseBytes?: number }
export interface SafePostResult { status: number }

/**
 * POST with SSRF protections: scheme/host allow-list, DNS-pinned connection, no redirect following
 * (any 3xx is returned as a failure status), a hard timeout and a capped response read.
 */
export function safePost(rawUrl: string, init: SafePostInit, policy: UrlPolicy): Promise<SafePostResult> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = assertSafeWebhookUrl(rawUrl, policy); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'POST',
      headers: { ...init.headers, 'content-length': Buffer.byteLength(init.body) },
      lookup: guardedLookup(policy) as any,
      timeout: init.timeoutMs,
      agent: false, // no connection reuse across merchants
    }, (res) => {
      let seen = 0;
      const cap = init.maxResponseBytes ?? 64 * 1024;
      res.on('data', (c: Buffer) => { seen += c.length; if (seen > cap) res.destroy(); }); // drain, never buffer
      res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      res.on('close', () => resolve({ status: res.statusCode ?? 0 }));
      res.on('error', () => resolve({ status: res.statusCode ?? 0 }));
    });
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), init.timeoutMs);
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
    req.on('error', (e) => { clearTimeout(deadline); reject(e); });
    req.on('close', () => clearTimeout(deadline));
    req.end(init.body);
  });
}

/**
 * Registration-time check: static rules plus a DNS resolution where every address must be public.
 * This is only early feedback; the delivery-time guardedLookup is what actually enforces the policy
 * (DNS answers can change between registration and delivery).
 */
export async function assertSafeWebhookTarget(raw: string, policy: UrlPolicy): Promise<URL> {
  const u = assertSafeWebhookUrl(raw, policy);
  if (policy.allowPrivateTargets) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return u;
  await new Promise<void>((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return reject(new UnsafeUrlError('hostname does not resolve'));
      if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) return reject(new UnsafeUrlError('resolves to a non-public address'));
      resolve();
    });
  });
  return u;
}
