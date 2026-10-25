import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { API_BASE_URL } from './api.service';

const STORAGE_KEY = 'clusterwatch.token';

// sessionStorage, not localStorage: the token disappears when the tab closes, so a shared or stolen
// laptop doesn't keep an admin session forever. (Either is readable by an XSS bug; Angular's template
// escaping and a Content-Security-Policy are the defence there.) Storage can throw in private modes.
function stored(): string | null {
  try { return sessionStorage.getItem(STORAGE_KEY); } catch { return null; }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  readonly token = signal<string | null>(stored());
  readonly signedIn = computed(() => this.token() !== null);

  // Verify the token with the API before trusting it, so a typo fails here and not on the first click.
  signIn(token: string): Observable<void> {
    return this.http
      .post<void>(`${this.base}/session`, {}, { headers: { authorization: `Bearer ${token}` } })
      .pipe(tap(() => this.save(token)));
  }

  signOut(): void {
    this.save(null);
  }

  private save(token: string | null): void {
    this.token.set(token);
    try {
      if (token) sessionStorage.setItem(STORAGE_KEY, token);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch { /* storage unavailable: the session just won't survive a reload */ }
  }
}

// Interceptor: runs for every HttpClient request. Adds the token to writes (reads are public, so the token
// isn't sent where it isn't needed), and signs out if the API says the token is no longer valid.
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const token = auth.token();
  const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const outgoing = token && isWrite && !req.headers.has('authorization')
    ? req.clone({ setHeaders: { authorization: `Bearer ${token}` } })
    : req;
  return next(outgoing).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && outgoing !== req) auth.signOut();
      return throwError(() => err);
    }),
  );
};
