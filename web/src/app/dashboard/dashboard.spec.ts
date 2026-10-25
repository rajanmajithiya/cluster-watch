import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Dashboard, POLL_MS } from './dashboard';

const target = (id: number, name: string, state: 'up' | 'down') =>
  ({ id, name, state, url: `http://${name}`, enabled: true, lastLatencyMs: 10, lastError: null, lastStatusCode: 200 });

describe('Dashboard', () => {
  let fixture: ComponentFixture<Dashboard>;
  let http: HttpTestingController;
  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  // Answer one polling round (targets + alerts), or fail it with a 503.
  function respond(targets: unknown[] | 'fail', alerts: unknown[] = []) {
    const t = http.expectOne('/api/targets');
    const a = http.expectOne(r => r.url === '/api/alerts');
    if (targets === 'fail') {
      t.flush({ error: 'service temporarily unavailable' }, { status: 503, statusText: 'Service Unavailable' });
      // forkJoin cancels the sibling request as soon as one fails: its result could never be used.
      expect(a.cancelled).toBe(true);
    } else {
      t.flush(targets);
      a.flush(alerts);
    }
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();                                  // we control time, so polling is deterministic
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Dashboard);
    fixture.detectChanges();
    vi.advanceTimersByTime(0);                           // first tick fires immediately
  });
  afterEach(() => vi.useRealTimers());

  it('renders targets and counts what is down', () => {
    respond([target(1, 'api', 'up'), target(2, 'db', 'down')]);
    expect(text()).toContain('api');
    expect(text()).toContain('db');
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('.stat .num')[1].textContent).toBe('1');
  });

  it('keeps the last good data and shows a banner when a refresh fails', () => {
    respond([target(1, 'api', 'up')]);
    vi.advanceTimersByTime(POLL_MS);
    respond('fail');
    expect(text()).toContain('api');                             // stale data still visible
    expect(text()).toContain('service temporarily unavailable');  // ...with an explanation
    vi.advanceTimersByTime(POLL_MS);
    respond([target(1, 'api', 'up')]);                            // and polling recovered by itself
    expect(text()).not.toContain('temporarily unavailable');
  });

  it('does not poll while the browser tab is hidden', () => {
    respond([]);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    vi.advanceTimersByTime(POLL_MS * 3);
    http.expectNone('/api/targets');
  });
});
