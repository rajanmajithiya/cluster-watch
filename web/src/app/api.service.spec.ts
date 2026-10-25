import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ApiService, describeError } from './api.service';

describe('ApiService', () => {
  let api: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    // HttpTestingController replaces the real network: we assert on the requests and script the responses.
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());   // fail if a test left an unexpected request behind

  it('uses relative /api URLs (same origin → no CORS)', () => {
    api.targets().subscribe();
    expect(http.expectOne('/api/targets').request.method).toBe('GET');
  });

  it('asks only for open alerts', () => {
    api.openAlerts().subscribe();
    const req = http.expectOne(r => r.url === '/api/alerts');
    expect(req.request.params.get('status')).toBe('open');
  });

  it('resolves with PATCH', () => {
    api.resolveAlert(7).subscribe();
    expect(http.expectOne('/api/alerts/7/resolve').request.method).toBe('PATCH');
  });
});

describe('describeError', () => {
  it('explains network/CORS failures (status 0)', () => {
    expect(describeError(new HttpErrorResponse({ status: 0 }))).toMatch(/Cannot reach the API/);
  });

  it('shows the API message and details', () => {
    const err = new HttpErrorResponse({ status: 409, error: { error: 'already exists', details: ['a target with this name already exists'] } });
    expect(describeError(err)).toBe('already exists: a target with this name already exists');
  });

  it('falls back to the status code', () => {
    expect(describeError(new HttpErrorResponse({ status: 502, error: '<html>Bad Gateway</html>' }))).toBe('HTTP 502');
  });
});
