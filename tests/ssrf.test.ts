import dns from 'dns';
import http from 'http';
import { isBlockedIp } from '../src/security/ipGuard';
import { UnsafeUrlError, assertSafeWebhookTarget, assertSafeWebhookUrl, safePost } from '../src/security/webhookUrl';

const strict = { allowPrivateTargets: false };
const post = (url: string, policy = strict) => safePost(url, { headers: { 'content-type': 'application/json' }, body: '{}', timeoutMs: 1000 }, policy);

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254',            // AWS/GCP/Azure metadata
    '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',   // IPv4-mapped bypass attempts
    '64:ff9b::7f00:1',                                                                    // NAT64 wrapping loopback
    '2002:7f00:1::1',                                                                     // 6to4 wrapping loopback
    // special-purpose IPv6 beyond the basics
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',   // Teredo (2001::/32)
    '2001::1', '2001:2::1',                    // Teredo prefix / benchmarking
    '2001:10::1', '2001:20::1',                // ORCHID / ORCHIDv2
    '2001:1::1', '2001:3::1', '2001:4:112::1', // PCP anycast, AMT, AS112 (blocked wholesale, fail closed)
    '2001:db8::1',                             // documentation
    '3fff::1', '3fff:0fff::1',                 // documentation (RFC 9637)
    '2002:808:808::1',                         // 6to4 wrapping a PUBLIC v4: still refused
    '2002:7f00:1::1',
    '5f00::1',                                 // SRv6 SIDs
    '64:ff9b:1::1',                            // local-use NAT64
    '100::1',                                  // discard-only
    '::7f00:1',                                // IPv4-compatible loopback
    '1000::1', '4000::1', 'e000::1',           // outside 2000::/3 (unallocated): default-deny
    'fe80::1%eth0', 'fec0::1',
    'not-an-ip', '',                                                                      // fail closed
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001::1', '2620:fe::fe', '2400:cb00::1', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
    'allows public %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('assertSafeWebhookUrl (malicious URLs)', () => {
  it.each([
    ['plain http', 'http://example.com/hook'],
    ['file scheme', 'file:///etc/passwd'],
    ['gopher scheme', 'gopher://example.com:6379/_PING'],
    ['ftp scheme', 'ftp://example.com/x'],
    ['localhost', 'https://localhost/hook'],
    ['localhost subdomain', 'https://evil.localhost/hook'],
    ['trailing-dot localhost', 'https://localhost./hook'],
    ['loopback literal', 'https://127.0.0.1/hook'],
    ['loopback decimal', 'https://2130706433/hook'],
    ['loopback hex', 'https://0x7f000001/hook'],
    ['loopback octal', 'https://0177.0.0.1/hook'],
    ['loopback short form', 'https://127.1/hook'],
    ['IPv6 loopback', 'https://[::1]/hook'],
    ['IPv4-mapped IPv6 loopback', 'https://[::ffff:127.0.0.1]/hook'],
    ['AWS/GCP/Azure metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['GCP metadata hostname', 'https://metadata.google.internal/computeMetadata/v1/'],
    ['RFC1918 10/8', 'https://10.1.2.3/hook'],
    ['RFC1918 192.168/16', 'https://192.168.0.1/hook'],
    ['RFC1918 172.16/12', 'https://172.20.0.1/hook'],
    ['unspecified address', 'https://0.0.0.0/hook'],
    ['.internal hostname', 'https://billing.internal/hook'],
    ['single-label hostname', 'https://intranet/hook'],
    ['embedded credentials', 'https://user:pw@example.com/hook'],
    ['credentials that mimic a host', 'https://example.com@127.0.0.1/hook'],
    ['non-443 port', 'https://example.com:6379/hook'],
    ['garbage', 'not a url'],
  ])('rejects %s', (_n, url) => expect(() => assertSafeWebhookUrl(url, strict)).toThrow(UnsafeUrlError));

  it('accepts a normal public https URL and a public IP literal', () => {
    expect(assertSafeWebhookUrl('https://hooks.example.com/stripe', strict).hostname).toBe('hooks.example.com');
    expect(() => assertSafeWebhookUrl('https://93.184.216.34/hook', strict)).not.toThrow();
  });

  it('the dev escape hatch permits http and loopback but still only http(s)', () => {
    const dev = { allowPrivateTargets: true };
    expect(() => assertSafeWebhookUrl('http://127.0.0.1:8080/x', dev)).not.toThrow();
    expect(() => assertSafeWebhookUrl('file:///etc/passwd', dev)).toThrow(UnsafeUrlError);
  });
});

describe('DNS validation and rebinding', () => {
  afterEach(() => jest.restoreAllMocks());
  const answer = (...addrs: string[]) =>
    jest.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: any, cb: any) =>
      cb(null, addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))) as any);

  it('registration rejects a hostname that resolves to a private address', async () => {
    answer('10.0.0.8');
    await expect(assertSafeWebhookTarget('https://attacker.example.com/h', strict)).rejects.toThrow(/non-public/);
  });

  it('rejects when ANY returned address is private (mixed answers)', async () => {
    answer('93.184.216.34', '127.0.0.1');
    await expect(assertSafeWebhookTarget('https://attacker.example.com/h', strict)).rejects.toThrow(/non-public/);
  });

  it('rejects unresolvable hostnames', async () => {
    jest.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: any, cb: any) => cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }))) as any);
    await expect(assertSafeWebhookTarget('https://nope.example.com/h', strict)).rejects.toThrow(/does not resolve/);
  });

  it('DNS rebinding: public at registration, loopback at delivery -> the connection is refused', async () => {
    let hits = 0;
    const srv = http.createServer((_q, r) => { hits++; r.end('secret'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    // First lookup (registration) is public. Second (delivery) flips to loopback.
    const spy = answer('93.184.216.34');
    await expect(assertSafeWebhookTarget('https://rebind.example.com/h', strict)).resolves.toBeInstanceOf(URL);
    spy.mockRestore();
    answer('127.0.0.1');
    // https and port 443 are enforced, so this fails at the resolver before any socket is opened.
    await expect(post('https://rebind.example.com/h')).rejects.toMatchObject({ code: 'EBLOCKED' });
    expect(hits).toBe(0);
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('a blocked literal is refused without any DNS or network activity', async () => {
    const spy = jest.spyOn(dns, 'lookup');
    await expect(post('https://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('redirects are never followed', () => {
  it('a 302 to an internal address is returned as a failure status and the target is never contacted', async () => {
    let internalHits = 0;
    const internal = http.createServer((_q, r) => { internalHits++; r.end('metadata'); });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
    const iport = (internal.address() as any).port;
    const redirector = http.createServer((_q, r) => { r.statusCode = 302; r.setHeader('location', `http://127.0.0.1:${iport}/secret`); r.end(); });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const rport = (redirector.address() as any).port;

    // allowPrivateTargets only so the local redirector is reachable; redirect handling is policy-independent.
    const res = await post(`http://127.0.0.1:${rport}/hook`, { allowPrivateTargets: true });
    expect(res.status).toBe(302);
    expect(internalHits).toBe(0);
    await Promise.all([internal, redirector].map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  });
});
