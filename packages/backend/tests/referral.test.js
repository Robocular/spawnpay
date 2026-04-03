import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createDb, closeDb } from '../src/db.js';
import { buildReferralChain, calculateCommissions, creditReferrals, validateReferralCode, getReferralStats } from '../src/referral.js';

describe('Referral', () => {
  let db;
  before(() => {
    db = createDb(':memory:');
    // Create chain: Z -> A -> B -> C
    db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code, balance) VALUES (?,?,?,?,?,?)').run('sp_z', 'spk_z', '0xZ', 'enc:z', 'SP_Z', 10);
    db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code, referred_by, referral_chain, balance) VALUES (?,?,?,?,?,?,?,?)').run('sp_a', 'spk_a', '0xA', 'enc:a', 'SP_A', 'SP_Z', '["sp_z"]', 10);
    db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code, referred_by, referral_chain, balance) VALUES (?,?,?,?,?,?,?,?)').run('sp_b', 'spk_b', '0xB', 'enc:b', 'SP_B', 'SP_A', '["sp_a","sp_z"]', 10);
    db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code, referred_by, referral_chain, balance) VALUES (?,?,?,?,?,?,?,?)').run('sp_c', 'spk_c', '0xC', 'enc:c', 'SP_C', 'SP_B', '["sp_b","sp_a","sp_z"]', 10);
  });
  after(() => closeDb(db));

  it('builds referral chain from code', () => {
    const chain = buildReferralChain(db, 'SP_B');
    assert.deepStrictEqual(chain, ['sp_b', 'sp_a', 'sp_z']);
  });

  it('returns empty chain for unknown code', () => {
    const chain = buildReferralChain(db, 'SP_FAKE');
    assert.deepStrictEqual(chain, []);
  });

  it('limits chain to 3 levels', () => {
    const chain = buildReferralChain(db, 'SP_C');
    assert.strictEqual(chain.length, 3);
  });

  it('calculates commissions correctly', () => {
    const fee = 0.50;
    const commissions = calculateCommissions(fee, ['sp_b', 'sp_a', 'sp_z']);
    assert.strictEqual(commissions.length, 3);
    assert.strictEqual(commissions[0].amount, 0.075);   // 15%
    assert.strictEqual(commissions[0].level, 1);
    assert.strictEqual(commissions[1].amount, 0.025);    // 5%
    assert.strictEqual(commissions[2].amount, 0.01);     // 2%
  });

  it('handles partial chain (1 level)', () => {
    const commissions = calculateCommissions(0.50, ['sp_a']);
    assert.strictEqual(commissions.length, 1);
    assert.strictEqual(commissions[0].amount, 0.075);
  });

  it('handles zero fee', () => {
    const commissions = calculateCommissions(0, ['sp_a', 'sp_b']);
    assert.strictEqual(commissions.length, 0);
  });

  it('credits referrals atomically', () => {
    const tx = db.prepare("INSERT INTO transactions (agent_id, type, amount) VALUES ('sp_c', 'send', 100) RETURNING id").get();
    const before_b = db.prepare('SELECT balance, referral_earned FROM agents WHERE id = ?').get('sp_b');
    creditReferrals(db, tx.id, [
      { agentId: 'sp_b', level: 1, amount: 0.075 },
      { agentId: 'sp_a', level: 2, amount: 0.025 },
    ]);
    const after_b = db.prepare('SELECT balance, referral_earned FROM agents WHERE id = ?').get('sp_b');
    assert.strictEqual(after_b.balance, before_b.balance + 0.075);
    assert.strictEqual(after_b.referral_earned, before_b.referral_earned + 0.075);
    const payouts = db.prepare('SELECT * FROM referral_payouts WHERE tx_id = ?').all(tx.id);
    assert.strictEqual(payouts.length, 2);
  });

  it('rejects self-referral', () => {
    assert.strictEqual(validateReferralCode(db, 'SP_C', 'sp_c').valid, false);
  });

  it('rejects non-existent code', () => {
    assert.strictEqual(validateReferralCode(db, 'SP_FAKE', 'sp_new').valid, false);
  });

  it('rejects null code', () => {
    assert.strictEqual(validateReferralCode(db, null, 'sp_new').valid, false);
  });

  it('accepts valid referral code', () => {
    const result = validateReferralCode(db, 'SP_B', 'sp_new');
    assert.strictEqual(result.valid, true);
    assert.ok(result.referrer);
  });

  it('gets referral stats', () => {
    const stats = getReferralStats(db, 'sp_z');
    assert.strictEqual(stats.referralCode, 'SP_Z');
    assert.strictEqual(stats.directReferrals, 1); // sp_a
  });
});
