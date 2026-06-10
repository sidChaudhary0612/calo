import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { NavShellComponent } from './shared/components/nav-shell/nav-shell.component';
import { SettingsService } from './core/services/settings.service';

function profileGuard(): boolean {
  const settings = inject(SettingsService);
  const router   = inject(Router);
  if (settings.hasProfile) return true;
  router.navigate(['/onboarding']);
  return false;
}

function onboardingGuard(): boolean {
  const settings = inject(SettingsService);
  const router   = inject(Router);
  if (!settings.hasProfile) return true;
  router.navigate(['/dashboard']);
  return false;
}

export const routes: Routes = [
  {
    path: 'onboarding',
    canActivate: [onboardingGuard],
    loadComponent: () => import('./features/onboarding/onboarding.component').then(m => m.OnboardingComponent),
  },
  {
    path: '',
    component: NavShellComponent,
    canActivate: [profileGuard],
    children: [
      { path: '',           redirectTo: 'dashboard', pathMatch: 'full' },
      { path: 'dashboard',  loadComponent: () => import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent) },
      { path: 'discovery',  loadComponent: () => import('./features/discovery/discovery.component').then(m => m.DiscoveryComponent) },
      { path: 'groups',     loadComponent: () => import('./features/groups/groups.component').then(m => m.GroupsComponent) },
      { path: 'ptt',        loadComponent: () => import('./features/ptt/ptt.component').then(m => m.PttComponent) },
      { path: 'awareness',  loadComponent: () => import('./features/awareness/awareness.component').then(m => m.AwarenessComponent) },
      { path: 'navigation', loadComponent: () => import('./features/navigation/navigation.component').then(m => m.NavigationComponent) },
      { path: 'music',      loadComponent: () => import('./features/music/music.component').then(m => m.MusicComponent) },
      { path: 'emergency',  loadComponent: () => import('./features/emergency/emergency.component').then(m => m.EmergencyComponent) },
    ],
  },
  { path: '**', redirectTo: '' },
];
