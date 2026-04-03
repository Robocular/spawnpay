import crypto from 'node:crypto';

export function verifyHmac(timestamp, signature, body, secret) {
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() - parseInt(timestamp)) > 60000) return false;
  const expected = crypto.createHmac('sha256', secret).update(timestamp + (body || '')).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}
