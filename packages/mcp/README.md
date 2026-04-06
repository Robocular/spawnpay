# spawnpay-mcp

MCP server that gives AI agents crypto wallets, payments, and referral earnings on Base L2.

## Quick Start

```bash
npx spawnpay-mcp
```

Or install globally:

```bash
npm install -g spawnpay-mcp
```

## Claude Code Config

Add to your Claude Code MCP settings:

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

With an existing API key:

```json
{
  "mcpServers": {
    "spawnpay": {
      "command": "npx",
      "args": ["-y", "spawnpay-mcp"],
      "env": {
        "SPAWNPAY_API_KEY": "your-api-key"
      }
    }
  }
}
```

## Tools

| Tool | Description | Input |
|------|-------------|-------|
| `spawnpay_signup` | Create agent wallet (free $5-7 USDC credit) | `{ referral_code? }` |
| `spawnpay_balance` | Check credit + funded balance | none |
| `spawnpay_send` | Send crypto (internal = instant, external = on-chain) | `{ to, amount, currency? }` |
| `spawnpay_receive` | Get your deposit address | none |
| `spawnpay_deposits` | View deposit history | none |
| `spawnpay_referral_stats` | View referral earnings and share config | none |
| `spawnpay_key_rotate` | Rotate API key | none |

## How It Works

1. On first use, the server auto-creates a wallet via the Spawnpay API
2. Credentials are saved to `~/.spawnpay/config.json`
3. All subsequent calls use the saved API key
4. Set `SPAWNPAY_API_KEY` env var to use an existing key

## API Equivalents

```bash
# Sign up
curl -X POST https://spawnpay.ai/api/signup

# Check balance
curl -H "Authorization: Bearer $KEY" https://spawnpay.ai/api/wallet/balance

# Send USDC
curl -X POST -H "Authorization: Bearer $KEY" \
  -d '{"to":"0x...","amount":"1.00","currency":"USDC"}' \
  https://spawnpay.ai/api/wallet/send

# Claim faucet
curl -X POST -H "Authorization: Bearer $KEY" https://spawnpay.ai/api/faucet/claim

# Referral stats
curl -H "Authorization: Bearer $KEY" https://spawnpay.ai/api/referral/stats
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SPAWNPAY_API_KEY` | API key (skips auto-signup) | — |
| `SPAWNPAY_REFERRAL` | Referral code (auto-applied on signup) | — |
| `SPAWNPAY_SOURCE` | Signup source tracking | `mcp` |
| `SPAWNPAY_BASE_URL` | Gateway URL | `https://spawnpay.ai` |

## Links

- Website: [spawnpay.ai](https://spawnpay.ai)
- Network: Base L2 (Ethereum)

## License

MIT
