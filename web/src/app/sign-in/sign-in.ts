import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { describeError } from '../api.service';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-sign-in',
  imports: [FormsModule],
  template: `
    @if (auth.signedIn()) {
      <span class="who">Admin</span>
      <button type="button" (click)="auth.signOut()">Sign out</button>
    } @else if (open()) {
      <form (ngSubmit)="submit()" class="signin">
        <!-- type=password: the token isn't shown on screen or kept by autocomplete -->
        <input type="password" name="token" [(ngModel)]="token" placeholder="Admin token" autocomplete="off" aria-label="Admin token" required />
        <button type="submit" [disabled]="busy() || !token">{{ busy() ? 'Checking…' : 'Sign in' }}</button>
        <button type="button" (click)="open.set(false)">Cancel</button>
        @if (error()) { <span class="err" role="alert">{{ error() }}</span> }
      </form>
    } @else {
      <span class="who muted">Read-only</span>
      <button type="button" (click)="open.set(true)">Sign in</button>
    }
  `,
  styles: `
    :host { display: inline-flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
    .signin { display: inline-flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
    .signin input { width: 12rem; }
    .err { color: var(--bad); }
    .who { font-size: .85rem; }
  `,
})
export class SignIn {
  protected readonly auth = inject(AuthService);
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected token = '';

  protected submit(): void {
    this.busy.set(true);
    this.error.set(null);
    this.auth.signIn(this.token.trim()).subscribe({
      next: () => {
        this.busy.set(false);
        this.open.set(false);
        this.token = '';
      },
      error: err => {
        this.busy.set(false);
        this.error.set(describeError(err));
      },
    });
  }
}
