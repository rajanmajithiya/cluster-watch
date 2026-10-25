// Shapes of the JSON the API returns. TypeScript checks every template and service against these,
// so a renamed field breaks the BUILD, not the user's screen at 3 a.m.
export type TargetState = 'unknown' | 'up' | 'down';

export interface Target {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  state: TargetState;
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  lastStatusCode: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  createdAt: string;
}

export interface NewTarget {
  name: string;
  url: string;
  intervalSeconds: number;
  timeoutMs: number;
}

export interface Alert {
  id: number;
  pod: string;
  reason: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'resolved';
  targetId: number | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Check {
  id: number;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
  checkedAt: string;
}
