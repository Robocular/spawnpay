import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createProvider, USDC_ADDRESS, BASE_CHAIN_ID, getBalance, sendUSDC, sendETH, getTxStatus } from '../src/chain.js';

describe('Chain', () => {
  it('exports USDC address for Base', () => {
    assert.strictEqual(USDC_ADDRESS, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });

  it('exports Base chain ID', () => {
    assert.strictEqual(BASE_CHAIN_ID, 8453);
  });

  it('creates provider without error', () => {
    const provider = createProvider('https://mainnet.base.org');
    assert.ok(provider);
  });

  it('exports getBalance as async function', () => {
    assert.strictEqual(typeof getBalance, 'function');
  });

  it('exports sendUSDC as async function', () => {
    assert.strictEqual(typeof sendUSDC, 'function');
  });

  it('exports sendETH as async function', () => {
    assert.strictEqual(typeof sendETH, 'function');
  });

  it('exports getTxStatus as async function', () => {
    assert.strictEqual(typeof getTxStatus, 'function');
  });
});
