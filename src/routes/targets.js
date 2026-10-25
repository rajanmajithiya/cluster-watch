import { Router } from 'express';
import { HttpError } from '../errors.js';
import { parseId, intField } from './params.js';

// SSRF guard. Our server fetches URLs that users give it. Without this, someone registers
// http://169.254.169.254/latest/meta-data/iam/... and the worker fetches the cloud instance's
// credentials for them. Production-grade: also resolve DNS and block private ranges (see lesson notes).
const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', '[fd00:ec2::254]']);

function validateUrl(raw, problems) {
  let url;
  try { url = new URL(raw); } catch { problems.push('url must be a valid absolute URL'); return raw; }
  if (!['http:', 'https:'].includes(url.protocol)) problems.push('url must use http or https');
  if (BLOCKED_HOSTS.has(url.hostname) || url.hostname.startsWith('169.254.')) {
    problems.push('url points to a blocked (link-local / cloud metadata) address');
  }
  return url.toString();
}

function validateNewTarget(body = {}) {
  const problems = [];
  const { name } = body;
  if (typeof name !== 'string' || !name.trim() || name.length > 100) problems.push('name must be 1-100 characters');
  let url;
  if (typeof body.url === 'string') url = validateUrl(body.url, problems);
  else problems.push('url is required');

  const target = {
    name: typeof name === 'string' ? name.trim() : name,
    url,
    intervalSeconds: intField(body, 'intervalSeconds', { def: 30, min: 5, max: 3600 }, problems),
    timeoutMs: intField(body, 'timeoutMs', { def: 3000, min: 100, max: 30000 }, problems),
    failureThreshold: intField(body, 'failureThreshold', { def: 3, min: 1, max: 10 }, problems),
    recoveryThreshold: intField(body, 'recoveryThreshold', { def: 2, min: 1, max: 10 }, problems),
  };
  // A check that can run longer than its interval would pile up on itself.
  if (target.timeoutMs >= target.intervalSeconds * 1000) problems.push('timeoutMs must be shorter than intervalSeconds');
  if (problems.length) throw new HttpError(400, 'validation failed', problems);
  return target;
}

export function targetsRouter(store, { policy, maxTargets = 100 } = {}) {
  const router = Router();

  router.get('/', async (req, res) => {
    res.json(await store.list());
  });

  router.post('/', async (req, res) => {
    const input = validateNewTarget(req.body);
    // SSRF policy: refuse internal addresses up front with a clear message. (The worker checks again at
    // connect time, because DNS answers can change after registration.)
    await policy?.check(input.url).catch(err => {
      throw new HttpError(400, 'validation failed', [`url is not allowed: ${err.message}`]);
    });
    // Every target costs a check every few seconds. A cap keeps one user (or one script) from turning
    // the worker into a request cannon.
    if ((await store.count()) >= maxTargets) {
      throw new HttpError(409, `target limit reached (${maxTargets}); delete one first`);
    }
    const target = await store.create(input);
    res.status(201).location(`/api/targets/${target.id}`).json(target);
  });

  router.get('/:id', async (req, res) => {
    const target = await store.get(parseId(req.params.id));
    if (!target) throw new HttpError(404, `target ${req.params.id} not found`);
    res.json(target);
  });

  // Only "enabled" is editable for now: pause monitoring during a planned maintenance window.
  router.patch('/:id', async (req, res) => {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
    const target = await store.setEnabled(parseId(req.params.id), enabled);
    if (!target) throw new HttpError(404, `target ${req.params.id} not found`);
    res.json(target);
  });

  router.delete('/:id', async (req, res) => {
    const deleted = await store.remove(parseId(req.params.id));
    if (!deleted) throw new HttpError(404, `target ${req.params.id} not found`);
    res.status(204).end();
  });

  router.get('/:id/checks', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 500);   // always cap list endpoints
    res.json(await store.checks(parseId(req.params.id), limit));
  });

  return router;
}
