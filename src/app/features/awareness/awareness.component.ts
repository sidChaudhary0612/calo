import { Component, computed, effect, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { MeshService } from '../../core/services/mesh.service';
import { LocationService } from '../../core/services/location.service';
import { MapService } from '../../core/services/map.service';
import { Rider } from '../../core/models/rider.model';

@Component({
  selector: 'app-awareness',
  standalone: true,
  imports: [],
  providers: [MapService],
  templateUrl: './awareness.component.html',
  styleUrl: './awareness.component.scss',
})
export class AwarenessComponent implements OnInit, OnDestroy {
  @ViewChild('mapContainer', { static: true }) mapContainerRef!: ElementRef<HTMLDivElement>;

  readonly members = computed(() => this.mesh.getGroupMembers());
  readonly inGroup = computed(() => !!this.mesh.activeGroup());
  readonly speed   = computed(() => this.loc.speed());
  readonly bearing = computed(() => this.loc.bearing());

  selectedRider: Rider | null = null;

  constructor(
    readonly mesh: MeshService,
    readonly loc: LocationService,
    readonly mapSvc: MapService,
  ) {
    effect(() => {
      const l = this.loc.currentLocation();
      if (l) this.mapSvc.updateSelfLocation(l);
    });

    effect(() => {
      const members = this.members();
      members.forEach(m => {
        const peerLoc = this.mesh.getRiderLocation(m.id);
        if (peerLoc) {
          this.mapSvc.updateRiderMarker(m.id, m.name, m.avatarInitials, peerLoc);
        }
      });
    });
  }

  async ngOnInit(): Promise<void> {
    await this.loc.start();
    // Wait for GPS fix (up to 5s), then init map at real position
    this._initMapWhenReady(0);
  }

  private _initMapWhenReady(attempts: number): void {
    const loc = this.loc.currentLocation();
    if (loc) {
      this.mapSvc.init(this.mapContainerRef.nativeElement, [loc.lng, loc.lat], 14);
      this.mapSvc.updateSelfLocation(loc);
    } else if (attempts < 25) {
      setTimeout(() => this._initMapWhenReady(attempts + 1), 200);
    } else {
      this.mapSvc.init(this.mapContainerRef.nativeElement, [0, 0], 2);
    }
  }

  ngOnDestroy(): void {
    this.mapSvc.destroy();
  }

  selectRider(r: Rider): void {
    this.selectedRider = this.selectedRider?.id === r.id ? null : r;
    if (this.selectedRider) {
      const peerLoc = this.mesh.getRiderLocation(r.id);
      if (peerLoc) {
        this.mapSvc.flyTo(peerLoc.lng, peerLoc.lat, 15);
      }
    }
  }

  getRiderDistance(r: Rider): number | undefined {
    const selfLoc = this.loc.currentLocation();
    const peerLoc = this.mesh.getRiderLocation(r.id);
    if (!selfLoc || !peerLoc) return undefined;
    return this._haversineM(selfLoc.lat, selfLoc.lng, peerLoc.lat, peerLoc.lng);
  }

  bearingLabel(deg: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
  }

  formatDist(m: number): string {
    return m < 1000 ? Math.round(m) + 'm' : (m / 1000).toFixed(1) + 'km';
  }

  private _haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
