import { Routes } from '@angular/router';
import { Dashboard } from './dashboard/dashboard';

export const routes: Routes = [
  { path: '', component: Dashboard, title: 'ClusterWatch' },
  // Lazy-loaded: this page's code is a separate file, downloaded only when someone opens a target.
  { path: 'targets/:id', loadComponent: () => import('./target-detail/target-detail').then(m => m.TargetDetail), title: 'Target · ClusterWatch' },
  { path: '**', redirectTo: '' },
];
