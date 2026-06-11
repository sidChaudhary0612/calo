import {
  Component, computed, effect, ElementRef, OnDestroy, OnInit,
  signal, ViewChild, AfterViewInit, ChangeDetectorRef, inject,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { MapService } from '../../core/services/map.service';
import { LocationService } from '../../core/services/location.service';
import { MeshService } from '../../core/services/mesh.service';
import { RiderLocation, Rider } from '../../core/models/rider.model';

export interface RouteInfo {
  coords:       [number, number][];
  distanceM:    number;
  durationSec:  number;
  steps:        RouteStep[];
}

export interface RouteStep {
  instruction: string;
  distanceM:   number;
}

export interface SearchResult {
  displayName: string;
  lat: number;
  lng: number;
}

// OSRM public demo server — returns real road-snapped routes with turn instructions
const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';
// Nominatim geocoding
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

function osrmStepToInstruction(step: {
  maneuver: { type: string; modifier?: string };
  name: string;
}): string {
  const { type, modifier } = step.maneuver;
  const road = step.name ? ` onto ${step.name}` : '';
  switch (type) {
    case 'depart':         return `Depart${road}`;
    case 'arrive':         return `Arrive at destination`;
    case 'turn':           return `Turn ${modifier ?? 'right'}${road}`;
    case 'new name':       return `Continue${road}`;
    case 'merge':          return `Merge${road}`;
    case 'on ramp':        return `Take the ramp${road}`;
    case 'off ramp':       return `Exit the ramp${road}`;
    case 'fork':           return `At the fork, keep ${modifier ?? 'straight'}${road}`;
    case 'end of road':    return `Turn ${modifier ?? 'right'} at end of road${road}`;
    case 'roundabout':     return `Enter roundabout, take exit${road}`;
    case 'rotary':         return `Enter rotary${road}`;
    case 'roundabout turn':return `At roundabout, turn ${modifier ?? 'right'}${road}`;
    case 'continue':       return `Continue ${modifier ?? 'straight'}${road}`;
    default:               return `Continue${road}`;
  }
}

@Component({
  selector: 'app-navigation',
  standalone: true,
  imports: [FormsModule, CommonModule],
  providers: [MapService],
  templateUrl: './navigation.component.html',
  styleUrl: './navigation.component.scss',
})
export class NavigationComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('mapContainer') mapContainerRef!: ElementRef<HTMLDivElement>;

  readonly mapSvc  = inject(MapService);
  readonly loc     = inject(LocationService);
  readonly meshSvc = inject(MeshService);
  private _cdr     = inject(ChangeDetectorRef);

  readonly mapReady  = computed(() => this.mapSvc.isReady());
  readonly isOffline = computed(() => this.mapSvc.isOffline());
  readonly speed     = computed(() => this.loc.speed());

  gpsReady    = signal(false);
  navActive   = signal(false);
  showPanel   = signal(true);

  // Current active route
  activeRoute  = signal<RouteInfo | null>(null);
  destination  = signal<SearchResult | null>(null);

  // Search
  searchQuery   = signal('');
  searchResults = signal<SearchResult[]>([]);
  isSearching   = signal(false);
  searchError   = signal('');
  isRouting     = signal(false);

  // Nav HUD
  nextStep    = signal<RouteStep | null>(null);
  stepIdx     = signal(0);
  etaMin      = signal(0);
  distRemain  = signal(0);

  // Offline download
  downloadingRegion = signal(false);
  downloadDone      = signal(false);
  downloadProgress  = signal(0);

  // Mode toggle
  forceOfflineMode = signal(false);

  private _lastLoc: RiderLocation | null = null;
  private _navEffectRef:      { destroy(): void } | null = null;
  private _locationEffectRef: { destroy(): void } | null = null;
  private _groupEffectRef:    { destroy(): void } | null = null;
  private _searchDebounce: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.loc.start().then(() => {
      const loc = this.loc.currentLocation();
      if (loc) this.gpsReady.set(true);
      else {
        const waitGps = effect(() => {
          if (this.loc.currentLocation()) { this.gpsReady.set(true); waitGps.destroy(); }
        });
      }
    });

    this._locationEffectRef = effect(() => {
      const l = this.loc.currentLocation();
      if (l) this.mapSvc.updateSelfLocation(l);
    });

    // Mirror group members onto map whenever they update
    this._groupEffectRef = effect(() => {
      const group   = this.meshSvc.activeGroup();
      const riders  = this.meshSvc.nearbyRiders();
      const members = group
        ? riders.filter(r => group.memberIds.includes(r.id) && r.id !== 'self')
        : [];

      // Collect which IDs are active
      const activeIds = new Set(members.map(r => r.id));

      // Remove stale markers (riders that left the group or lost location)
      riders
        .filter(r => r.id !== 'self' && !activeIds.has(r.id))
        .forEach(r => this.mapSvc.removeRiderMarker(r.id));

      // Update/add active member markers
      members.forEach((r: Rider) => {
        if (r.location) {
          this.mapSvc.updateRiderMarker(r.id, r.name, r.avatarInitials, r.location);
        }
      });
    });
  }

  ngAfterViewInit(): void {
    this._initMapWhenReady(0);
  }

  ngOnDestroy(): void {
    this._navEffectRef?.destroy();
    this._locationEffectRef?.destroy();
    this._groupEffectRef?.destroy();
    this.mapSvc.destroy();
    if (this._searchDebounce) clearTimeout(this._searchDebounce);
  }

  // ─── Mode toggle ─────────────────────────────────────────────────────────

  toggleOfflineMode(): void {
    const nowOffline = !this.forceOfflineMode();
    this.forceOfflineMode.set(nowOffline);
    if (nowOffline) {
      this.mapSvc.switchToOfflineStyle();
    } else {
      this.mapSvc.switchToOnlineStyle();
    }
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  onSearchInput(value: string): void {
    this.searchQuery.set(value);
    this.searchResults.set([]);
    this.searchError.set('');

    if (this._searchDebounce) clearTimeout(this._searchDebounce);
    const trimmed = value.trim();
    if (trimmed.length < 3) return;

    this._searchDebounce = setTimeout(() => this._geocode(trimmed), 500);
  }

  private async _geocode(query: string): Promise<void> {
    if (this.isOffline()) {
      this.searchError.set('Search unavailable offline — use downloaded map');
      return;
    }
    this.isSearching.set(true);
    try {
      const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=0`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'RATH/1.0' } });
      if (!res.ok) throw new Error('Search failed');
      const data: Array<{ display_name: string; lat: string; lon: string }> = await res.json();
      this.searchResults.set(data.map(d => ({
        displayName: d.display_name,
        lat: parseFloat(d.lat),
        lng: parseFloat(d.lon),
      })));
      if (data.length === 0) this.searchError.set('No results found');
    } catch {
      this.searchError.set('Search failed — check connection');
    } finally {
      this.isSearching.set(false);
    }
  }

  selectSearchResult(r: SearchResult): void {
    this.mapSvc.flyTo(r.lng, r.lat, 14);
    this.mapSvc.setDestinationMarker(r.lng, r.lat, r.displayName.split(',')[0]);
    this.destination.set(r);
    this.searchResults.set([]);
    this.searchQuery.set(r.displayName.split(',')[0]);
  }

  clearSearch(): void {
    this.searchQuery.set('');
    this.searchResults.set([]);
    this.searchError.set('');
    this.destination.set(null);
    this.mapSvc.clearDestinationMarker();
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  async navigateTo(dest: SearchResult): Promise<void> {
    const loc = this.loc.currentLocation();
    if (!loc) { this.searchError.set('GPS fix required to navigate'); return; }
    if (this.isOffline()) {
      this.searchError.set('Turn-by-turn routing requires online connection');
      return;
    }

    this.isRouting.set(true);
    this.searchError.set('');

    try {
      const url = `${OSRM_BASE}/${loc.lng},${loc.lat};${dest.lng},${dest.lat}`
        + `?overview=full&geometries=geojson&steps=true&annotations=false`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Routing failed');
      const json = await res.json();

      if (json.code !== 'Ok' || !json.routes?.length) {
        this.searchError.set('No route found to that location');
        return;
      }

      const r = json.routes[0];
      const coords: [number, number][] = r.geometry.coordinates;

      const steps: RouteStep[] = [];
      for (const leg of r.legs) {
        for (const step of leg.steps) {
          steps.push({
            instruction: osrmStepToInstruction(step),
            distanceM:   Math.round(step.distance),
          });
        }
      }

      const route: RouteInfo = {
        coords,
        distanceM:   Math.round(r.distance),
        durationSec: Math.round(r.duration),
        steps,
      };

      this._startNavigation(route, dest);
    } catch {
      this.searchError.set('Routing failed — check connection');
    } finally {
      this.isRouting.set(false);
    }
  }

  private _startNavigation(route: RouteInfo, dest: SearchResult): void {
    this.activeRoute.set(route);
    this.destination.set(dest);
    this.navActive.set(true);
    this.showPanel.set(false);

    this.stepIdx.set(0);
    this.nextStep.set(route.steps[0] ?? null);
    this.distRemain.set(route.distanceM);
    this.etaMin.set(Math.round(route.durationSec / 60));
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

    this._navEffectRef?.destroy();
    this._navEffectRef = effect(() => {
      const newLoc = this.loc.currentLocation();
      if (!newLoc || !this.navActive()) return;

      if (this._lastLoc) {
        const moved = this._haversineM(this._lastLoc.lat, this._lastLoc.lng, newLoc.lat, newLoc.lng);
        if (moved > 5) {
          const remaining = Math.max(0, this.distRemain() - moved);
          this.distRemain.set(remaining);
          const speedMpm = Math.max(5, (this.loc.speed() || 30)) * 1000 / 60;
          this.etaMin.set(Math.max(0, Math.round(remaining / speedMpm)));

          // Advance step when within 30m of current step end distance
          const step = this.nextStep();
          if (step) {
            const dLeft = Math.max(0, step.distanceM - moved);
            if (dLeft < 30) {
              const nextIdx = this.stepIdx() + 1;
              const nextStep = route.steps[nextIdx] ?? null;
              this.stepIdx.set(nextIdx);
              this.nextStep.set(nextStep);
            }
          }

          this.mapSvc.flyTo(newLoc.lng, newLoc.lat, 16);
        }
      }
      this._lastLoc = newLoc;
    });
  }

  stopNav(): void {
    this._navEffectRef?.destroy();
    this._navEffectRef = null;
    this.mapSvc.clearRoute();
    this.mapSvc.clearDestinationMarker();
    this.activeRoute.set(null);
    this.destination.set(null);
    this.navActive.set(false);
    this.showPanel.set(true);

    // Recenter on self
    const loc = this.loc.currentLocation();
    if (loc) this.mapSvc.flyTo(loc.lng, loc.lat, 14);
  }

  // ─── Offline map download ─────────────────────────────────────────────────

  async downloadRegion(): Promise<void> {
    if (this.downloadingRegion() || this.downloadDone()) return;
    const loc = this.loc.currentLocation();
    if (!loc) { this.searchError.set('GPS required to download region'); return; }

    this.downloadingRegion.set(true);
    this.downloadProgress.set(0);

    const delta  = 0.05; // ~5.5km each direction
    const bounds = {
      minLng: loc.lng - delta, maxLng: loc.lng + delta,
      minLat: loc.lat - delta, maxLat: loc.lat + delta,
    };

    const ZOOM_LEVELS = [10, 11, 12, 13, 14, 15];
    const TILE_URL    = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const CACHE_NAME  = 'rath-map-tiles-v1';

    try {
      const cache = await caches.open(CACHE_NAME);
      const tiles = this._tilesInBounds(bounds, ZOOM_LEVELS);
      let fetched = 0;
      const BATCH = 6;

      for (let i = 0; i < tiles.length; i += BATCH) {
        const batch = tiles.slice(i, i + BATCH);
        await Promise.all(batch.map(async t => {
          const url = TILE_URL
            .replace('{z}', t.z.toString())
            .replace('{x}', t.x.toString())
            .replace('{y}', t.y.toString());
          try {
            const hit = await cache.match(url);
            if (!hit) {
              const resp = await fetch(url);
              if (resp.ok) await cache.put(url, resp.clone());
            }
          } catch { /* skip failed tiles */ }
          fetched++;
          this.downloadProgress.set(Math.round((fetched / tiles.length) * 100));
        }));
      }

      this.downloadingRegion.set(false);
      this.downloadDone.set(true);
      setTimeout(() => this.downloadDone.set(false), 5000);
    } catch {
      this.downloadingRegion.set(false);
      this.searchError.set('Download failed — try again');
    }
  }

  // ─── Formatters ──────────────────────────────────────────────────────────

  formatEta(min: number): string {
    const h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  formatDist(m: number): string {
    return m > 999 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  }

  get groupMemberCount(): number {
    const group = this.meshSvc.activeGroup();
    if (!group) return 0;
    return this.meshSvc.nearbyRiders().filter(
      r => group.memberIds.includes(r.id) && r.id !== 'self' && !!r.location
    ).length;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _initMapWhenReady(attempts: number): void {
    const loc = this.loc.currentLocation();
    if (loc) {
      this.mapSvc.init(this.mapContainerRef.nativeElement, [loc.lng, loc.lat], 14);
      this.mapSvc.updateSelfLocation(loc);
    } else if (attempts < 150) {
      setTimeout(() => this._initMapWhenReady(attempts + 1), 200);
    }
  }

  private _tilesInBounds(
    b: { minLng: number; maxLng: number; minLat: number; maxLat: number },
    zooms: number[],
  ): Array<{ z: number; x: number; y: number }> {
    const tiles: Array<{ z: number; x: number; y: number }> = [];
    for (const z of zooms) {
      const xMin = this._lngToTile(b.minLng, z);
      const xMax = this._lngToTile(b.maxLng, z);
      const yMin = this._latToTile(b.maxLat, z);
      const yMax = this._latToTile(b.minLat, z);
      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) {
          tiles.push({ z, x, y });
        }
      }
    }
    return tiles;
  }

  private _lngToTile(lng: number, z: number): number {
    return Math.floor((lng + 180) / 360 * Math.pow(2, z));
  }

  private _latToTile(lat: number, z: number): number {
    const rad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z));
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
