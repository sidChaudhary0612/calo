import { Injectable, inject, signal } from '@angular/core';
import { RiderLocation } from '../models/rider.model';
import { DataBusService } from './data-bus.service';

export interface EmergencyAlert {
  id:        string;
  riderId:   string;
  riderName: string;
  type:      'sos' | 'rider_down' | 'mechanical' | 'medical';
  location:  RiderLocation;
  timestamp: Date;
  resolved:  boolean;
}

@Injectable({ providedIn: 'root' })
export class EmergencyService {
  readonly activeAlerts = signal<EmergencyAlert[]>([]);
  readonly sosSent      = signal(false);
  readonly sosCountdown = signal(0);

  private _countdownRef: ReturnType<typeof setInterval> | null = null;
  private _bus = inject(DataBusService);
  private _teardown: (() => void) | null = null;

  constructor() {
    this._teardown = this._bus.register('sos', (payload) => {
      try {
        const data = JSON.parse(atob(payload));
        const alert: EmergencyAlert = {
          id:        data.id        ?? 'sos-' + Date.now(),
          riderId:   data.riderId   ?? 'unknown',
          riderName: data.riderName ?? 'Unknown Rider',
          type:      data.type      ?? 'sos',
          location:  data.location  ?? { lat: 0, lng: 0, timestamp: Date.now() },
          timestamp: new Date(data.timestamp ?? Date.now()),
          resolved:  false,
        };
        // Avoid duplicate IDs
        this.activeAlerts.update(a => {
          if (a.some(x => x.id === alert.id)) return a;
          return [alert, ...a];
        });
      } catch { /* malformed */ }
    });
  }

  triggerSOS(location: RiderLocation | null): void {
    this.sosCountdown.set(5);
    this._countdownRef = setInterval(() => {
      const val = this.sosCountdown() - 1;
      this.sosCountdown.set(val);
      if (val <= 0) {
        this._clearCountdown();
        this._broadcastSOS(location);
      }
    }, 1000);
  }

  cancelSOS(): void {
    this._clearCountdown();
    this.sosCountdown.set(0);
  }

  sendQuickAlert(type: EmergencyAlert['type'], location: RiderLocation | null): void {
    const alert: EmergencyAlert = {
      id:        type + '-' + Date.now(),
      riderId:   'self',
      riderName: 'You',
      type,
      location:  location ?? { lat: 0, lng: 0, timestamp: Date.now() },
      timestamp: new Date(),
      resolved:  false,
    };
    this.activeAlerts.update(a => [alert, ...a]);
    this._bus.send('sos', {
      id:        alert.id,
      riderId:   alert.riderId,
      riderName: alert.riderName,
      type:      alert.type,
      location:  alert.location,
      timestamp: alert.timestamp.getTime(),
    });
  }

  resolveAlert(id: string): void {
    this.activeAlerts.update(alerts =>
      alerts.map(a => a.id === id ? { ...a, resolved: true } : a)
    );
  }

  simulateIncomingAlert(): void {
    const alert: EmergencyAlert = {
      id:        'alert-' + Date.now(),
      riderId:   'r4',
      riderName: 'Lisa Park',
      type:      'rider_down',
      location:  { lat: 37.7800, lng: -122.4150, timestamp: Date.now() },
      timestamp: new Date(),
      resolved:  false,
    };
    this.activeAlerts.update(a => [alert, ...a]);
  }

  private _broadcastSOS(location: RiderLocation | null): void {
    this.sosSent.set(true);
    const alert: EmergencyAlert = {
      id:        'sos-' + Date.now(),
      riderId:   'self',
      riderName: 'You',
      type:      'sos',
      location:  location ?? { lat: 0, lng: 0, timestamp: Date.now() },
      timestamp: new Date(),
      resolved:  false,
    };
    this.activeAlerts.update(a => [alert, ...a]);
    this._bus.send('sos', {
      id:        alert.id,
      riderId:   alert.riderId,
      riderName: alert.riderName,
      type:      alert.type,
      location:  alert.location,
      timestamp: alert.timestamp.getTime(),
    });
  }

  private _clearCountdown(): void {
    if (this._countdownRef) {
      clearInterval(this._countdownRef);
      this._countdownRef = null;
    }
  }

  ngOnDestroy(): void {
    this._clearCountdown();
    this._teardown?.();
  }
}
