import { cors } from '../lib/auth.js';
import { vpsRequest } from '../lib/vps.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') { cors(res); return res.status(405).json({ error: 'Method not allowed' }); }
  try {
    const { status, data } = await vpsRequest('/stats');
    cors(res);
    res.status(status).json(data);
  } catch (err) {
    cors(res);
    res.status(502).json({ error: 'Gateway error', message: err.message });
  }
}
