import { isIP } from 'net';

/** Parses an IPv4 dotted quad into a 32-bit unsigned integer, or null. */
function v4ToInt(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const x = Number(part);
    if (x > 255) return null;
    n = n * 256 + x;
  }
  return n;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay (deprecated)
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
];

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return true; // unparseable: fail closed
  return V4_BLOCKED.some(([base, bits]) => {
    const b = v4ToInt(base)!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((b & mask) >>> 0);
  });
}

/** Expands an IPv6 literal to 8 16-bit groups, handling "::" and an embedded dotted IPv4 tail. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const tail = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const n = v4ToInt(tail[1]);
    if (n === null) return null;
    s = s.slice(0, -tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const parts = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...rest];
  const out = parts.map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

/** True if the first `bits` bits of groups `g` equal those of `prefix` (both 8x16-bit groups). */
function inPrefix(g: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const take = Math.min(16, bits);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((g[i] & mask) !== (prefix[i] & mask)) return false;
  }
  return true;
}
const P = (...x: number[]) => [...x, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8);

/**
 * IPv6 policy is an ALLOW-LIST: only global unicast 2000::/3 is eligible, minus the special-purpose blocks inside it.
 * Everything outside 2000::/3 (loopback, unspecified, ULA, link-local, multicast, site-local, 100::/64, 5f00::/16,
 * IPv4-compatible, local-use NAT64 64:ff9b:1::/48, ...) is therefore rejected by default, including ranges IANA
 * assigns later. The only exceptions are forms that merely wrap an IPv4 address, which are judged by that IPv4:
 * IPv4-mapped ::ffff:0:0/96 and well-known NAT64 64:ff9b::/96.
 * Inside 2000::/3 these are denied (IANA IPv6 Special-Purpose Address Registry):
 *   2001::/23   IETF protocol assignments: Teredo 2001::/32, benchmarking 2001:2::/48, ORCHID(v2), AMT, AS112, ...
 *               (blocked wholesale, fail closed; none are legitimate webhook hosts)
 *   2001:db8::/32 documentation      3fff::/20 documentation (RFC 9637)
 *   2002::/16   6to4 (deprecated; embeds an arbitrary IPv4, so never trust it)
 */
function v6Blocked(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true; // fail closed
  const embedded = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (inPrefix(g, P(0, 0, 0, 0, 0, 0xffff), 96)) return v4Blocked(embedded);   // IPv4-mapped
  if (inPrefix(g, P(0x64, 0xff9b), 96)) return v4Blocked(embedded);              // well-known NAT64
  if (!inPrefix(g, P(0x2000), 3)) return true;                                   // not global unicast
  if (inPrefix(g, P(0x2001, 0), 23)) return true;                                // IETF assignments incl. Teredo
  if (inPrefix(g, P(0x2001, 0x0db8), 32)) return true;                           // documentation
  if (inPrefix(g, P(0x2002), 16)) return true;                                   // 6to4
  if (inPrefix(g, P(0x3fff), 20)) return true;                                   // documentation (RFC 9637)
  return false;
}

/** True when the address must never be contacted by a webhook delivery. Unparseable input is blocked. */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip.replace(/^\[|\]$/g, ''));
  const bare = ip.replace(/^\[|\]$/g, '');
  if (v === 4) return v4Blocked(bare);
  if (v === 6) return v6Blocked(bare);
  return true;
}
