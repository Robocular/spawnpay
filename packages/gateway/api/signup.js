import { guardMethod, guardRate, cors } from '../lib/auth.js';
import { vpsRequest } from '../lib/vps.js';

export default async function handler(req, res) {
  if (!guardMethod(req, res, 'POST')) return;
  if (!guardRate(req, res)) return;

  try {
    const { referralCode } = req.body || {};
    const { status, data } = await vpsRequest('/signup', {
      method: 'POST',
      body: { ...(referralCode ? { referralCode } : {}) },
    });
    cors(res);
    res.status(status).json(data);
  } catch (err) {
    cors(res);
    res.status(502).json({ error: 'Gateway error', message: err.message });
  }
}
