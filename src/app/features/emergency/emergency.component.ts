import { Component, computed, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { EmergencyService, EmergencyAlert } from '../../core/services/emergency.service';
import { LocationService } from '../../core/services/location.service';

@Component({
  selector: 'app-emergency',
  imports: [DatePipe],
  templateUrl: './emergency.component.html',
  styleUrl: './emergency.component.scss',
})
export class EmergencyComponent {
  readonly alerts       = computed(() => this.emergency.activeAlerts());
  readonly sosSent      = computed(() => this.emergency.sosSent());
  readonly countdown    = computed(() => this.emergency.sosCountdown());
  readonly isCounting   = computed(() => this.countdown() > 0);
  readonly activeAlerts = computed(() => this.alerts().filter(a => !a.resolved));

  holding = signal(false);

  constructor(
    readonly emergency: EmergencyService,
    readonly loc: LocationService,
  ) {}

  sosHoldStart(): void {
    this.holding.set(true);
    this.emergency.triggerSOS(this.loc.currentLocation());
  }

  sosHoldEnd(): void {
    if (this.isCounting()) {
      this.emergency.cancelSOS();
    }
    this.holding.set(false);
  }

  sendQuickAlert(type: string): void {
    this.emergency.sendQuickAlert(type as EmergencyAlert['type'], this.loc.currentLocation());
  }

  resolve(alert: EmergencyAlert): void {
    this.emergency.resolveAlert(alert.id);
  }

  typeLabel(t: string): string {
    return { sos: 'SOS', rider_down: 'Rider Down', mechanical: 'Mechanical', medical: 'Medical' }[t] ?? t;
  }

  typeClass(t: string): string {
    return { sos: 'red', rider_down: 'red', mechanical: 'orange', medical: 'orange' }[t] ?? 'muted';
  }

  simulate(): void { this.emergency.simulateIncomingAlert(); }
}
