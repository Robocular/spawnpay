import { describe, it } from 'node:test';
import assert from 'node:assert';
import { deriveWallet, encryptKey, decryptKey, generateApiKey, generateReferralCode, generateAgentId } from '../src/wallet.js';

const TEST_SEED = 'test test test test test test test test test test test junk';

describe('Wallet', () => {
  it('derives deterministic wallet from seed + index', () => {
    const w1 = deriveWallet(TEST_SEED, 0);
    const w2 = deriveWallet(TEST_SEED, 0);
    assert.strictEqual(w1.address, w2.address);
    assert.strictEqual(w1.privateKey, w2.privateKey);
    assert.ok(w1.address.startsWith('0x'));
    assert.strictEqual(w1.address.length, 42);
  });

  it('derives different wallets for different indices', () => {
    const w1 = deriveWallet(TEST_SEED, 0);
    const w2 = deriveWallet(TEST_SEED, 1);
    assert.notStrictEqual(w1.address, w2.address);
    assert.notStrictEqual(w1.privateKey, w2.privateKey);
  });

  it('encrypts and decrypts private key roundtrip', () => {
    const w = deriveWallet(TEST_SEED, 0);
    const masterKey = 'master-secret-key-for-testing-32b';
    const agentId = 'sp_test1';
    const encrypted = encryptKey(w.privateKey, masterKey, agentId);
    assert.ok(encrypted.startsWith('aes256:'));
    const parts = encrypted.split(':');
    assert.strictEqual(parts.length, 4); // prefix:iv:tag:data
    const decrypted = decryptKey(encrypted, masterKey, agentId);
    assert.strictEqual(decrypted, w.privateKey);
  });

  it('fails decryption with wrong master key', () => {
    const w = deriveWallet(TEST_SEED, 0);
    const encrypted = encryptKey(w.privateKey, 'correct-key', 'sp_test');
    assert.throws(() => decryptKey(encrypted, 'wrong-key', 'sp_test'));
  });

  it('fails decryption with wrong agent ID', () => {
    const w = deriveWallet(TEST_SEED, 0);
    const encrypted = encryptKey(w.privateKey, 'test-key', 'sp_correct');
    assert.throws(() => decryptKey(encrypted, 'test-key', 'sp_wrong'));
  });

  it('generates unique API keys with correct prefix', () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    assert.ok(k1.startsWith('spk_live_'));
    assert.ok(k2.startsWith('spk_live_'));
    assert.notStrictEqual(k1, k2);
    assert.ok(k1.length > 20);
  });

  it('generates unique referral codes with correct prefix', () => {
    const c1 = generateReferralCode();
    const c2 = generateReferralCode();
    assert.ok(c1.startsWith('SP_'));
    assert.ok(c2.startsWith('SP_'));
    assert.notStrictEqual(c1, c2);
  });

  it('generates unique agent IDs with correct prefix', () => {
    const id1 = generateAgentId();
    const id2 = generateAgentId();
    assert.ok(id1.startsWith('sp_'));
    assert.ok(id2.startsWith('sp_'));
    assert.notStrictEqual(id1, id2);
  });
});
