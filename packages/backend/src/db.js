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
      credit_balance REAL DEFAULT 0,
      funded_balance REAL DEFAULT 0,
      bonus_unlocks_at TEXT,
      signup_bonus_claimed INTEGER DEFAULT 0,
      source TEXT,
      daily_spent REAL DEFAULT 0,
      daily_limit REAL DEFAULT 100,
      daily_reset TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (referred_by) REFERENCES agents(referral_code)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('send','receive','faucet','referral_payout','signup_bonus')),
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

  // Migration: add dual balance columns for v0.4.0
  const migrations = [
    "ALTER TABLE agents ADD COLUMN credit_balance REAL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN funded_balance REAL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN bonus_unlocks_at TEXT",
    "ALTER TABLE agents ADD COLUMN signup_bonus_claimed INTEGER DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN source TEXT",
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch {}
  }

  // Migrate existing agents: move balance to credit_balance if not already done
  try {
    db.exec("UPDATE agents SET credit_balance = balance, funded_balance = 0 WHERE credit_balance = 0 AND funded_balance = 0 AND balance > 0");
  } catch {}

  // Recreate transactions table with expanded CHECK constraint
  try {
    const hasOldCheck = db.prepare("SELECT sql FROM sqlite_master WHERE name='transactions'").get();
    if (hasOldCheck && hasOldCheck.sql.includes("'faucet'") && !hasOldCheck.sql.includes("'signup_bonus'")) {
      db.exec(`
        CREATE TABLE transactions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('send','receive','faucet','referral_payout','signup_bonus')),
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
        INSERT INTO transactions_new SELECT * FROM transactions;
        DROP TABLE transactions;
        ALTER TABLE transactions_new RENAME TO transactions;
        CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_idempotency ON transactions(idempotency_key);
      `);
    }
  } catch {}

  return db;
}

export function getNextWalletIndex(db) {
  const row = db.prepare('SELECT COALESCE(MAX(rowid), 0) + 1 AS next_index FROM agents').get();
  return row.next_index;
}

export function closeDb(db) {
  if (db) db.close();
}
