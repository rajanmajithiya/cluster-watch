// One HTTP health check. Never throws: every outcome becomes a result object,
// because "the target is broken" is normal data for a monitoring system, not an exception.
export async function probe(url, { timeoutMs }) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  try {
    // Without a timeout, a target that accepts the connection but never answers
    // would hang this check (and its worker slot) forever.
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'ClusterWatch/1.0' },
    });
    await res.body?.cancel();            // we only need the status; don't download a 50 MB body
    const ok = res.status >= 200 && res.status < 400;
    return { ok, statusCode: res.status, latencyMs: elapsed(), error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    const error = err.name === 'TimeoutError'
      ? `timeout after ${timeoutMs}ms`
      : err.cause?.code ?? err.message;  // e.g. ECONNREFUSED, ENOTFOUND, CERT_HAS_EXPIRED
    return { ok: false, statusCode: null, latencyMs: elapsed(), error };
  }
}
