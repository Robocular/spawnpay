const store = new Map();

export function rateLimit(key, maxRequests = 60, windowMs = 60000) {
  const now = Date.now();
  const entry = store.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  store.set(key, entry);

  return entry.count <= maxRequests;
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt + 60000) store.delete(key);
  }
}, 300000).unref?.();
