import { fetch } from 'undici';

// One HTTP health check. Never throws: every outcome becomes a result object,
// because "the target is broken" is normal data for a monitoring system, not an exception.
// policy (optional): an SSRF policy from ssrf.js; blocked targets fail with "blocked ..." instead of being fetched.
export async function probe(url, { timeoutMs, policy }) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    await policy?.check(url);
    // Without a timeout, a target that accepts the connection but never answers
    // would hang this check (and its worker slot) forever.
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'ClusterWatch/1.0' },
      dispatcher: policy?.dispatcher,
      // Don't follow redirects: a public target could answer "302 → http://169.254.169.254/" and walk the
      // worker past the SSRF checks. A 3xx means the service is up; that's all a health check needs.
      redirect: 'manual',
    });
    await res.body?.cancel();            // we only need the status; don't download a 50 MB body
    const ok = res.status >= 200 && res.status < 400;
    return { ok, statusCode: res.status, latencyMs: elapsed(), error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const cause = err.code === 'EBLOCKED' ? err : err.cause;
    const error = err.name === 'TimeoutError'
      ? `timeout after ${timeoutMs}ms`
      : cause?.code === 'EBLOCKED'
        ? cause.message
        : cause?.code ?? err.message;    // e.g. ECONNREFUSED, ENOTFOUND, CERT_HAS_EXPIRED
    return { ok: false, statusCode: null, latencyMs: elapsed(), error };
  }
}
