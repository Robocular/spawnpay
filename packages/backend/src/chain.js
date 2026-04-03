import { ethers } from 'ethers';

export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
export const BASE_CHAIN_ID = 8453;
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];

export function createProvider(rpcUrl = 'https://mainnet.base.org') {
  return new ethers.JsonRpcProvider(rpcUrl);
}

export async function getBalance(address, rpcUrl) {
  const provider = createProvider(rpcUrl);
  const [ethBal, usdcBal] = await Promise.all([
    provider.getBalance(address),
    new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider).balanceOf(address).catch(() => 0n),
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
  return {
    status: receipt.status === 1 ? 'confirmed' : 'failed',
    blockNumber: receipt.blockNumber,
  };
}
