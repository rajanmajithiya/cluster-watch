import { Router } from 'express';
import { HttpError } from '../errors.js';

const SEVERITIES = ['info', 'warning', 'critical'];

// Never trust client input: validate type, presence and allowed values.
function validateNewAlert(body) {
  const { pod, reason, severity = 'warning' } = body ?? {};
  const problems = [];
  if (typeof pod !== 'string' || !pod.trim()) problems.push('pod must be a non-empty string');
  if (typeof reason !== 'string' || !reason.trim()) problems.push('reason must be a non-empty string');
  if (!SEVERITIES.includes(severity)) problems.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (problems.length) throw new HttpError(400, 'validation failed', problems);
  return { pod: pod.trim(), reason: reason.trim(), severity };
}

function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, `invalid id "${raw}"`);
  return id;
}

export function alertsRouter(store) {
  const router = Router();

  router.get('/', async (req, res) => {
    const { status } = req.query;
    if (status && !['open', 'resolved'].includes(status)) {
      throw new HttpError(400, 'status must be open or resolved');
    }
    res.json(await store.list({ status }));
  });

  router.get('/:id', async (req, res) => {
    const alert = await store.get(parseId(req.params.id));
    if (!alert) throw new HttpError(404, `alert ${req.params.id} not found`);
    res.json(alert);
  });

  router.post('/', async (req, res) => {
    const alert = await store.create(validateNewAlert(req.body));
    res.status(201).location(`/api/alerts/${alert.id}`).json(alert);
  });

  // PATCH, not DELETE: in monitoring you keep history, you just change state.
  router.patch('/:id/resolve', async (req, res) => {
    const alert = await store.resolve(parseId(req.params.id));
    if (!alert) throw new HttpError(404, `alert ${req.params.id} not found`);
    res.json(alert);
  });

  return router;
}
