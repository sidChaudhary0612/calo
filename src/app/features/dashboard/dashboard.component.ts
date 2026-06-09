import { Component, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MeshService } from '../../core/services/mesh.service';
import { LocationService } from '../../core/services/location.service';
import { EmergencyService } from '../../core/services/emergency.service';
import { PttService } from '../../core/services/ptt.service';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  readonly group     = computed(() => this.mesh.activeGroup());
  readonly riders    = computed(() => this.mesh.nearbyRiders());
  readonly online    = computed(() => this.riders().filter(r => r.status === 'online').length);
  readonly self      = computed(() => this.mesh.selfRider());
  readonly location  = computed(() => this.location$.currentLocation());
  readonly hasAlert  = computed(() => this.emergency.activeAlerts().some(a => !a.resolved));
  readonly alertCount = computed(() => this.emergency.activeAlerts().filter(a => !a.resolved).length);

  readonly quickActions = [
    { label: 'Find Riders', icon: 'radar', path: '/discovery',  color: 'blue'   },
    { label: 'Start Group', icon: 'group', path: '/groups',     color: 'orange' },
    { label: 'Talk',        icon: 'mic',   path: '/ptt',        color: 'green'  },
    { label: 'Navigate',    icon: 'nav',   path: '/navigation', color: 'purple' },
  ];

  constructor(
    readonly mesh: MeshService,
    readonly location$: LocationService,
    readonly emergency: EmergencyService,
    readonly ptt: PttService,
  ) {
    location$.start();
  }
}
