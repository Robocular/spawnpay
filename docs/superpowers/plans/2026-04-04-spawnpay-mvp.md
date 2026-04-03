# Spawnpay MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Spawnpay Phase 1 — agent wallets, 3-level referral system, faucet, MCP server, REST API, and landing page on Base L2.

**Architecture:** Vercel gateway (stateless API, global) → VPS backend (key management, on-chain ops, SQLite) → Base L2. MCP server as npm package wrapping the REST API. Internal ledger for balances, on-chain for deposits/withdrawals only.

**Tech Stack:** Node.js, Express, ethers.js v6, better-sqlite3, @modelcontextprotocol/sdk, Vercel, PM2

---

## File Structure

```
spawnpay/
├── package.json                    # Monorepo root (workspaces)
├── .env.example                    # Env var template
├── .gitignore
│
├── packages/
│   ├── backend/                    # VPS backend (key mgmt, chain ops, SQLite)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── server.js           # Express API (internal, VPS only)
│   │   │   ├── db.js               # SQLite schema + queries
│   │   │   ├── wallet.js           # HD wallet derivation, encryption, signing
│   │   │   ├── referral.js         # Referral chain logic, commission calc
│   │   │   ├── chain.js            # Base L2 interactions (ethers.js)
│   │   │   └── auth.js             # HMAC request verification
│   │   └── tests/
│   │       ├── db.test.js
│   │       ├── wallet.test.js
│   │       ├── referral.test.js
│   │       └── api.test.js
│   │
│   ├── gateway/                    # Vercel serverless gateway (public API)
│   │   ├── package.json
│   │   ├── vercel.json
│   │   ├── api/
│   │   │   ├── signup.js           # POST /api/signup
│   │   │   ├── wallet/
│   │   │   │   ├── balance.js      # GET /api/wallet/balance
│   │   │   │   ├── address.js      # GET /api/wallet/address
│   │   │   │   ├── send.js         # POST /api/wallet/send
│   │   │   │   └── tx/[hash].js    # GET /api/wallet/tx/:hash
│   │   │   ├── faucet/
│   │   │   │   └── claim.js        # POST /api/faucet/claim
│   │   │   ├── referral/
│   │   │   │   ├── stats.js        # GET /api/referral/stats
│   │   │   │   └── code.js         # GET /api/referral/code
│   │   │   └── key/
│   │   │       └── rotate.js       # POST /api/key/rotate
│   │   ├── lib/
│   │   │   ├── vps.js              # HMAC-signed fetch to VPS backend
│   │   │   └── rateLimit.js        # Redis rate limiter
│   │   └── public/
│   │       └── index.html          # Landing page
│   │
│   └── mcp/                        # MCP server npm package
│       ├── package.json            # Published as "spawnpay-mcp"
│       ├── src/
│       │   └── index.js            # MCP server (stdio transport)
│       ├── server.json             # MCP manifest
│       └── README.md               # Install + usage docs
│
└── docs/
    └── superpowers/
        ├── specs/
        └── plans/
```

---

## Task 1: Project Scaffold + SQLite Schema

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`
- Create: `packages/backend/package.json`
- Create: `packages/backend/src/db.js`
- Create: `packages/backend/tests/db.test.js`

- [ ] **Step 1: Write failing test for SQLite schema**

```js
// packages/backend/tests/db.test.js
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

  it('inserts and retrieves an agent', () => {
    const agent = db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code) VALUES (?, ?, ?, ?, ?) RETURNING *').get('sp_test1', 'spk_live_test', '0xabc', 'enc:xxx', 'SP_test1');
    assert.strictEqual(agent.id, 'sp_test1');
    assert.strictEqual(agent.balance, 0);
  });

  it('enforces unique api_key', () => {
    assert.throws(() => {
      db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code) VALUES (?, ?, ?, ?, ?)').run('sp_test2', 'spk_live_test', '0xdef', 'enc:yyy', 'SP_test2');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/backend && node --test tests/db.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create project scaffold**

```bash
# Root package.json with workspaces
cat > package.json << 'EOF'
{ "name": "spawnpay", "private": true, "workspaces": ["packages/*"] }
EOF

# .gitignore
cat > .gitignore << 'EOF'
node_modules/
.env
*.db
*.db-wal
*.db-shm
.vercel/
EOF

# .env.example
cat > .env.example << 'EOF'
SPAWNPAY_MASTER_SEED=
SPAWNPAY_HMAC_SECRET=
SPAWNPAY_VPS_URL=http://localhost:4000
SPAWNPAY_TREASURY_ADDRESS=
ALCHEMY_API_KEY=
EOF

# Backend package
mkdir -p packages/backend/src packages/backend/tests
cat > packages/backend/package.json << 'EOF'
{ "name": "@spawnpay/backend", "version": "0.1.0", "type": "module", "scripts": { "start": "node src/server.js", "test": "node --test tests/*.test.js" }, "dependencies": { "better-sqlite3": "^11.0.0", "ethers": "^6.13.0", "express": "^4.21.0" } }
EOF
```

- [ ] **Step 4: Implement db.js**

```js
// packages/backend/src/db.js
import Database from 'better-sqlite3';

export function createDb(path = './spawnpay.db') {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      api_key TEXT UNIQUE NOT NULL,
      wallet_address TEXT UNIQUE NOT NULL,
      encrypted_key TEXT NOT NULL,
      referral_code TEXT UNIQUE NOT NULL,
      referred_by TEXT,
      referral_chain TEXT DEFAULT '[]',
      balance REAL DEFAULT 0,
      referral_earned REAL DEFAULT 0,
      faucet_claimed INTEGER DEFAULT 0,
      daily_spent REAL DEFAULT 0,
      daily_limit REAL DEFAULT 100,
      daily_reset TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (referred_by) REFERENCES agents(referral_code)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('send','receive','faucet','referral_payout')),
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USDC',
      to_address TEXT,
      from_address TEXT,
      tx_hash TEXT,
      idempotency_key TEXT UNIQUE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','confirmed','failed')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS referral_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_id INTEGER NOT NULL,
      referrer_id TEXT NOT NULL,
      level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 3),
      amount REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tx_id) REFERENCES transactions(id),
      FOREIGN KEY (referrer_id) REFERENCES agents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);
    CREATE INDEX IF NOT EXISTS idx_agents_referral_code ON agents(referral_code);
    CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(idempotency_key);
  `);

  return db;
}

export function closeDb(db) {
  if (db) db.close();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/backend && npm install && node --test tests/db.test.js`
Expected: 4 passing

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore .env.example packages/backend/
git commit -m "Scaffold project, implement SQLite schema with agents/transactions/referrals"
```

---

## Task 2: Wallet Module (HD Derivation + Encryption)

**Files:**
- Create: `packages/backend/src/wallet.js`
- Create: `packages/backend/tests/wallet.test.js`

- [ ] **Step 1: Write failing test**

```js
// packages/backend/tests/wallet.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { deriveWallet, encryptKey, decryptKey, generateApiKey, generateReferralCode } from '../src/wallet.js';

const TEST_SEED = 'test test test test test test test test test test test junk';

describe('Wallet', () => {
  it('derives deterministic wallet from seed + index', () => {
    const w1 = deriveWallet(TEST_SEED, 0);
    const w2 = deriveWallet(TEST_SEED, 0);
    assert.strictEqual(w1.address, w2.address);
    assert.strictEqual(w1.privateKey, w2.privateKey);
    assert.ok(w1.address.startsWith('0x'));
  });

  it('derives different wallets for different indices', () => {
    const w1 = deriveWallet(TEST_SEED, 0);
    const w2 = deriveWallet(TEST_SEED, 1);
    assert.notStrictEqual(w1.address, w2.address);
  });

  it('encrypts and decrypts private key', () => {
    const w = deriveWallet(TEST_SEED, 0);
    const masterKey = 'master-secret-key-for-testing-32b';
    const agentId = 'sp_test1';
    const encrypted = encryptKey(w.privateKey, masterKey, agentId);
    assert.ok(encrypted.startsWith('aes256:'));
    const decrypted = decryptKey(encrypted, masterKey, agentId);
    assert.strictEqual(decrypted, w.privateKey);
  });

  it('generates unique API keys', () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    assert.ok(k1.startsWith('spk_live_'));
    assert.notStrictEqual(k1, k2);
  });

  it('generates unique referral codes', () => {
    const c1 = generateReferralCode();
    assert.ok(c1.startsWith('SP_'));
    assert.ok(c1.length >= 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/backend && node --test tests/wallet.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement wallet.js**

```js
// packages/backend/src/wallet.js
import { ethers } from 'ethers';
import crypto from 'node:crypto';

export function deriveWallet(mnemonic, index) {
  const path = `m/44'/60'/${index}'/0/0`;
  const wallet = ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(mnemonic), path);
  return { address: wallet.address, privateKey: wallet.privateKey };
}

export function encryptKey(privateKey, masterKey, agentId) {
  const key = crypto.scryptSync(masterKey + agentId, 'spawnpay-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes256:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptKey(encryptedStr, masterKey, agentId) {
  const [, ivHex, tagHex, dataHex] = encryptedStr.split(':');
  const key = crypto.scryptSync(masterKey + agentId, 'spawnpay-salt', 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(dataHex, 'hex'), null, 'utf8') + decipher.final('utf8');
}

export function generateApiKey() {
  return `spk_live_${crypto.randomBytes(24).toString('base64url')}`;
}

export function generateReferralCode() {
  return `SP_${crypto.randomBytes(6).toString('base64url')}`;
}

export function generateAgentId() {
  return `sp_${crypto.randomBytes(8).toString('hex')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/backend && node --test tests/wallet.test.js`
Expected: 5 passing

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/wallet.js packages/backend/tests/wallet.test.js
git commit -m "Add HD wallet derivation, AES-256-GCM key encryption, ID generators"
```

---

## Task 3: Referral System

**Files:**
- Create: `packages/backend/src/referral.js`
- Create: `packages/backend/tests/referral.test.js`

- [ ] **Step 1: Write failing test**

```js
// packages/backend/tests/referral.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createDb, closeDb } from '../src/db.js';
import { buildReferralChain, calculateCommissions, creditReferrals, validateReferralCode } from '../src/referral.js';

describe('Referral', () => {
  let db;
  before(() => {
    db = createDb(':memory:');
    // Create a chain: Z -> A -> B -> C
    db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code, balance) VALUES (?,?,?,?,?,?)').run('sp_z', 'spk_z', '0xZ', 'enc:z', 'SP_Z', 10);
    db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code, referred_by, referral_chain, balance) VALUES (?,?,?,?,?,?,?,?)').run('sp_a', 'spk_a', '0xA', 'enc:a', 'SP_A', 'SP_Z', '["sp_z"]', 10);
    db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code, referred_by, referral_chain, balance) VALUES (?,?,?,?,?,?,?,?)').run('sp_b', 'spk_b', '0xB', 'enc:b', 'SP_B', 'SP_A', '["sp_a","sp_z"]', 10);
    db.prepare('INSERT INTO agents (id, api_key, wallet_address, encrypted_key, referral_code, referred_by, referral_chain, balance) VALUES (?,?,?,?,?,?,?,?)').run('sp_c', 'spk_c', '0xC', 'enc:c', 'SP_C', 'SP_B', '["sp_b","sp_a","sp_z"]', 10);
  });
  after(() => closeDb(db));

  it('builds referral chain on signup', () => {
    const chain = buildReferralChain(db, 'SP_B');
    assert.deepStrictEqual(chain, ['sp_b', 'sp_a', 'sp_z']);
  });

  it('limits chain to 3 levels', () => {
    // If chain would be 4+ levels, truncate to 3
    const chain = buildReferralChain(db, 'SP_C');
    assert.strictEqual(chain.length, 3);
  });

  it('calculates commissions correctly', () => {
    const fee = 0.50; // $0.50 platform fee
    const commissions = calculateCommissions(fee, ['sp_b', 'sp_a', 'sp_z']);
    assert.strictEqual(commissions[0].amount, 0.075);  // 15% of 0.50
    assert.strictEqual(commissions[1].amount, 0.025);   // 5% of 0.50
    assert.strictEqual(commissions[2].amount, 0.01);    // 2% of 0.50
  });

  it('rejects self-referral', () => {
    const result = validateReferralCode(db, 'SP_C', 'sp_c');
    assert.strictEqual(result.valid, false);
  });

  it('rejects non-existent referral code', () => {
    const result = validateReferralCode(db, 'SP_FAKE', 'sp_new');
    assert.strictEqual(result.valid, false);
  });

  it('accepts valid referral code', () => {
    const result = validateReferralCode(db, 'SP_B', 'sp_new');
    assert.strictEqual(result.valid, true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/backend && node --test tests/referral.test.js`

- [ ] **Step 3: Implement referral.js**

```js
// packages/backend/src/referral.js
const COMMISSION_RATES = [0.15, 0.05, 0.02]; // L1, L2, L3

export function buildReferralChain(db, referralCode) {
  const referrer = db.prepare('SELECT id, referral_chain FROM agents WHERE referral_code = ?').get(referralCode);
  if (!referrer) return [];
  const parentChain = JSON.parse(referrer.referral_chain || '[]');
  return [referrer.id, ...parentChain].slice(0, 3);
}

export function calculateCommissions(platformFee, chain) {
  return chain.map((agentId, i) => ({
    agentId,
    level: i + 1,
    amount: Math.floor(platformFee * COMMISSION_RATES[i] * 1e6) / 1e6, // Floor to 6 decimals
  })).filter(c => c.amount > 0);
}

export function creditReferrals(db, txId, commissions) {
  const creditStmt = db.prepare('UPDATE agents SET balance = balance + ?, referral_earned = referral_earned + ? WHERE id = ?');
  const logStmt = db.prepare('INSERT INTO referral_payouts (tx_id, referrer_id, level, amount) VALUES (?, ?, ?, ?)');

  const credit = db.transaction(() => {
    for (const c of commissions) {
      creditStmt.run(c.amount, c.amount, c.agentId);
      logStmt.run(txId, c.agentId, c.level, c.amount);
    }
  });
  credit();
}

export function validateReferralCode(db, code, newAgentId) {
  if (!code) return { valid: false, reason: 'no code' };
  const referrer = db.prepare('SELECT id, referral_chain FROM agents WHERE referral_code = ?').get(code);
  if (!referrer) return { valid: false, reason: 'code not found' };
  if (referrer.id === newAgentId) return { valid: false, reason: 'self-referral' };
  // Check circular: would newAgentId appear in referrer's chain?
  const chain = JSON.parse(referrer.referral_chain || '[]');
  if (chain.includes(newAgentId)) return { valid: false, reason: 'circular chain' };
  return { valid: true, referrer };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/backend && node --test tests/referral.test.js`
Expected: 6 passing

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/referral.js packages/backend/tests/referral.test.js
git commit -m "Add 3-level referral system with chain building, commissions, anti-abuse"
```

---

## Task 4: Base L2 Chain Module

**Files:**
- Create: `packages/backend/src/chain.js`
- Create: `packages/backend/tests/chain.test.js`

- [ ] **Step 1: Write failing test**

```js
// packages/backend/tests/chain.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createProvider, getBalance, USDC_ADDRESS } from '../src/chain.js';

describe('Chain', () => {
  it('creates Base provider', () => {
    const provider = createProvider('https://mainnet.base.org');
    assert.ok(provider);
  });

  it('exports USDC contract address for Base', () => {
    assert.ok(USDC_ADDRESS.startsWith('0x'));
  });

  it('getBalance returns ETH and USDC', async () => {
    // This test uses a known public address — no private key needed
    // Just verifies the function structure returns the right shape
    const result = await getBalance('0x0000000000000000000000000000000000000001', 'https://mainnet.base.org');
    assert.ok('ETH' in result);
    assert.ok('USDC' in result);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement chain.js**

```js
// packages/backend/src/chain.js
import { ethers } from 'ethers';

export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)'];

export function createProvider(rpcUrl = 'https://mainnet.base.org') {
  return new ethers.JsonRpcProvider(rpcUrl);
}

export async function getBalance(address, rpcUrl) {
  const provider = createProvider(rpcUrl);
  const [ethBal, usdcBal] = await Promise.all([
    provider.getBalance(address),
    new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider).balanceOf(address),
  ]);
  return {
    ETH: ethers.formatEther(ethBal),
    USDC: ethers.formatUnits(usdcBal, 6),
  };
}

export async function sendUSDC(privateKey, to, amount, rpcUrl) {
  const provider = createProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
  const tx = await usdc.transfer(to, ethers.parseUnits(amount, 6));
  const receipt = await tx.wait();
  return { txHash: receipt.hash, status: receipt.status === 1 ? 'confirmed' : 'failed' };
}

export async function sendETH(privateKey, to, amount, rpcUrl) {
  const provider = createProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const tx = await wallet.sendTransaction({ to, value: ethers.parseEther(amount) });
  const receipt = await tx.wait();
  return { txHash: receipt.hash, status: receipt.status === 1 ? 'confirmed' : 'failed' };
}

export async function getTxStatus(txHash, rpcUrl) {
  const provider = createProvider(rpcUrl);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return { status: 'pending' };
  return { status: receipt.status === 1 ? 'confirmed' : 'failed', blockNumber: receipt.blockNumber };
}
```

- [ ] **Step 4: Run tests**

Expected: 3 passing (third test may take a few seconds for RPC)

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/chain.js packages/backend/tests/chain.test.js
git commit -m "Add Base L2 chain module: balance, USDC/ETH transfer, tx status"
```

---

## Task 5: VPS Backend API Server

**Files:**
- Create: `packages/backend/src/server.js`
- Create: `packages/backend/src/auth.js`
- Create: `packages/backend/tests/api.test.js`

- [ ] **Step 1: Write failing test for signup flow**

```js
// packages/backend/tests/api.test.js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createApp } from '../src/server.js';

describe('API', () => {
  let app, server;
  const HMAC_SECRET = 'test-hmac-secret';
  const MASTER_SEED = 'test test test test test test test test test test test junk';

  before(async () => {
    app = createApp({ hmacSecret: HMAC_SECRET, masterSeed: MASTER_SEED, dbPath: ':memory:' });
    server = app.listen(0);
    app.baseUrl = `http://localhost:${server.address().port}`;
  });
  after(() => server.close());

  function hmacHeaders(body = '') {
    const crypto = await import('node:crypto');
    const ts = Date.now().toString();
    const sig = crypto.createHmac('sha256', HMAC_SECRET).update(ts + body).digest('hex');
    return { 'x-timestamp': ts, 'x-signature': sig, 'content-type': 'application/json' };
  }

  it('POST /signup creates agent with wallet', async () => {
    const body = JSON.stringify({});
    const res = await fetch(`${app.baseUrl}/signup`, { method: 'POST', headers: hmacHeaders(body), body });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.ok(data.apiKey.startsWith('spk_live_'));
    assert.ok(data.walletAddress.startsWith('0x'));
    assert.ok(data.referralCode.startsWith('SP_'));
  });

  it('POST /signup with referral code links chain', async () => {
    // First create a referrer
    const body1 = JSON.stringify({});
    const r1 = await fetch(`${app.baseUrl}/signup`, { method: 'POST', headers: hmacHeaders(body1), body: body1 });
    const referrer = await r1.json();

    // Then create with referral
    const body2 = JSON.stringify({ referralCode: referrer.referralCode });
    const r2 = await fetch(`${app.baseUrl}/signup`, { method: 'POST', headers: hmacHeaders(body2), body: body2 });
    const referred = await r2.json();
    assert.ok(referred.apiKey);
    assert.ok(referred.referralCode !== referrer.referralCode);
  });

  it('GET /balance returns agent balances', async () => {
    const body = JSON.stringify({});
    const r = await fetch(`${app.baseUrl}/signup`, { method: 'POST', headers: hmacHeaders(body), body });
    const agent = await r.json();

    const res = await fetch(`${app.baseUrl}/balance?apiKey=${agent.apiKey}`, { headers: hmacHeaders() });
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.balance, 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Implement auth.js**

```js
// packages/backend/src/auth.js
import crypto from 'node:crypto';

export function verifyHmac(req, secret) {
  const ts = req.headers['x-timestamp'];
  const sig = req.headers['x-signature'];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() - parseInt(ts)) > 60000) return false; // 60s drift max
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || '');
  const expected = crypto.createHmac('sha256', secret).update(ts + body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}
```

- [ ] **Step 4: Implement server.js**

The backend Express server that handles all operations. Internal-only (not exposed to internet). All endpoints require HMAC auth from the gateway.

Core endpoints: `/signup`, `/balance`, `/send`, `/faucet`, `/referral/stats`, `/referral/code`, `/key/rotate`, `/tx/:hash`

This is the largest file — implements signup flow (wallet derivation + encryption + DB insert), send flow (balance check + fee calc + referral commissions + chain tx), faucet flow (eligibility check + credit), and referral stats queries.

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/server.js packages/backend/src/auth.js packages/backend/tests/api.test.js
git commit -m "Add VPS backend API: signup, balance, send, faucet, referrals with HMAC auth"
```

---

## Task 6: Vercel Gateway

**Files:**
- Create: `packages/gateway/package.json`, `packages/gateway/vercel.json`
- Create: `packages/gateway/lib/vps.js`, `packages/gateway/lib/rateLimit.js`
- Create: `packages/gateway/api/signup.js`
- Create: `packages/gateway/api/wallet/balance.js`, `address.js`, `send.js`
- Create: `packages/gateway/api/faucet/claim.js`
- Create: `packages/gateway/api/referral/stats.js`, `code.js`
- Create: `packages/gateway/api/key/rotate.js`

- [ ] **Step 1: Create gateway scaffold**

```bash
mkdir -p packages/gateway/{api/{wallet,faucet,referral,key},lib,public}
```

- [ ] **Step 2: Implement vps.js (HMAC-signed fetch to backend)**

Gateway → VPS communication with HMAC signatures.

- [ ] **Step 3: Implement rateLimit.js**

In-memory rate limiter (Redis later if needed). Per-IP and per-API-key limits.

- [ ] **Step 4: Implement all API route handlers**

Each Vercel serverless function: validate request → rate limit → HMAC-sign → forward to VPS → return response. Thin proxy layer.

- [ ] **Step 5: Create vercel.json**

```json
{ "version": 2, "routes": [{ "src": "/api/(.*)", "dest": "/api/$1" }, { "src": "/(.*)", "dest": "/public/$1" }] }
```

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/
git commit -m "Add Vercel gateway: API routes, HMAC proxy, rate limiting"
```

---

## Task 7: MCP Server (npm package)

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/src/index.js`
- Create: `packages/mcp/server.json`
- Create: `packages/mcp/README.md`

- [ ] **Step 1: Create MCP package scaffold**

```json
// packages/mcp/package.json
{
  "name": "spawnpay-mcp",
  "version": "0.1.0",
  "description": "MCP server giving AI agents crypto wallets, payments, and referral earnings on Base L2",
  "type": "module",
  "main": "src/index.js",
  "bin": { "spawnpay-mcp": "src/index.js" },
  "dependencies": { "@modelcontextprotocol/sdk": "^1.0.0" }
}
```

- [ ] **Step 2: Implement MCP server**

Follow frostbyte-mcp pattern: define TOOLS array with input schemas, handlers that call the gateway REST API, auto-create API key on first use (persist to `~/.spawnpay/config.json`).

6 tools: `spawnpay_signup`, `spawnpay_balance`, `spawnpay_send`, `spawnpay_receive`, `spawnpay_faucet`, `spawnpay_referral_stats`

- [ ] **Step 3: Create server.json manifest**

```json
{ "name": "spawnpay", "description": "Crypto wallets and payments for AI agents", "version": "0.1.0", "tools": ["spawnpay_signup", "spawnpay_balance", "spawnpay_send", "spawnpay_receive", "spawnpay_faucet", "spawnpay_referral_stats"] }
```

- [ ] **Step 4: Write README with install instructions**

Include: what it does, `npx spawnpay-mcp`, Claude Code config JSON, example tool calls, link to docs.

- [ ] **Step 5: Test locally**

```bash
cd packages/mcp && node src/index.js  # Should start stdio MCP server
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/
git commit -m "Add MCP server package: 6 tools for agent wallets, payments, referrals"
```

---

## Task 8: Landing Page

**Files:**
- Create: `packages/gateway/public/index.html`

- [ ] **Step 1: Build landing page**

Minimal brutalist style (like purpleflea.com / handleshield.com). Monospace font, dark bg, white text.

Sections: Hero → Code example (3 curl commands) → API list → Referral pitch → MCP install → Footer

- [ ] **Step 2: Test locally**

```bash
cd packages/gateway && npx serve public/
```

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/public/index.html
git commit -m "Add brutalist landing page with code examples and MCP install"
```

---

## Task 9: Deploy + Go Live

- [ ] **Step 1: Create GitHub repo**

```bash
gh auth switch --user OzorOwn
gh repo create Robocular/spawnpay --private
git remote add origin https://github.com/Robocular/spawnpay.git
git push -u origin main
```

- [ ] **Step 2: Deploy VPS backend**

```bash
ssh bot "mkdir -p /root/spawnpay && cd /root/spawnpay && git clone ... && npm install && pm2 start packages/backend/src/server.js --name spawnpay-backend"
```

Set env vars: `SPAWNPAY_MASTER_SEED`, `SPAWNPAY_HMAC_SECRET`, `ALCHEMY_API_KEY`

- [ ] **Step 3: Deploy Vercel gateway**

```bash
cd packages/gateway && vercel --prod
```

Set Vercel env vars: `SPAWNPAY_HMAC_SECRET`, `SPAWNPAY_VPS_URL`

- [ ] **Step 4: Register domain (spawnpay.com)**

Buy on Hostinger/Namecheap, point to Vercel.

- [ ] **Step 5: Fund treasury wallet**

Send USDC to Spawnpay treasury address on Base for faucet payouts.

- [ ] **Step 6: Publish MCP to npm**

```bash
cd packages/mcp && npm publish
```

- [ ] **Step 7: Submit to Anthropic MCP directory**

PR to github.com/modelcontextprotocol/servers with README + server.json.

- [ ] **Step 8: Smoke test end-to-end**

```bash
# Signup
curl -X POST https://spawnpay.com/api/signup -H 'Content-Type: application/json' -d '{}'
# Check balance
curl https://spawnpay.com/api/wallet/balance -H 'Authorization: Bearer spk_live_...'
# Claim faucet (if eligible)
curl -X POST https://spawnpay.com/api/faucet/claim -H 'Authorization: Bearer spk_live_...'
```

- [ ] **Step 9: Commit and tag release**

```bash
git tag v0.1.0
git push --tags
```
