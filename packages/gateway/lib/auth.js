import { rateLimit } from './rateLimit.js';

export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
}

export function getBearer(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

export function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

export function guardMethod(req, res, method) {
  cors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return false; }
  if (req.method !== method) {
    res.status(405).json({ error: 'Method not allowed' });
    return false;
  }
  return true;
}

export function guardAuth(req, res) {
  const apiKey = getBearer(req);
  if (!apiKey) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return null;
  }
  return apiKey;
}

export function guardRate(req, res) {
  const ip = getIP(req);
  if (!rateLimit(ip)) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return false;
  }
  return true;
}
