import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';
import { TargetForm, timeoutBelowInterval } from './target-form';

describe('timeoutBelowInterval', () => {
  const group = (intervalSeconds: number, timeoutMs: number) =>
    new FormGroup({ intervalSeconds: new FormControl(intervalSeconds), timeoutMs: new FormControl(timeoutMs) });

  it('accepts a timeout shorter than the interval', () => {
    expect(timeoutBelowInterval(group(5, 4999))).toBeNull();
  });

  it('rejects a timeout equal to or longer than the interval', () => {
    expect(timeoutBelowInterval(group(5, 5000))).toEqual({ timeoutTooLong: true });
  });
});

describe('TargetForm', () => {
  let fixture: ComponentFixture<TargetForm>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  function fill(values: Record<string, string>) {
    for (const [name, value] of Object.entries(values)) {
      const input = el().querySelector<HTMLInputElement>(`[formControlName=${name}]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
  }
  const submit = () => el().querySelector('form')!.dispatchEvent(new Event('submit'));

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    fixture = TestBed.createComponent(TargetForm);
    http = TestBed.inject(HttpTestingController);
    await fixture.whenStable();
  });
  afterEach(() => http.verify());

  it('does not call the API while the form is invalid, and shows the errors', async () => {
    fill({ name: '', url: 'ftp://nope', intervalSeconds: '5', timeoutMs: '8000' });
    submit();
    await fixture.whenStable();
    http.expectNone('/api/targets');
    expect(el().textContent).toContain('Must start with http');
    expect(el().textContent).toContain('Timeout must be shorter');
  });

  // Regression test for the Lesson 8 bug: with zoneless change detection, plain fields set in an
  // HTTP callback never re-rendered, leaving the button stuck on "Adding…" after a 409.
  it('shows a server error and re-enables the button after a 409', async () => {
    fill({ name: 'search', url: 'http://search.local', intervalSeconds: '30', timeoutMs: '2000' });
    submit();
    await fixture.whenStable().catch(() => {});        // request in flight
    const button = () => el().querySelector('button')!;
    http.expectOne('/api/targets').flush(
      { error: 'already exists', details: ['a target with this name already exists'] },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();
    expect(el().querySelector('[role=alert]')?.textContent).toContain('a target with this name already exists');
    expect(button().disabled).toBe(false);
    expect(button().textContent).toContain('Add target');
  });

  it('emits created and clears the form on success', async () => {
    let created: unknown;
    fixture.componentInstance.created.subscribe(t => (created = t));
    fill({ name: 'search', url: 'http://search.local', intervalSeconds: '30', timeoutMs: '2000' });
    submit();
    const req = http.expectOne('/api/targets');
    expect(req.request.body).toEqual({ name: 'search', url: 'http://search.local', intervalSeconds: 30, timeoutMs: 2000 });
    req.flush({ id: 1, name: 'search' });
    await fixture.whenStable();
    expect(created).toEqual({ id: 1, name: 'search' });
    expect(el().querySelector<HTMLInputElement>('[formControlName=name]')!.value).toBe('');
  });
});
