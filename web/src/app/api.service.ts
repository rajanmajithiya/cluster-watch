import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { Alert, Check, NewTarget, Target } from './models';

// Where the API lives. Injected (not hard-coded) so tests and environments can change it.
// It is RELATIVE ('/api'): the browser calls the same origin that served the page, and the dev proxy
// (proxy.conf.json) or nginx forwards it to the API. Same origin = no CORS. See Lesson 8 notes.
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', { factory: () => '/api' });

// One place for every HTTP call: components never build URLs themselves.
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  targets(): Observable<Target[]> {
    return this.http.get<Target[]>(`${this.base}/targets`);
  }

  target(id: number): Observable<Target> {
    return this.http.get<Target>(`${this.base}/targets/${id}`);
  }

  checks(id: number, limit = 50): Observable<Check[]> {
    return this.http.get<Check[]>(`${this.base}/targets/${id}/checks`, { params: { limit } });
  }

  createTarget(target: NewTarget): Observable<Target> {
    return this.http.post<Target>(`${this.base}/targets`, target);
  }

  setEnabled(id: number, enabled: boolean): Observable<Target> {
    return this.http.patch<Target>(`${this.base}/targets/${id}`, { enabled });
  }

  deleteTarget(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/targets/${id}`);
  }

  openAlerts(): Observable<Alert[]> {
    return this.http.get<Alert[]>(`${this.base}/alerts`, { params: { status: 'open' } });
  }

  resolveAlert(id: number): Observable<Alert> {
    return this.http.patch<Alert>(`${this.base}/alerts/${id}/resolve`, {});
  }
}

// Turn any HTTP failure into a sentence a human can act on.
export function describeError(err: unknown): string {
  if (!(err instanceof HttpErrorResponse)) return 'Unexpected error';
  if (err.status === 0) return 'Cannot reach the API (network error, CORS, or server down)';
  const body = err.error as { error?: string; details?: string[] } | null;
  const detail = body?.details?.filter(Boolean).join('; ');
  return [body?.error ?? `HTTP ${err.status}`, detail].filter(Boolean).join(': ');
}
