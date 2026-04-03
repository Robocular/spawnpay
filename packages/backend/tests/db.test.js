import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createDb, closeDb } from '../src/db.js';

describe('Database', () => {
  let db;
  before(() => { db = createDb(':memory:'); });
  after(() => { closeDb(db); });

  it('creates agents table', () => {
    const info = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'").get();
    assert.strictEqual(info.name, 'agents');
  });

  it('creates transactions table', () => {
    const info = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'").get();
    assert.strictEqual(info.name, 'transactions');
  });

  it('creates referral_payouts table', () => {
    const info = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='referral_payouts'").get();
    assert.strictEqual(info.name, 'referral_payouts');
  });

  it('inserts and retrieves an agent', () => {
    const agent = db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code) VALUES (?, ?, ?, ?, ?) RETURNING *').get('sp_test1', 'spk_live_test', '0xabc', 'enc:xxx', 'SP_test1');
    assert.strictEqual(agent.id, 'sp_test1');
    assert.strictEqual(agent.balance, 0);
    assert.strictEqual(agent.faucet_claimed, 0);
  });

  it('enforces unique api_key', () => {
    assert.throws(() => {
      db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code) VALUES (?, ?, ?, ?, ?)').run('sp_test2', 'spk_live_test', '0xdef', 'enc:yyy', 'SP_test2');
    });
  });

  it('enforces unique referral_code', () => {
    assert.throws(() => {
      db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code) VALUES (?, ?, ?, ?, ?)').run('sp_test3', 'spk_live_test3', '0xghi', 'enc:zzz', 'SP_test1');
    });
  });

  it('inserts transaction with valid type', () => {
    const tx = db.prepare("INSERT INTO transactions (agent_id, type, amount) VALUES ('sp_test1', 'send', 5.0) RETURNING *").get();
    assert.strictEqual(tx.type, 'send');
    assert.strictEqual(tx.status, 'pending');
  });

  it('rejects transaction with invalid type', () => {
    assert.throws(() => {
      db.prepare("INSERT INTO transactions (agent_id, type, amount) VALUES ('sp_test1', 'invalid', 1.0)").run();
    });
  });
});
