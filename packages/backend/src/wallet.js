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
