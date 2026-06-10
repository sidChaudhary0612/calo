import { Injectable, inject, signal } from '@angular/core';
import { Geolocation } from '@capacitor/geolocation';
import { RiderLocation } from '../models/rider.model';
import { DataBusService } from './data-bus.service';
import { MeshService } from './mesh.service';

@Injectable({ providedIn: 'root' })
export class LocationService {
  readonly currentLocation = signal<RiderLocation | null>(null);
  readonly isTracking      = signal(false);
  readonly speed           = signal(0);
  readonly bearing         = signal(0);

  private _watchId: string | null = null;
  private _bus  = inject(DataBusService);
  private _mesh = inject(MeshService);

  async start(): Promise<void> {
    if (this.isTracking()) return;

    try {
      const perm = await Geolocation.requestPermissions();
      if (perm.location === 'denied') return;
    } catch {
      // Web — proceed anyway
    }

    // Set a demo position quickly so the map has something to show while waiting for GPS.
    // Will be overwritten by real GPS once it arrives.
    const demoLoc: RiderLocation = { lat: 37.7749, lng: -122.4194, timestamp: Date.now() };
    const fallbackTimer = setTimeout(() => {
      if (!this.currentLocation()) {
        this.currentLocation.set(demoLoc);
        this._broadcast(demoLoc);
      }
    }, 1500);

    try {
      this._watchId = await Geolocation.watchPosition(
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
        (pos, err) => {
          clearTimeout(fallbackTimer);
          if (err || !pos) {
            if (!this.currentLocation()) {
              this.currentLocation.set(demoLoc);
              this._broadcast(demoLoc);
            }
            return;
          }
          const loc: RiderLocation = {
            lat:       pos.coords.latitude,
            lng:       pos.coords.longitude,
            altitude:  pos.coords.altitude ?? undefined,
            accuracy:  pos.coords.accuracy,
            timestamp: pos.timestamp,
          };
          this.currentLocation.set(loc);
          this.speed.set(Math.round((pos.coords.speed ?? 0) * 3.6));
          this.bearing.set(Math.round(pos.coords.heading ?? 0));
          this._broadcast(loc);
        }
      );
      this.isTracking.set(true);
    } catch {
      clearTimeout(fallbackTimer);
      this.currentLocation.set(demoLoc);
      this._broadcast(demoLoc);
    }
  }

  async stop(): Promise<void> {
    if (this._watchId !== null) {
      await Geolocation.clearWatch({ id: this._watchId });
      this._watchId = null;
    }
    this.isTracking.set(false);
  }

  private _broadcast(loc: RiderLocation): void {
    this._mesh.updateSelfLocation(loc);
    this._bus.send('location', {
      lat:      loc.lat,
      lng:      loc.lng,
      speed:    this.speed(),
      bearing:  this.bearing(),
      timestamp: loc.timestamp,
    });
  }
}
