import { DatePipe } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of, switchMap } from 'rxjs';
import { ApiService, describeError } from '../api.service';
import { Check, Target } from '../models';

// Route /targets/:id. The `id` input is filled from the URL (withComponentInputBinding in app.config.ts).
@Component({
  selector: 'app-target-detail',
  imports: [DatePipe, RouterLink],
  templateUrl: './target-detail.html',
  styleUrl: './target-detail.css',
})
export class TargetDetail {
  private readonly api = inject(ApiService);
  readonly id = input.required<string>();

  private readonly data = toSignal(
    toObservable(this.id).pipe(
      switchMap(id =>
        forkJoin({ target: this.api.target(+id), checks: this.api.checks(+id, 100) }).pipe(
          map(d => ({ ...d, error: null as string | null })),
          catchError(err => of({ target: null as Target | null, checks: [] as Check[], error: describeError(err) })),
        ),
      ),
    ),
  );

  protected readonly target = computed(() => this.data()?.target ?? null);
  protected readonly checks = computed(() => this.data()?.checks ?? []);
  protected readonly error = computed(() => this.data()?.error ?? null);
  protected readonly uptime = computed(() => {
    const c = this.checks();
    return c.length ? Math.round((100 * c.filter(x => x.ok).length) / c.length) : null;
  });
  // Bar heights relative to the slowest check in view.
  protected readonly maxLatency = computed(() => Math.max(1, ...this.checks().map(c => c.latencyMs)));
}
