import { Component, computed, signal, ElementRef, ViewChild, OnDestroy, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { EmergencyService, EmergencyAlert } from '../../core/services/emergency.service';
import { LocationService } from '../../core/services/location.service';
import maplibregl from 'maplibre-gl';

const MAP_STYLE_ONLINE  = 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json';
const MAP_STYLE_OFFLINE: maplibregl.StyleSpecification = {
  version: 8,
  name: 'RATH Offline',
  sources: {
    'osm-tiles': {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
    },
  },
  layers: [
    { id: 'bg',        type: 'background', paint: { 'background-color': '#0D0D1A' } },
    { id: 'osm-layer', type: 'raster',     source: 'osm-tiles',
      paint: { 'raster-opacity': 0.85, 'raster-saturation': -0.8 } },
  ],
};

@Component({
  selector: 'app-emergency',
  imports: [DatePipe],
  templateUrl: './emergency.component.html',
  styleUrl: './emergency.component.scss',
})
export class EmergencyComponent implements OnDestroy {
  @ViewChild('sosMapContainer') sosMapContainerRef?: ElementRef<HTMLDivElement>;

  readonly alerts       = computed(() => this.emergency.activeAlerts());
  readonly sosSent      = computed(() => this.emergency.sosSent());
  readonly countdown    = computed(() => this.emergency.sosCountdown());
  readonly isCounting   = computed(() => this.countdown() > 0);
  readonly activeAlerts = computed(() => this.alerts().filter(a => !a.resolved));

  holding = signal(false);

  // Map overlay state
  mapAlert  = signal<EmergencyAlert | null>(null);
  private _sosMap: maplibregl.Map | null = null;
  private _sosMarker: maplibregl.Marker | null = null;
  private _selfMarker: maplibregl.Marker | null = null;

  constructor(
    readonly emergency: EmergencyService,
    readonly loc: LocationService,
  ) {}

  ngOnDestroy(): void {
    this._destroyMap();
  }

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

  // ─── SOS Map overlay ────────────────────────────────────────────────────────

  openMap(alert: EmergencyAlert): void {
    this.mapAlert.set(alert);
    // Wait one tick for the DOM to render the container
    setTimeout(() => this._initSosMap(alert), 50);
  }

  closeMap(): void {
    this._destroyMap();
    this.mapAlert.set(null);
  }

  private _initSosMap(alert: EmergencyAlert): void {
    const el = document.getElementById('sos-map-container');
    if (!el) return;

    this._destroyMap();

    let style: string | maplibregl.StyleSpecification = MAP_STYLE_ONLINE;

    this._sosMap = new maplibregl.Map({
      container: el,
      style,
      center:    [alert.location.lng, alert.location.lat],
      zoom:      14,
      attributionControl: false,
    });

    this._sosMap.on('error', () => {
      this._sosMap?.setStyle(MAP_STYLE_OFFLINE);
    });

    this._sosMap.on('load', () => {
      this._placeAlertMarker(alert);
      this._placeSelfMarker();
    });

    this._sosMap.on('style.load', () => {
      this._placeAlertMarker(alert);
      this._placeSelfMarker();
    });
  }

  private _placeAlertMarker(alert: EmergencyAlert): void {
    if (!this._sosMap) return;
    const el = document.createElement('div');
    el.style.cssText = [
      'width:32px;height:32px;border-radius:50% 50% 50% 0;',
      'transform:rotate(-45deg);',
      'background:#E63946;border:3px solid #fff;',
      'box-shadow:0 2px 12px rgba(230,57,70,0.7);',
    ].join('');
    this._sosMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([alert.location.lng, alert.location.lat])
      .setPopup(new maplibregl.Popup({ offset: 32, closeButton: false })
        .setHTML(`<strong>${alert.riderName}</strong><br>${this.typeLabel(alert.type)}`))
      .addTo(this._sosMap);
    this._sosMarker.getPopup()?.addTo(this._sosMap);
  }

  private _placeSelfMarker(): void {
    const selfLoc = this.loc.currentLocation();
    if (!this._sosMap || !selfLoc) return;
    const dot = document.createElement('div');
    dot.style.cssText = 'width:14px;height:14px;border-radius:50%;background:#6B46FF;border:2px solid #fff;box-shadow:0 0 8px rgba(107,70,255,0.6);';
    this._selfMarker = new maplibregl.Marker({ element: dot, anchor: 'center' })
      .setLngLat([selfLoc.lng, selfLoc.lat])
      .addTo(this._sosMap);

    // Fit both markers if self location is available
    const alert = this.mapAlert();
    if (alert) {
      const bounds = new maplibregl.LngLatBounds(
        [Math.min(selfLoc.lng, alert.location.lng), Math.min(selfLoc.lat, alert.location.lat)],
        [Math.max(selfLoc.lng, alert.location.lng), Math.max(selfLoc.lat, alert.location.lat)],
      );
      this._sosMap.fitBounds(bounds, { padding: 80, duration: 800, maxZoom: 15 });
    }
  }

  private _destroyMap(): void {
    this._sosMarker?.remove();
    this._selfMarker?.remove();
    this._sosMap?.remove();
    this._sosMap    = null;
    this._sosMarker = null;
    this._selfMarker = null;
  }
}
