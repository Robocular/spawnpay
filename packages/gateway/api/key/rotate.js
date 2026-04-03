import { guardMethod, guardAuth, guardRate, cors } from '../../lib/auth.js';
import { vpsRequest } from '../../lib/vps.js';

export default async function handler(req, res) {
  if (!guardMethod(req, res, 'POST')) return;
  if (!guardRate(req, res)) return;
  const apiKey = guardAuth(req, res);
  if (!apiKey) return;

  try {
    const { status, data } = await vpsRequest('/key/rotate', {
      method: 'POST',
      body: { apiKey },
    });
    cors(res);
    res.status(status).json(data);
  } catch (err) {
    cors(res);
    res.status(502).json({ error: 'Gateway error', message: err.message });
  }
}
