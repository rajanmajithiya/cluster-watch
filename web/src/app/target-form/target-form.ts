import { Component, inject, output, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { ApiService, describeError } from '../api.service';
import { Target } from '../models';

// Same rule the API enforces. Client-side validation is for the USER (instant feedback);
// server-side validation is for SECURITY (anyone can bypass the browser with curl). You need both.
export function timeoutBelowInterval(group: AbstractControl): ValidationErrors | null {
  const { intervalSeconds, timeoutMs } = group.value as { intervalSeconds: number; timeoutMs: number };
  return timeoutMs >= intervalSeconds * 1000 ? { timeoutTooLong: true } : null;
}

@Component({
  selector: 'app-target-form',
  imports: [ReactiveFormsModule],
  templateUrl: './target-form.html',
  styleUrl: './target-form.css',
})
export class TargetForm {
  private readonly api = inject(ApiService);
  readonly created = output<Target>();

  // Signals, not plain fields: this app is ZONELESS (Angular 21+ default). Angular re-renders when a signal
  // changes; a plain field set inside an HTTP callback would change silently and the screen would never update.
  protected readonly saving = signal(false);
  protected readonly serverError = signal<string | null>(null);

  protected readonly form = inject(FormBuilder).nonNullable.group(
    {
      name: ['', [Validators.required, Validators.maxLength(100)]],
      url: ['', [Validators.required, Validators.pattern(/^https?:\/\/.+/i)]],
      intervalSeconds: [30, [Validators.required, Validators.min(5), Validators.max(3600)]],
      timeoutMs: [3000, [Validators.required, Validators.min(100), Validators.max(30000)]],
    },
    { validators: timeoutBelowInterval },
  );

  protected invalid(name: keyof typeof this.form.controls): boolean {
    const c = this.form.controls[name];
    return c.invalid && (c.touched || c.dirty);
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();       // reveal every error at once
      return;
    }
    this.saving.set(true);                 // disables the button: no double-submit → no duplicate target
    this.serverError.set(null);
    this.api.createTarget(this.form.getRawValue()).subscribe({
      next: target => {
        this.saving.set(false);
        this.form.reset();
        this.created.emit(target);
      },
      error: err => {
        this.saving.set(false);
        this.serverError.set(describeError(err));   // e.g. 409 "already exists", or the SSRF guard's 400
      },
    });
  }
}
