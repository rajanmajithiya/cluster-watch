import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService, authInterceptor } from './auth.service';

describe('AuthService + authInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let auth: AuthService;

  beforeEach(() => {
    sessionStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });
  afterEach(() => backend.verify());

  function signIn(token = 'secret') {
    auth.signIn(token).subscribe();
    backend.expectOne('/api/session').flush(null, { status: 204, statusText: 'No Content' });
  }

  it('starts signed out and sends no token', () => {
    http.post('/api/targets', {}).subscribe();
    expect(backend.expectOne('/api/targets').request.headers.has('authorization')).toBe(false);
    expect(auth.signedIn()).toBe(false);
  });

  it('verifies the token with the API, then remembers it for this tab', () => {
    signIn();
    expect(auth.signedIn()).toBe(true);
    expect(sessionStorage.getItem('clusterwatch.token')).toBe('secret');
  });

  it('a rejected token is not saved', () => {
    auth.signIn('wrong').subscribe({ error: () => {} });
    backend.expectOne('/api/session').flush({ error: 'authentication required' }, { status: 401, statusText: 'Unauthorized' });
    expect(auth.signedIn()).toBe(false);
  });

  it('adds the token to writes only; reads stay anonymous', () => {
    signIn();
    http.patch('/api/alerts/1/resolve', {}).subscribe();
    http.get('/api/targets').subscribe();
    expect(backend.expectOne('/api/alerts/1/resolve').request.headers.get('authorization')).toBe('Bearer secret');
    expect(backend.expectOne('/api/targets').request.headers.has('authorization')).toBe(false);
  });

  it('a 401 on an authenticated write signs you out (token revoked or rotated)', () => {
    signIn();
    http.delete('/api/targets/3').subscribe({ error: () => {} });
    backend.expectOne('/api/targets/3').flush({ error: 'authentication required' }, { status: 401, statusText: 'Unauthorized' });
    expect(auth.signedIn()).toBe(false);
    expect(sessionStorage.getItem('clusterwatch.token')).toBeNull();
  });
});
