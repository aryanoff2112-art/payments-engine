import { DUMMY_KEY_HASH, verifySecret } from '../src/auth/apiKeys';
import { sha256 } from '../src/util';

describe('verifySecret (constant-time key check)', () => {
  it('accepts the right secret and rejects a wrong one', () => {
    expect(verifySecret('s3cret', sha256('s3cret'))).toBe(true);
    expect(verifySecret('other', sha256('s3cret'))).toBe(false);
  });
  it('rejects when no row exists, and never accepts any secret against the dummy hash', () => {
    expect(verifySecret('anything', undefined)).toBe(false);
    expect(verifySecret('api-key-dummy-hash-for-unknown-ids', undefined)).toBe(false);
  });
  it('the dummy hash has the same 32-byte length as a real SHA-256 hash, so both paths compare equal-length buffers', () => {
    expect(Buffer.from(DUMMY_KEY_HASH, 'hex').length).toBe(32);
    expect(DUMMY_KEY_HASH.length).toBe(sha256('x').length);
  });
});
