import { ethers } from 'ethers';
import { USDC_ADDRESS, createProvider } from './chain.js';
import { createDb } from './db.js';

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '15000', 10); // 15s default
const LOOKBACK_BLOCKS = 50; // ~100s on Base (2s blocks)

export function createDepositWatcher(config) {
  const { dbPath, rpcUrl = 'https://mainnet.base.org' } = config;
  const db = createDb(dbPath);
  const provider = createProvider(rpcUrl);
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

  // track last processed block
  db.exec(`
    CREATE TABLE IF NOT EXISTS deposit_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  function getLastBlock() {
    const row = db.prepare("SELECT value FROM deposit_state WHERE key = 'last_block'").get();
    return row ? parseInt(row.value, 10) : 0;
  }

  function setLastBlock(block) {
    db.prepare("INSERT OR REPLACE INTO deposit_state (key, value) VALUES ('last_block', ?)").run(String(block));
  }

  // get all agent wallet addresses for fast lookup
  function getAgentAddresses() {
    const agents = db.prepare('SELECT id, wallet_address FROM agents').all();
    const map = new Map();
    for (const a of agents) map.set(a.wallet_address.toLowerCase(), a.id);
    return map;
  }

  async function pollDeposits() {
    try {
      const currentBlock = await provider.getBlockNumber();
      let fromBlock = getLastBlock();

      if (fromBlock === 0) {
        // first run: start from current block (don't scan entire history)
        setLastBlock(currentBlock);
        console.log(`[deposit-watcher] Initialized at block ${currentBlock}`);
        return;
      }

      if (fromBlock >= currentBlock) return; // nothing new

      // cap lookback to avoid huge queries
      if (currentBlock - fromBlock > LOOKBACK_BLOCKS * 10) {
        fromBlock = currentBlock - LOOKBACK_BLOCKS;
      }

      const agentMap = getAgentAddresses();
      if (agentMap.size === 0) return;

      // 1. Check USDC Transfer events
      const usdcLogs = await usdc.queryFilter(
        usdc.filters.Transfer(null, null),
        fromBlock + 1,
        currentBlock
      );

      let credited = 0;
      for (const log of usdcLogs) {
        const to = log.args.to.toLowerCase();
        const agentId = agentMap.get(to);
        if (!agentId) continue;

        const amount = parseFloat(ethers.formatUnits(log.args.value, 6));
        if (amount <= 0) continue;

        const txHash = log.transactionHash;

        // idempotency: skip if already recorded
        const existing = db.prepare("SELECT id FROM transactions WHERE tx_hash = ? AND type = 'receive'").get(txHash);
        if (existing) continue;

        // credit balance
        db.prepare('UPDATE agents SET balance = balance + ? WHERE id = ?').run(amount, agentId);
        db.prepare(
          "INSERT INTO transactions (agent_id, type, amount, currency, from_address, to_address, tx_hash, status) VALUES (?, 'receive', ?, 'USDC', ?, ?, ?, 'confirmed')"
        ).run(agentId, amount, log.args.from, to, txHash);

        credited++;
        console.log(`[deposit-watcher] Credited ${amount} USDC to ${agentId} (tx: ${txHash.slice(0, 10)}...)`);
      }

      // 2. Check ETH transfers via block traces (simpler: check balance changes)
      // For ETH, we check each agent's on-chain balance vs internal balance
      // This is less frequent — do it every 10th poll
      if (currentBlock % 10 === 0) {
        for (const [addr, agentId] of agentMap) {
          try {
            const onChainBal = await provider.getBalance(addr);
            const ethAmount = parseFloat(ethers.formatEther(onChainBal));
            if (ethAmount > 0.0001) { // meaningful ETH deposit (above dust)
              const agent = db.prepare('SELECT balance FROM agents WHERE id = ?').get(agentId);
              // We don't auto-credit ETH to internal balance — ETH stays on-chain for gas
              // Just log it for visibility
              console.log(`[deposit-watcher] Agent ${agentId} has ${ethAmount.toFixed(6)} ETH on-chain`);
            }
          } catch { /* ignore individual balance check failures */ }
        }
      }

      if (credited > 0) {
        console.log(`[deposit-watcher] Processed blocks ${fromBlock + 1}-${currentBlock}: ${credited} deposits`);
      }

      setLastBlock(currentBlock);
    } catch (err) {
      console.error(`[deposit-watcher] Error: ${err.message}`);
    }
  }

  let interval;

  return {
    start() {
      console.log(`[deposit-watcher] Starting, polling every ${POLL_INTERVAL / 1000}s`);
      pollDeposits(); // initial poll
      interval = setInterval(pollDeposits, POLL_INTERVAL);
    },
    stop() {
      if (interval) clearInterval(interval);
      db.close();
    },
  };
}

// standalone run
if (import.meta.url === `file://${process.argv[1]}`) {
  const watcher = createDepositWatcher({
    dbPath: process.env.DB_PATH || './spawnpay.db',
    rpcUrl: process.env.RPC_URL || 'https://mainnet.base.org',
  });
  watcher.start();
  process.on('SIGINT', () => { watcher.stop(); process.exit(0); });
  process.on('SIGTERM', () => { watcher.stop(); process.exit(0); });
}
