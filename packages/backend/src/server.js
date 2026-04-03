import express from 'express';
import crypto from 'node:crypto';
import { createDb, closeDb } from './db.js';
import { deriveWallet, encryptKey, decryptKey, generateApiKey, generateReferralCode, generateAgentId } from './wallet.js';
import { buildReferralChain, calculateCommissions, creditReferrals, validateReferralCode, getReferralStats } from './referral.js';
import * as chainModule from './chain.js';
import { verifyHmac } from './auth.js';

const PLATFORM_FEE_RATE = 0.005;

export function createApp(config) {
  const { hmacSecret, masterSeed, dbPath = ':memory:', rpcUrl = 'https://mainnet.base.org', chain = chainModule } = config;
  const db = createDb(dbPath);
  const app = express();

  app.use(express.json());

  // HMAC auth middleware
  app.use((req, res, next) => {
    const timestamp = req.headers['x-timestamp'];
    const signature = req.headers['x-signature'];
    const body = req.method === 'GET' ? '' : JSON.stringify(req.body);
    if (!verifyHmac(timestamp, signature, body, hmacSecret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // helper: look up agent by apiKey
  function getAgent(apiKey) {
    if (!apiKey) return null;
    return db.prepare('SELECT * FROM agents WHERE api_key = ?').get(apiKey);
  }

  // helper: reset daily spend if needed
  function checkDailyReset(agent) {
    const today = new Date().toISOString().slice(0, 10);
    if (agent.daily_reset !== today) {
      db.prepare('UPDATE agents SET daily_spent = 0, daily_reset = ? WHERE id = ?').run(today, agent.id);
      agent.daily_spent = 0;
      agent.daily_reset = today;
    }
  }

  // POST /signup
  app.post('/signup', (req, res) => {
    try {
      const { referralCode } = req.body || {};
      const agentId = generateAgentId();
      const apiKey = generateApiKey();
      const refCode = generateReferralCode();

      const count = db.prepare('SELECT COUNT(*) as cnt FROM agents').get().cnt;
      const { address, privateKey } = deriveWallet(masterSeed, count);
      const encKey = encryptKey(privateKey, masterSeed, agentId);

      let referredBy = null;
      let chain = [];

      if (referralCode) {
        const validation = validateReferralCode(db, referralCode, agentId);
        if (!validation.valid) {
          return res.status(400).json({ error: `Invalid referral code: ${validation.reason}` });
        }
        referredBy = referralCode;
        chain = buildReferralChain(db, referralCode);
      }

      db.prepare(
        'INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code, referred_by, referral_chain) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(agentId, apiKey, address, encKey, refCode, referredBy, JSON.stringify(chain));

      res.json({ apiKey, agentId, walletAddress: address, referralCode: refCode });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /balance
  app.get('/balance', (req, res) => {
    const agent = getAgent(req.query.apiKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json({ address: agent.wallet_address, balance: agent.balance, network: 'base' });
  });

  // GET /address
  app.get('/address', (req, res) => {
    const agent = getAgent(req.query.apiKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json({ address: agent.wallet_address, network: 'base', chainId: 8453 });
  });

  // POST /send
  app.post('/send', async (req, res) => {
    try {
      const { apiKey, to, amount, currency = 'USDC', idempotencyKey } = req.body || {};
      const agent = getAgent(apiKey);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // idempotency check
      if (idempotencyKey) {
        const existing = db.prepare('SELECT tx_hash, status FROM transactions WHERE idempotency_key = ?').get(idempotencyKey);
        if (existing) return res.json({ txHash: existing.tx_hash, status: existing.status, deduplicated: true });
      }

      // daily limit
      checkDailyReset(agent);
      const total = parseFloat(amount);
      if (agent.daily_spent + total > agent.daily_limit) {
        return res.status(400).json({ error: 'Daily spending limit exceeded' });
      }

      // balance check
      const fee = Math.floor(total * PLATFORM_FEE_RATE * 1e6) / 1e6;
      const debit = total + fee;
      if (agent.balance < debit) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      // deduct balance
      db.prepare('UPDATE agents SET balance = balance - ?, daily_spent = daily_spent + ? WHERE id = ?').run(debit, total, agent.id);

      // referral commissions
      const refChain = JSON.parse(agent.referral_chain || '[]');
      const commissions = calculateCommissions(fee, refChain);

      // record transaction
      const txRow = db.prepare(
        'INSERT INTO transactions (agent_id, type, amount, currency, to_address, from_address, idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(agent.id, 'send', total, currency, to, agent.wallet_address, idempotencyKey || null, 'pending');

      // credit referrals
      let referralPaid = 0;
      if (commissions.length > 0) {
        creditReferrals(db, txRow.id, commissions);
        referralPaid = commissions.reduce((s, c) => s + c.amount, 0);
      }

      // on-chain transfer
      const pk = decryptKey(agent.encrypted_key, masterSeed, agent.id);
      let result;
      try {
        if (currency === 'ETH') {
          result = await chain.sendETH(pk, to, String(total), rpcUrl);
        } else {
          result = await chain.sendUSDC(pk, to, String(total), rpcUrl);
        }
        db.prepare('UPDATE transactions SET tx_hash = ?, status = ? WHERE id = ?').run(result.txHash, result.status, txRow.id);
      } catch (chainErr) {
        // rollback balance on chain failure
        db.prepare('UPDATE agents SET balance = balance + ?, daily_spent = daily_spent - ? WHERE id = ?').run(debit, total, agent.id);
        db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('failed', txRow.id);
        return res.status(500).json({ error: 'On-chain transfer failed', detail: chainErr.message });
      }

      res.json({ txHash: result.txHash, fee, referralPaid });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /faucet
  app.post('/faucet', (req, res) => {
    try {
      const { apiKey } = req.body || {};
      const agent = getAgent(apiKey);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      if (agent.faucet_claimed) {
        return res.status(400).json({ error: 'Faucet already claimed' });
      }

      // must have a referrer who has at least 1 transaction
      if (!agent.referred_by) {
        return res.status(400).json({ error: 'Referral required to claim faucet' });
      }
      const referrer = db.prepare('SELECT id FROM agents WHERE referral_code = ?').get(agent.referred_by);
      if (referrer) {
        const txCount = db.prepare('SELECT COUNT(*) as cnt FROM transactions WHERE agent_id = ? AND type = ?').get(referrer.id, 'send').cnt;
        if (txCount < 1) {
          return res.status(400).json({ error: 'Referrer must have at least 1 transaction' });
        }
      } else {
        return res.status(400).json({ error: 'Referral required to claim faucet' });
      }

      db.prepare('UPDATE agents SET balance = balance + 1, faucet_claimed = 1 WHERE id = ?').run(agent.id);
      db.prepare("INSERT INTO transactions (agent_id, type, amount, currency, status) VALUES (?, 'faucet', 1, 'USDC', 'confirmed')").run(agent.id);

      res.json({ amount: 1, currency: 'USDC' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /referral/stats
  app.get('/referral/stats', (req, res) => {
    const agent = getAgent(req.query.apiKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const stats = getReferralStats(db, agent.id);
    if (!stats) return res.status(404).json({ error: 'Stats not found' });
    stats.sharePrompt = `Share your referral code ${stats.referralCode} with other agents. When they sign up and transact, you earn commissions on every transaction in your 3-level network.`;
    res.json(stats);
  });

  // GET /referral/code
  app.get('/referral/code', (req, res) => {
    const agent = getAgent(req.query.apiKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json({ code: agent.referral_code, url: `https://spawnpay.com/r/${agent.referral_code}` });
  });

  // POST /key/rotate
  app.post('/key/rotate', (req, res) => {
    try {
      const { apiKey } = req.body || {};
      const agent = getAgent(apiKey);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      const newKey = generateApiKey();
      db.prepare('UPDATE agents SET api_key = ? WHERE id = ?').run(newKey, agent.id);
      res.json({ apiKey: newKey, previousKeyInvalidated: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tx/:hash
  app.get('/tx/:hash', (req, res) => {
    const tx = db.prepare('SELECT tx_hash, status, amount, to_address, created_at FROM transactions WHERE tx_hash = ?').get(req.params.hash);
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ txHash: tx.tx_hash, status: tx.status, amount: tx.amount, to: tx.to_address, timestamp: tx.created_at });
  });

  // attach db for cleanup
  app._db = db;
  app.closeDb = () => closeDb(db);

  return app;
}

// standalone run
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 3001;
  const app = createApp({
    hmacSecret: process.env.HMAC_SECRET || 'dev-secret',
    masterSeed: process.env.MASTER_SEED,
    dbPath: process.env.DB_PATH || './spawnpay.db',
    rpcUrl: process.env.RPC_URL || 'https://mainnet.base.org',
  });
  app.listen(port, () => console.log(`SpawnPay VPS backend on :${port}`));
}
