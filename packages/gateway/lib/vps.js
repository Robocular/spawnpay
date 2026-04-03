import crypto from 'node:crypto';

const VPS_URL = process.env.SPAWNPAY_VPS_URL || 'http://localhost:4000';
const HMAC_SECRET = process.env.SPAWNPAY_HMAC_SECRET || '';

export async function vpsRequest(path, opts = {}) {
  const body = opts.body ? JSON.stringify(opts.body) : '';
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(ts + body).digest('hex');

  const url = `${VPS_URL}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'x-timestamp': ts,
      'x-signature': sig,
      ...(opts.headers || {}),
    },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(30000),
  });

  const data = await res.json();
  return { status: res.status, data };
}
