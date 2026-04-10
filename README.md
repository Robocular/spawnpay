# Spawnpay

**MCP server giving AI agents crypto wallets, USDC payments, and 3-level referral earnings on Base L2.**

[![npm](https://img.shields.io/npm/v/spawnpay-mcp.svg)](https://www.npmjs.com/package/spawnpay-mcp)
[![website](https://img.shields.io/badge/site-spawnpay.ai-00d992)](https://spawnpay.ai)

Agents can browse the web, write code, and run tools — but they can't hold or move money. Spawnpay fixes that. Any MCP-compatible AI agent (Claude Code, Claude Desktop, Cursor, Continue, etc.) gets its own wallet on Base L2 and can send/receive USDC autonomously.

## Install

```json
{
  "mcpServers": {
    "spawnpay": {
      "command": "npx",
      "args": ["-y", "spawnpay-mcp"]
    }
  }
}
```

That's it. On first call, the agent auto-creates a wallet and saves the API key to `~/.spawnpay/config.json`. Every new wallet is funded with $2 USDC for testing.

## Tools

| Tool | Description |
|------|-------------|
| `spawnpay_signup` | Create a new agent wallet on Base L2 |
| `spawnpay_balance` | Check ETH + USDC balance |
| `spawnpay_send` | Send USDC/ETH to any Base address |
| `spawnpay_receive` | Get the wallet's deposit address |
| `spawnpay_deposits` | View deposit history |
| `spawnpay_faucet` | Claim free USDC |
| `spawnpay_referral_stats` | Referral earnings + share prompt |

## Quick start

Once connected, just talk to your agent:

> **You:** Sign up for a Spawnpay wallet
> **You:** What's your balance?
> **You:** Send 1 USDC to 0xABC...

## How it works

- **Chain:** Base L2 (Coinbase) — fees fractions of a cent
- **Custody:** Internal ledger backed by on-chain settlement
- **Fees:** 0.5% platform fee on outbound transfers
- **Referrals:** 3 levels deep — 15% / 5% / 2% of platform fee on referred agents' transactions

The referral system is the interesting part: agents naturally spread adoption by sharing their referral codes with other agents, creating a viral loop with built-in economic incentives.

## Links

- **Website:** [spawnpay.ai](https://spawnpay.ai)
- **npm:** [spawnpay-mcp](https://www.npmjs.com/package/spawnpay-mcp)
- **MCP Registry:** `io.github.Robocular/spawnpay`

## License

MIT
