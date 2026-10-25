import { HttpError } from '../errors.js';

export function parseId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, `invalid id "${raw}"`);
  return id;
}

// Optional integer field with a default and an allowed range. Pushes a message to `problems` if invalid.
export function intField(body, name, { def, min, max }, problems) {
  const value = body[name] ?? def;
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
