// Pure function: (current target health, did this check pass?) → new health + what to do.
// No DB, no network, no clock, so it is trivially unit-testable. Keep business rules in code like this.
//
// Hysteresis: it takes `failureThreshold` failures IN A ROW to go down, and `recoveryThreshold`
// successes IN A ROW to come back up. A flapping target (fail, ok, fail, ok...) never pages anyone.
export function evaluate(target, ok) {
  const consecutiveFailures = ok ? 0 : target.consecutiveFailures + 1;
  const consecutiveSuccesses = ok ? target.consecutiveSuccesses + 1 : 0;
  let state = target.state;
  let action = null;

  if (!ok && state !== 'down' && consecutiveFailures >= target.failureThreshold) {
    state = 'down';
    action = 'open';
  } else if (ok && state === 'down' && consecutiveSuccesses >= target.recoveryThreshold) {
    state = 'up';
    action = 'resolve';
  } else if (ok && state === 'unknown') {
    state = 'up';                     // brand-new target answered: nothing to resolve
  }

  return { state, consecutiveFailures, consecutiveSuccesses, action };
}
