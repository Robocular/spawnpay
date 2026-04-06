import express from 'express';
import crypto from 'node:crypto';
import { createDb, closeDb, getNextWalletIndex } from './db.js';
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

  // Signup rate limit: 1 per IP per hour
  const signupLimiter = new Map();
  function checkSignupRate(req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = signupLimiter.get(ip);
    if (entry && now - entry < 3600000) return false;
    signupLimiter.set(ip, now);
    return true;
  }
  setInterval(() => {
    const cutoff = Date.now() - 3600000;
    for (const [ip, ts] of signupLimiter) {
      if (ts < cutoff) signupLimiter.delete(ip);
    }
  }, 1800000).unref?.();

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

  const SIGNUP_BONUS = 5;
  const REFERRAL_BONUS = 2;
  const MAX_TOTAL_BONUS = 10000;

  // POST /signup
  app.post('/signup', (req, res) => {
    try {
      if (!checkSignupRate(req)) {
        return res.status(429).json({ error: 'Signup rate limit: 1 per hour per IP' });
      }

      const { referralCode, source } = req.body || {};
      const agentId = generateAgentId();
      const apiKey = generateApiKey();
      const refCode = generateReferralCode();

      const walletIndex = getNextWalletIndex(db);
      const { address, privateKey } = deriveWallet(masterSeed, walletIndex);
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

      const totalBonusOutstanding = db.prepare('SELECT COALESCE(SUM(credit_balance), 0) as total FROM agents').get().total;
      let bonus = 0;
      if (totalBonusOutstanding < MAX_TOTAL_BONUS) {
        bonus = SIGNUP_BONUS + (referredBy ? REFERRAL_BONUS : 0);
      }

      const unlockTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

      db.prepare(
        `INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code, referred_by, referral_chain, balance, credit_balance, funded_balance, bonus_unlocks_at, signup_bonus_claimed, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?)`
      ).run(agentId, apiKey, address, encKey, refCode, referredBy, JSON.stringify(chain), bonus, bonus, unlockTime, source || null);

      if (bonus > 0) {
        db.prepare(
          "INSERT INTO transactions (agent_id, type, amount, currency, status) VALUES (?, 'signup_bonus', ?, 'USDC', 'confirmed')"
        ).run(agentId, bonus);
      }

      res.json({
        apiKey, agentId, walletAddress: address, referralCode: refCode,
        creditBalance: bonus, bonusUnlocksAt: unlockTime,
        message: bonus > 0
          ? `Welcome! You received $${bonus} USDC credit. You can send it to other agents after ${unlockTime} UTC.`
          : 'Welcome! Sign up bonus cap reached — deposit USDC to start transacting.',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /balance
  app.get('/balance', (req, res) => {
    const agent = getAgent(req.query.apiKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const creditLocked = agent.bonus_unlocks_at && now < agent.bonus_unlocks_at;
    res.json({
      address: agent.wallet_address,
      creditBalance: agent.credit_balance,
      fundedBalance: agent.funded_balance,
      totalBalance: agent.credit_balance + agent.funded_balance,
      creditLocked,
      bonusUnlocksAt: agent.bonus_unlocks_at || null,
      network: 'base',
    });
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

      if (idempotencyKey) {
        const existing = db.prepare('SELECT tx_hash, status FROM transactions WHERE idempotency_key = ?').get(idempotencyKey);
        if (existing) return res.json({ txHash: existing.tx_hash, status: existing.status, deduplicated: true });
      }

      checkDailyReset(agent);
      const total = parseFloat(amount);
      if (isNaN(total) || total <= 0) return res.status(400).json({ error: 'Invalid amount' });
      if (agent.daily_spent + total > agent.daily_limit) {
        return res.status(400).json({ error: 'Daily spending limit exceeded' });
      }

      const fee = Math.floor(total * PLATFORM_FEE_RATE * 1e6) / 1e6;
      const debit = total + fee;
      const totalBalance = agent.credit_balance + agent.funded_balance;
      if (totalBalance < debit) {
        return res.status(400).json({ error: 'Insufficient balance' });
      }

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const creditAvailable = (!agent.bonus_unlocks_at || now >= agent.bonus_unlocks_at) ? agent.credit_balance : 0;
      const availableBalance = agent.funded_balance + creditAvailable;
      if (availableBalance < debit) {
        return res.status(400).json({ error: `Credit locked until ${agent.bonus_unlocks_at} UTC. Available: $${availableBalance.toFixed(2)}` });
      }

      const recipient = db.prepare('SELECT id, wallet_address FROM agents WHERE wallet_address = ?').get(to);

      const fromFunded = Math.min(agent.funded_balance, debit);
      const fromCredit = debit - fromFunded;

      const updated = db.prepare(
        'UPDATE agents SET funded_balance = funded_balance - ?, credit_balance = credit_balance - ?, daily_spent = daily_spent + ? WHERE id = ? AND funded_balance >= ? AND credit_balance >= ?'
      ).run(fromFunded, fromCredit, total, agent.id, fromFunded, fromCredit);
      if (updated.changes === 0) {
        return res.status(400).json({ error: 'Balance deduction failed (concurrent modification)' });
      }

      const refChain = JSON.parse(agent.referral_chain || '[]');
      const commissions = calculateCommissions(fee, refChain);
      const isCommissionFunded = fromFunded >= debit;

      const txResult = db.prepare(
        'INSERT INTO transactions (agent_id, type, amount, currency, to_address, from_address, idempotency_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(agent.id, 'send', total, currency, to, agent.wallet_address, idempotencyKey || null, recipient ? 'confirmed' : 'pending');
      const txId = txResult.lastInsertRowid;

      let referralPaid = 0;
      if (commissions.length > 0) {
        for (const c of commissions) {
          const col = isCommissionFunded ? 'funded_balance' : 'credit_balance';
          db.prepare(`UPDATE agents SET ${col} = ${col} + ?, referral_earned = referral_earned + ? WHERE id = ?`).run(c.amount, c.amount, c.agentId);
          db.prepare('INSERT INTO referral_payouts (tx_id, referrer_id, level, amount) VALUES (?, ?, ?, ?)').run(txId, c.agentId, c.level, c.amount);
        }
        referralPaid = commissions.reduce((s, c) => s + c.amount, 0);
      }

      if (recipient) {
        db.prepare('UPDATE agents SET funded_balance = funded_balance + ? WHERE id = ?').run(total, recipient.id);
        db.prepare(
          "INSERT INTO transactions (agent_id, type, amount, currency, from_address, to_address, status) VALUES (?, 'receive', ?, ?, ?, ?, 'confirmed')"
        ).run(recipient.id, total, currency, agent.wallet_address, recipient.wallet_address);
        return res.json({ txHash: null, internal: true, fee, referralPaid, message: `Sent $${total} to internal agent` });
      }

      if (fromCredit > 0) {
        db.prepare('UPDATE agents SET funded_balance = funded_balance + ?, credit_balance = credit_balance + ?, daily_spent = daily_spent - ? WHERE id = ?').run(fromFunded, fromCredit, total, agent.id);
        db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('failed', txId);
        return res.status(400).json({ error: 'External transfers require funded balance (from deposits). Credit balance can only be sent to other Spawnpay agents.' });
      }

      const pk = decryptKey(agent.encrypted_key, masterSeed, agent.id);
      try {
        let result;
        if (currency === 'ETH') {
          result = await chain.sendETH(pk, to, String(total), rpcUrl);
        } else {
          result = await chain.sendUSDC(pk, to, String(total), rpcUrl);
        }
        db.prepare('UPDATE transactions SET tx_hash = ?, status = ? WHERE id = ?').run(result.txHash, result.status, txId);
        res.json({ txHash: result.txHash, fee, referralPaid });
      } catch (chainErr) {
        db.prepare('UPDATE agents SET funded_balance = funded_balance + ?, daily_spent = daily_spent - ? WHERE id = ?').run(debit, total, agent.id);
        db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('failed', txId);
        res.status(500).json({ error: 'On-chain transfer failed', detail: chainErr.message });
      }
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
    res.json({ code: agent.referral_code, url: `https://spawnpay.ai/r/${agent.referral_code}` });
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

  // GET /deposits — agent's deposit history
  app.get('/deposits', (req, res) => {
    const agent = getAgent(req.query.apiKey);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const deposits = db.prepare(
      "SELECT amount, currency, from_address, tx_hash, status, created_at FROM transactions WHERE agent_id = ? AND type = 'receive' ORDER BY created_at DESC LIMIT 50"
    ).all(agent.id);
    res.json({ deposits });
  });

  // GET /stats (no auth — public growth dashboard)
  app.get('/stats', (req, res) => {
    const agents = db.prepare('SELECT COUNT(*) as count FROM agents').get();
    const txCount = db.prepare('SELECT COUNT(*) as count FROM transactions').get();
    const totalVolume = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='send'").get();
    const totalFees = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM referral_payouts").get();
    const maxDepth = db.prepare("SELECT MAX(json_array_length(referral_chain)) as depth FROM agents").get();
    const internalTxCount = db.prepare("SELECT COUNT(*) as count FROM transactions WHERE type='send' AND tx_hash IS NULL AND status='confirmed'").get();
    const totalCreditOutstanding = db.prepare('SELECT COALESCE(SUM(credit_balance), 0) as total FROM agents').get();
    const recentAgents = db.prepare('SELECT id, referral_code, referred_by, source, created_at FROM agents ORDER BY created_at DESC LIMIT 10').all();
    res.json({
      totalAgents: agents.count,
      totalTransactions: txCount.count,
      internalTransactions: internalTxCount.count,
      totalVolume: totalVolume.total,
      referralPayouts: totalFees.total,
      maxReferralDepth: maxDepth.depth || 0,
      totalCreditOutstanding: totalCreditOutstanding.total,
      recentSignups: recentAgents.map(a => ({
        id: a.id,
        referralCode: a.referral_code,
        referredBy: a.referred_by || null,
        source: a.source || null,
        joinedAt: a.created_at,
      })),
    });
  });

  // attach db for cleanup
  app._db = db;
  app.closeDb = () => closeDb(db);

  return app;
}

// standalone run
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 3001;
  const dbPath = process.env.DB_PATH || './spawnpay.db';
  const rpcUrl = process.env.RPC_URL || 'https://mainnet.base.org';
  const app = createApp({
    hmacSecret: process.env.HMAC_SECRET || 'dev-secret',
    masterSeed: process.env.MASTER_SEED,
    dbPath,
    rpcUrl,
  });
  app.listen(port, () => console.log(`SpawnPay VPS backend on :${port}`));

  // start deposit watcher alongside API
  import('./deposit-watcher.js').then(({ createDepositWatcher }) => {
    const watcher = createDepositWatcher({ dbPath, rpcUrl });
    watcher.start();
    process.on('SIGINT', () => { watcher.stop(); process.exit(0); });
    process.on('SIGTERM', () => { watcher.stop(); process.exit(0); });
  });
}
