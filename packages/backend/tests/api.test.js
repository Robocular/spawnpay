import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/server.js';

const HMAC_SECRET = 'test-hmac-secret';
const MASTER_SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const mockChain = {
  sendUSDC: async () => ({ txHash: '0xmockhash123', status: 'confirmed' }),
  sendETH: async () => ({ txHash: '0xmockhash456', status: 'confirmed' }),
};

function sign(method, body) {
  const timestamp = String(Date.now());
  const raw = method === 'GET' ? '' : JSON.stringify(body);
  const signature = crypto.createHmac('sha256', HMAC_SECRET).update(timestamp + raw).digest('hex');
  return { timestamp, signature };
}

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const bodyStr = body ? JSON.stringify(body) : null;
    const { timestamp, signature } = sign(method, body);
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-timestamp': timestamp,
        'x-signature': signature,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('API Server', () => {
  let app, server;

  before((_, done) => {
    app = createApp({ hmacSecret: HMAC_SECRET, masterSeed: MASTER_SEED, dbPath: ':memory:', chain: mockChain });
    server = app.listen(0, done);
  });

  after((_, done) => {
    app.closeDb();
    server.close(done);
  });

  describe('HMAC Auth', () => {
    it('rejects requests without signature', async () => {
      const addr = server.address();
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: '/balance?apiKey=x', method: 'GET' }, (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(res.status, 401);
    });

    it('rejects invalid signature', async () => {
      const addr = server.address();
      const timestamp = String(Date.now());
      const res = await new Promise((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1', port: addr.port, path: '/balance?apiKey=x', method: 'GET',
          headers: { 'x-timestamp': timestamp, 'x-signature': 'deadbeef'.repeat(8) },
        }, (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(res.status, 401);
    });
  });

  describe('POST /signup', () => {
    it('creates agent with wallet address', async () => {
      const res = await request(server, 'POST', '/signup', {});
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.apiKey.startsWith('spk_live_'));
      assert.ok(res.body.agentId.startsWith('sp_'));
      assert.ok(res.body.walletAddress.startsWith('0x'));
      assert.ok(res.body.referralCode.startsWith('SP_'));
    });

    it('creates agent with referral code', async () => {
      const r1 = await request(server, 'POST', '/signup', {});
      assert.strictEqual(r1.status, 200);
      const r2 = await request(server, 'POST', '/signup', { referralCode: r1.body.referralCode });
      assert.strictEqual(r2.status, 200);
      assert.ok(r2.body.apiKey);
    });

    it('rejects invalid referral code', async () => {
      const res = await request(server, 'POST', '/signup', { referralCode: 'SP_INVALID' });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('Invalid referral code'));
    });
  });

  describe('GET /balance', () => {
    it('returns 0 for new agent', async () => {
      const signup = await request(server, 'POST', '/signup', {});
      const res = await request(server, 'GET', `/balance?apiKey=${signup.body.apiKey}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.balance, 0);
      assert.strictEqual(res.body.network, 'base');
      assert.ok(res.body.address.startsWith('0x'));
    });

    it('returns 404 for unknown apiKey', async () => {
      const res = await request(server, 'GET', '/balance?apiKey=spk_live_doesnotexist');
      assert.strictEqual(res.status, 404);
    });
  });

  describe('GET /address', () => {
    it('returns wallet address and chain info', async () => {
      const signup = await request(server, 'POST', '/signup', {});
      const res = await request(server, 'GET', `/address?apiKey=${signup.body.apiKey}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.network, 'base');
      assert.strictEqual(res.body.chainId, 8453);
      assert.ok(res.body.address.startsWith('0x'));
    });
  });

  describe('POST /faucet', () => {
    it('rejects if no referral', async () => {
      const signup = await request(server, 'POST', '/signup', {});
      const res = await request(server, 'POST', '/faucet', { apiKey: signup.body.apiKey });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('Referral required'));
    });

    it('credits $1 for eligible agent', async () => {
      const referrer = await request(server, 'POST', '/signup', {});
      const db = app._db;
      const referrerRow = db.prepare('SELECT id FROM agents WHERE api_key = ?').get(referrer.body.apiKey);
      db.prepare("INSERT INTO transactions (agent_id, type, amount, currency, status) VALUES (?, 'send', 10, 'USDC', 'confirmed')").run(referrerRow.id);

      const agent = await request(server, 'POST', '/signup', { referralCode: referrer.body.referralCode });
      assert.strictEqual(agent.status, 200);

      const res = await request(server, 'POST', '/faucet', { apiKey: agent.body.apiKey });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.amount, 1);
      assert.strictEqual(res.body.currency, 'USDC');

      const bal = await request(server, 'GET', `/balance?apiKey=${agent.body.apiKey}`);
      assert.strictEqual(bal.body.balance, 1);
    });

    it('rejects double claim', async () => {
      const referrer = await request(server, 'POST', '/signup', {});
      const db = app._db;
      const referrerRow = db.prepare('SELECT id FROM agents WHERE api_key = ?').get(referrer.body.apiKey);
      db.prepare("INSERT INTO transactions (agent_id, type, amount, currency, status) VALUES (?, 'send', 10, 'USDC', 'confirmed')").run(referrerRow.id);

      const agent = await request(server, 'POST', '/signup', { referralCode: referrer.body.referralCode });
      await request(server, 'POST', '/faucet', { apiKey: agent.body.apiKey });
      const res = await request(server, 'POST', '/faucet', { apiKey: agent.body.apiKey });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('already claimed'));
    });
  });

  describe('POST /key/rotate', () => {
    it('returns new key and invalidates old', async () => {
      const signup = await request(server, 'POST', '/signup', {});
      const oldKey = signup.body.apiKey;
      const res = await request(server, 'POST', '/key/rotate', { apiKey: oldKey });
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.apiKey.startsWith('spk_live_'));
      assert.notStrictEqual(res.body.apiKey, oldKey);
      assert.strictEqual(res.body.previousKeyInvalidated, true);

      const bal = await request(server, 'GET', `/balance?apiKey=${oldKey}`);
      assert.strictEqual(bal.status, 404);

      const bal2 = await request(server, 'GET', `/balance?apiKey=${res.body.apiKey}`);
      assert.strictEqual(bal2.status, 200);
    });
  });

  describe('GET /referral/stats', () => {
    it('returns correct referral counts', async () => {
      const referrer = await request(server, 'POST', '/signup', {});
      await request(server, 'POST', '/signup', { referralCode: referrer.body.referralCode });
      await request(server, 'POST', '/signup', { referralCode: referrer.body.referralCode });

      const res = await request(server, 'GET', `/referral/stats?apiKey=${referrer.body.apiKey}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.directReferrals, 2);
      assert.strictEqual(res.body.totalEarned, 0);
      assert.ok(res.body.sharePrompt);
      assert.ok(res.body.referralCode);
    });
  });

  describe('GET /referral/code', () => {
    it('returns code and url', async () => {
      const signup = await request(server, 'POST', '/signup', {});
      const res = await request(server, 'GET', `/referral/code?apiKey=${signup.body.apiKey}`);
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.code.startsWith('SP_'));
      assert.ok(res.body.url.includes(res.body.code));
    });
  });

  describe('POST /send', () => {
    it('rejects with insufficient balance', async () => {
      const signup = await request(server, 'POST', '/signup', {});
      const res = await request(server, 'POST', '/send', { apiKey: signup.body.apiKey, to: '0xdead', amount: 10 });
      assert.strictEqual(res.status, 400);
      assert.ok(res.body.error.includes('Insufficient balance'));
    });

    it('sends with sufficient balance', async () => {
      const signup = await request(server, 'POST', '/signup', {});
      const db = app._db;
      db.prepare('UPDATE agents SET balance = 100 WHERE api_key = ?').run(signup.body.apiKey);

      const res = await request(server, 'POST', '/send', { apiKey: signup.body.apiKey, to: '0xdead', amount: 10, currency: 'USDC' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.txHash, '0xmockhash123');
      assert.ok(res.body.fee > 0);
    });
  });

  describe('GET /tx/:hash', () => {
    it('returns 404 for unknown hash', async () => {
      const res = await request(server, 'GET', '/tx/0xunknown');
      assert.strictEqual(res.status, 404);
    });
  });
});
