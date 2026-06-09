import { Component, computed, effect, ElementRef, OnDestroy, OnInit, signal, ViewChild, AfterViewInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MapService } from '../../core/services/map.service';
import { LocationService } from '../../core/services/location.service';
import { RiderLocation } from '../../core/models/rider.model';

interface RouteItem {
  id:      string;
  name:    string;
  km:      number;
  min:     number;
  saved:   boolean;
  coords:  [number, number][];  // [lng, lat] pairs
}

const ROUTES: RouteItem[] = [
  {
    id: 'r1', name: 'Blue Ridge Loop',  km: 148, min: 145, saved: true,
    coords: [[-122.4194,37.7749],[-122.4094,37.7849],[-122.3994,37.7949],[-122.4194,37.8049],[-122.4394,37.7949],[-122.4194,37.7749]],
  },
  {
    id: 'r2', name: 'Coastal Highway',  km: 92,  min: 88,  saved: true,
    coords: [[-122.4194,37.7749],[-122.4594,37.7649],[-122.4994,37.7549],[-122.5394,37.7449]],
  },
  {
    id: 'r3', name: 'Mountain Pass',    km: 215, min: 210, saved: false,
    coords: [[-122.4194,37.7749],[-122.3594,37.8249],[-122.2994,37.8749]],
  },
  {
    id: 'r4', name: 'Valley Shortcut',  km: 54,  min: 52,  saved: false,
    coords: [[-122.4194,37.7749],[-122.4494,37.7949],[-122.4794,37.8149]],
  },
];

const TURN_INSTRUCTIONS = [
  'Turn Right on Highway 36',
  'Keep straight on Ridge Rd',
  'Turn Left at Junction 12',
  'Continue on Coastal Hwy',
];

@Component({
  selector: 'app-navigation',
  imports: [FormsModule],
  templateUrl: './navigation.component.html',
  styleUrl: './navigation.component.scss',
})
export class NavigationComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('mapContainer') mapContainerRef!: ElementRef<HTMLDivElement>;

  readonly routes    = ROUTES;
  readonly mapReady  = computed(() => this.mapSvc.isReady());
  readonly isOffline = computed(() => this.mapSvc.isOffline());
  readonly speed     = computed(() => this.loc.speed());

  activeRoute   = signal<RouteItem | null>(null);
  navActive     = signal(false);
  searchQuery   = signal('');
  nextTurn      = signal<string | null>(null);
  distToTurn    = signal(0);
  etaMin        = signal(0);
  distRemain    = signal(0);
  showRouteList = signal(true);

  private _turnIdx     = 0;
  private _lastLoc: RiderLocation | null = null;
  private _effectTeardown: (() => void) | null = null;

  constructor(readonly mapSvc: MapService, readonly loc: LocationService) {}

  ngOnInit(): void { this.loc.start(); }

  ngAfterViewInit(): void {
    setTimeout(() => {
      const loc = this.loc.currentLocation();
      const center: [number, number] = loc ? [loc.lng, loc.lat] : [-122.4194, 37.7749];
      this.mapSvc.init(this.mapContainerRef.nativeElement, center, 13);
    }, 100);
  }

  ngOnDestroy(): void {
    this._effectTeardown?.();
    this.mapSvc.destroy();
  }

  get filteredRoutes(): RouteItem[] {
    const q = this.searchQuery().toLowerCase();
    return q ? this.routes.filter(r => r.name.toLowerCase().includes(q)) : this.routes;
  }

  startNav(route: RouteItem): void {
    this.activeRoute.set(route);
    this.navActive.set(true);
    this.showRouteList.set(false);
    this._turnIdx = 0;
    this.nextTurn.set(TURN_INSTRUCTIONS[0]);
    this.distToTurn.set(1200);
    this.etaMin.set(route.min);
    this.distRemain.set(route.km * 1000); // store in meters internally
    this._lastLoc = this.loc.currentLocation();

    const tryDraw = () => {
      if (this.mapSvc.isReady()) {
        this.mapSvc.drawRoute(route.coords);
        this.mapSvc.fitBounds(route.coords);
      } else {
        setTimeout(tryDraw, 200);
      }
    };
    tryDraw();

    // React to real GPS position updates
    this._effectTeardown = effect(() => {
      const newLoc = this.loc.currentLocation();
      if (!newLoc || !this.navActive()) return;

      if (this._lastLoc) {
        const moved = this._haversineM(
          this._lastLoc.lat, this._lastLoc.lng,
          newLoc.lat, newLoc.lng,
        );
        if (moved > 5) {
          // Update remaining distance
          const remaining = Math.max(0, this.distRemain() - moved);
          this.distRemain.set(remaining);

          // Update ETA based on current speed (km/h → m/min)
          const speedMpm = (this.loc.speed() || 30) * 1000 / 60;
          this.etaMin.set(Math.max(0, Math.round(remaining / speedMpm)));

          // Advance turn instruction
          const dToTurn = Math.max(0, this.distToTurn() - moved);
          if (dToTurn < 50) {
            this._turnIdx = (this._turnIdx + 1) % TURN_INSTRUCTIONS.length;
            this.nextTurn.set(TURN_INSTRUCTIONS[this._turnIdx]);
            this.distToTurn.set(800 + Math.round(Math.random() * 600));
          } else {
            this.distToTurn.set(dToTurn);
          }

          // Pan map to follow rider
          this.mapSvc.flyTo(newLoc.lng, newLoc.lat, 15);
        }
      }
      this._lastLoc = newLoc;
    }) as unknown as () => void;
    // effect() returns EffectRef — wrap destroy
    const ref = this._effectTeardown as unknown as { destroy(): void };
    if (ref && typeof ref.destroy === 'function') {
      this._effectTeardown = () => ref.destroy();
    }
  }

  stopNav(): void {
    this._effectTeardown?.();
    this._effectTeardown = null;
    this.mapSvc.clearRoute();
    this.activeRoute.set(null);
    this.navActive.set(false);
    this.showRouteList.set(true);
  }

  formatEta(min: number): string {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  formatDist(m: number): string {
    return m > 999 ? (m / 1000).toFixed(1) + 'km' : Math.round(m) + 'm';
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
