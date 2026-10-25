import { createHash, timingSafeEqual } from 'node:crypto';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const sha256 = value => createHash('sha256').update(value).digest();

// Public read, authenticated write: anyone can look at the dashboard, only the token holder can change things.
// No token configured → writes are open (local dev and tests). server.js refuses to start in production without one.
export function requireTokenForWrites(adminToken) {
  if (!adminToken) return (req, res, next) => next();
  const expected = sha256(adminToken);

  return (req, res, next) => {
    if (READ_METHODS.has(req.method)) return next();
    const header = req.get('authorization') ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    // Compare hashes with timingSafeEqual: a plain === stops at the first different character, so response
    // time leaks how much of a guess was right. Hashing first also makes both sides the same length.
    if (given && timingSafeEqual(sha256(given), expected)) return next();
    res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'authentication required' });
  };
}
