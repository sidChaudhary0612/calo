import { Component, computed } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MeshService } from '../../../core/services/mesh.service';
import { EmergencyService } from '../../../core/services/emergency.service';

interface NavItem {
  path:  string;
  label: string;
  icon:  string;
}

@Component({
  selector: 'app-nav-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './nav-shell.component.html',
  styleUrl: './nav-shell.component.scss',
})
export class NavShellComponent {
  readonly navItems: NavItem[] = [
    { path: '/dashboard',  label: 'Home',  icon: 'home' },
    { path: '/ptt',        label: 'Talk',  icon: 'mic' },
    { path: '/awareness',  label: 'Map',   icon: 'map' },
    { path: '/emergency',  label: 'SOS',   icon: 'sos' },
  ];

  readonly hasAlert = computed(() =>
    this.emergency.activeAlerts().some(a => !a.resolved)
  );

  readonly inGroup = computed(() => !!this.mesh.activeGroup());

  constructor(
    private mesh: MeshService,
    private emergency: EmergencyService,
  ) {}
}
