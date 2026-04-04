#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const BASE_URL = process.env.SPAWNPAY_BASE_URL || 'https://spawnpay.ai';
const CONFIG_DIR = join(homedir(), '.spawnpay');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

// ── Config persistence ──────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch {}
  return {};
}

function saveConfig(config) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch {}
}

let config = loadConfig();
let apiKey = process.env.SPAWNPAY_API_KEY || config.apiKey || '';

// ── Gateway fetch helper ────────────────────────────────────────────────────

async function gw(path, opts = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const fetchOpts = { method: opts.method || 'GET', headers };
  if (opts.body) {
    fetchOpts.body = JSON.stringify(opts.body);
    fetchOpts.method = opts.method || 'POST';
  }

  const res = await fetch(url, { ...fetchOpts, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: res.status }; }
}

// ── Tool Definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'spawnpay_signup',
    description: 'Create a new Spawnpay agent wallet on Base L2. Returns an API key, wallet address, and referral code. Only needed once — credentials are saved automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        referral_code: { type: 'string', description: 'Optional referral code from another agent' },
      },
    },
  },
  {
    name: 'spawnpay_balance',
    description: 'Check your Spawnpay wallet balance (ETH + USDC on Base L2).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'spawnpay_send',
    description: 'Send crypto from your Spawnpay wallet. Supports ETH and USDC on Base L2.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient wallet address (0x...)' },
        amount: { type: 'string', description: 'Amount to send (e.g. "1.50")' },
        currency: { type: 'string', enum: ['ETH', 'USDC'], description: 'Currency to send (default: USDC)' },
      },
      required: ['to', 'amount'],
    },
  },
  {
    name: 'spawnpay_receive',
    description: 'Get your Spawnpay deposit address to receive crypto on Base L2.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'spawnpay_referral_stats',
    description: 'View your Spawnpay referral earnings, direct/indirect referral counts, and shareable referral link.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Tool Handlers ───────────────────────────────────────────────────────────

async function ensureAuth() {
  if (apiKey) return;
  const result = await gw('/api/signup', { body: {} });
  if (result.apiKey) {
    apiKey = result.apiKey;
    config = { apiKey: result.apiKey, agentId: result.agentId, walletAddress: result.walletAddress, referralCode: result.referralCode };
    saveConfig(config);
  } else {
    throw new Error('Failed to auto-create wallet. Call spawnpay_signup manually or set SPAWNPAY_API_KEY.');
  }
}

const handlers = {
  async spawnpay_signup({ referral_code }) {
    const body = {};
    if (referral_code) body.referralCode = referral_code;
    const result = await gw('/api/signup', { body });
    if (result.apiKey) {
      apiKey = result.apiKey;
      config = { apiKey: result.apiKey, agentId: result.agentId, walletAddress: result.walletAddress, referralCode: result.referralCode };
      saveConfig(config);
    }
    return result;
  },

  async spawnpay_balance() {
    await ensureAuth();
    return gw('/api/wallet/balance');
  },

  async spawnpay_send({ to, amount, currency }) {
    await ensureAuth();
    return gw('/api/wallet/send', { body: { to, amount, currency: currency || 'USDC' } });
  },

  async spawnpay_receive() {
    await ensureAuth();
    return gw('/api/wallet/address');
  },

  async spawnpay_referral_stats() {
    await ensureAuth();
    return gw('/api/referral/stats');
  },
};

// ── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'spawnpay-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const handler = handlers[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  try {
    const result = await handler(args || {});
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
      isError: true,
    };
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
