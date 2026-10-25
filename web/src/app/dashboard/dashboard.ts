import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, filter, forkJoin, map, merge, Observable, of, scan, Subject, switchMap, timer } from 'rxjs';
import { ApiService, describeError } from '../api.service';
import { Alert, Target } from '../models';
import { TargetForm } from '../target-form/target-form';

export const POLL_MS = 5000;

interface View {
  targets: Target[];
  alerts: Alert[];
  error: string | null;      // set when the LATEST refresh failed
  updatedAt: Date | null;    // time of the last SUCCESSFUL refresh
}

@Component({
  selector: 'app-dashboard',
  imports: [DatePipe, RouterLink, TargetForm],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class Dashboard {
  private readonly api = inject(ApiService);
  private readonly refresh$ = new Subject<void>();   // "refresh now", e.g. after the user changes something
  protected readonly actionError = signal<string | null>(null);   // a signal: see target-form.ts

  // The whole polling pipeline, read top to bottom:
  //  1. tick every 5 s (or on demand), but skip ticks while the tab is hidden: 50 forgotten
  //     background tabs shouldn't hammer the API.
  //  2. switchMap: if a refresh is still in flight when the next one starts, CANCEL the old one,
  //     so a slow response can never overwrite newer data (out-of-order responses).
  //  3. forkJoin: fetch targets and alerts in parallel, continue when both arrive.
  //  4. catchError INSIDE switchMap: one failed refresh becomes data, it doesn't kill the polling forever.
  //  5. scan: on failure keep the last good data and just flag the error (stale-while-error).
  private readonly view = toSignal(
    merge(timer(0, POLL_MS).pipe(filter(() => !document.hidden)), this.refresh$).pipe(
      switchMap(() =>
        forkJoin({ targets: this.api.targets(), alerts: this.api.openAlerts() }).pipe(
          map(data => ({ ...data, error: null, updatedAt: new Date() }) as View),
          catchError(err => of({ error: describeError(err) } as Partial<View>)),
        ),
      ),
      scan((prev: View, next: Partial<View>) => (next.updatedAt ? (next as View) : { ...prev, error: next.error ?? null }),
        { targets: [], alerts: [], error: null, updatedAt: null } as View),
    ),
    { initialValue: { targets: [], alerts: [], error: null, updatedAt: null } as View },
  );

  protected readonly targets = computed(() => this.view().targets);
  protected readonly alerts = computed(() => this.view().alerts);
  protected readonly error = computed(() => this.view().error);
  protected readonly updatedAt = computed(() => this.view().updatedAt);
  protected readonly loading = computed(() => !this.view().updatedAt && !this.view().error);
  protected readonly downCount = computed(() => this.targets().filter(t => t.state === 'down').length);

  protected refresh(): void {
    this.refresh$.next();
  }

  protected toggle(target: Target): void {
    this.run(this.api.setEnabled(target.id, !target.enabled));
  }

  protected remove(target: Target): void {
    if (confirm(`Stop monitoring "${target.name}"? Its check history will be deleted.`)) {
      this.run(this.api.deleteTarget(target.id));
    }
  }

  protected resolve(alert: Alert): void {
    this.run(this.api.resolveAlert(alert.id));
  }

  // Do a mutation, then refresh. Errors go to a banner instead of disappearing into the console.
  private run(request: Observable<unknown>): void {
    this.actionError.set(null);
    request.subscribe({
      next: () => this.refresh(),
      error: err => this.actionError.set(describeError(err)),
    });
  }
}
