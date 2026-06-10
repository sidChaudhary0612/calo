import { Injectable, signal } from '@angular/core';
import maplibregl from 'maplibre-gl';
import type { FeatureCollection, LineString } from 'geojson';
import { RiderLocation } from '../models/rider.model';

function ensurePingKeyframes(): void {
  if (document.getElementById('rm-map-keyframes')) return;
  const style = document.createElement('style');
  style.id = 'rm-map-keyframes';
  style.textContent = `
    @keyframes rm-ping {
      0%   { transform: scale(1);   opacity: 0.8; }
      70%  { transform: scale(2.2); opacity: 0; }
      100% { transform: scale(2.2); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

const MAP_STYLE_ONLINE = 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json';

const MAP_STYLE_OFFLINE: maplibregl.StyleSpecification = {
  version: 8,
  name: 'CALO Offline',
  sources: {
    'osm-tiles': {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    { id: 'bg',        type: 'background', paint: { 'background-color': '#0D0D1A' } },
    { id: 'osm-layer', type: 'raster',     source: 'osm-tiles',
      paint: { 'raster-opacity': 0.85, 'raster-saturation': -0.8, 'raster-brightness-min': 0 } },
  ],
};

function cssVar(name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined') return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

@Injectable({ providedIn: 'root' })
export class MapService {
  readonly isReady   = signal(false);
  readonly isOffline = signal(false);

  private _map: maplibregl.Map | null = null;
  private _selfMarker: maplibregl.Marker | null = null;
  private _riderMarkers = new Map<string, maplibregl.Marker>();
  private _destinationMarker: maplibregl.Marker | null = null;
  private _routeLoaded  = false;
  private _pendingLoc: RiderLocation | null = null;

  // ─── Initialise ────────────────────────────────────────────────────────

  init(container: HTMLElement, center: [number, number], zoom = 13): void {
    if (this._map) return;
    ensurePingKeyframes();

    this._map = new maplibregl.Map({
      container,
      style:  MAP_STYLE_ONLINE,
      center,
      zoom,
      attributionControl: false,
    });

    this._map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right',
    );

    this._map.on('load', () => {
      this.isReady.set(true);
      this.isOffline.set(false);
      if (this._pendingLoc) {
        this._placeSelfMarker(this._pendingLoc);
        this._pendingLoc = null;
      }
    });

    this._map.on('style.load', () => {
      this._routeLoaded = false;
      if (this._pendingLoc) {
        this._placeSelfMarker(this._pendingLoc);
        this._pendingLoc = null;
      }
    });

    this._map.on('error', (e) => {
      if (!this.isOffline()) {
        this.isOffline.set(true);
        this._map?.setStyle(MAP_STYLE_OFFLINE);
      }
      console.warn('[MapService] map error', e.error?.message);
    });
  }

  switchToOfflineStyle(): void {
    if (!this._map || this.isOffline()) return;
    this.isOffline.set(true);
    this._map.setStyle(MAP_STYLE_OFFLINE);
  }

  switchToOnlineStyle(): void {
    if (!this._map || !this.isOffline()) return;
    this.isOffline.set(false);
    this._map.setStyle(MAP_STYLE_ONLINE);
  }

  destroy(): void {
    this._map?.remove();
    this._map                = null;
    this._selfMarker         = null;
    this._destinationMarker  = null;
    this._pendingLoc         = null;
    this._riderMarkers.clear();
    this._routeLoaded = false;
    this.isReady.set(false);
    this.isOffline.set(false);
  }

  // ─── Self location ─────────────────────────────────────────────────────

  updateSelfLocation(loc: RiderLocation): void {
    if (!this._map) { this._pendingLoc = loc; return; }
    if (!this.isReady()) { this._pendingLoc = loc; return; }
    this._placeSelfMarker(loc);
  }

  private _placeSelfMarker(loc: RiderLocation): void {
    if (!this._map) return;
    const lngLat: maplibregl.LngLatLike = [loc.lng, loc.lat];

    if (!this._selfMarker) {
      this._selfMarker = new maplibregl.Marker({
        element: this._makeSelfElement(),
        anchor:  'center',
      }).setLngLat(lngLat).addTo(this._map);
    } else {
      this._selfMarker.setLngLat(lngLat);
    }

    this._map.easeTo({ center: lngLat, duration: 800 });
  }

  // ─── Destination marker ────────────────────────────────────────────────

  setDestinationMarker(lng: number, lat: number, label?: string): void {
    if (!this._map) return;
    const lngLat: maplibregl.LngLatLike = [lng, lat];

    if (!this._destinationMarker) {
      this._destinationMarker = new maplibregl.Marker({
        element: this._makeDestElement(),
        anchor:  'bottom',
      }).setLngLat(lngLat).addTo(this._map);
    } else {
      this._destinationMarker.setLngLat(lngLat);
    }

    if (label) {
      this._destinationMarker.setPopup(
        new maplibregl.Popup({ offset: 32, closeButton: false }).setText(label),
      );
    }
  }

  clearDestinationMarker(): void {
    this._destinationMarker?.remove();
    this._destinationMarker = null;
  }

  // ─── Group rider markers ───────────────────────────────────────────────

  updateRiderMarker(id: string, name: string, initials: string, loc: RiderLocation): void {
    if (!this._map) return;
    const lngLat: maplibregl.LngLatLike = [loc.lng, loc.lat];

    if (this._riderMarkers.has(id)) {
      this._riderMarkers.get(id)!.setLngLat(lngLat);
    } else {
      const marker = new maplibregl.Marker({
        element: this._makeRiderElement(initials),
        anchor:  'center',
      })
        .setLngLat(lngLat)
        .setPopup(new maplibregl.Popup({ offset: 28, closeButton: false }).setText(name))
        .addTo(this._map);
      this._riderMarkers.set(id, marker);
    }
  }

  removeRiderMarker(id: string): void {
    this._riderMarkers.get(id)?.remove();
    this._riderMarkers.delete(id);
  }

  clearAllRiderMarkers(): void {
    this._riderMarkers.forEach(m => m.remove());
    this._riderMarkers.clear();
  }

  // ─── Route drawing ─────────────────────────────────────────────────────

  drawRoute(coords: [number, number][]): void {
    if (!this._map || !this.isReady()) return;
    const map    = this._map;
    const colour = cssVar('--rm-primary', '#6B46FF');

    if (this._routeLoaded) {
      (map.getSource('rm-route') as maplibregl.GeoJSONSource)?.setData(this._routeGeoJson(coords));
      return;
    }

    map.addSource('rm-route', { type: 'geojson', data: this._routeGeoJson(coords) });

    // Shadow/casing for contrast on top of both online and offline styles
    map.addLayer({
      id:     'rm-route-casing',
      type:   'line',
      source: 'rm-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint:  { 'line-color': '#000', 'line-width': 8, 'line-opacity': 0.35 },
    });

    map.addLayer({
      id:     'rm-route-line',
      type:   'line',
      source: 'rm-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint:  { 'line-color': colour, 'line-width': 5, 'line-opacity': 0.92 },
    });

    this._routeLoaded = true;
  }

  clearRoute(): void {
    if (!this._map || !this._routeLoaded) return;
    if (this._map.getLayer('rm-route-line'))   this._map.removeLayer('rm-route-line');
    if (this._map.getLayer('rm-route-casing')) this._map.removeLayer('rm-route-casing');
    if (this._map.getSource('rm-route'))       this._map.removeSource('rm-route');
    this._routeLoaded = false;
  }

  fitBounds(coords: [number, number][]): void {
    if (!this._map || coords.length < 2) return;
    const bounds = coords.reduce(
      (b, c) => b.extend(c as maplibregl.LngLatLike),
      new maplibregl.LngLatBounds(coords[0], coords[0]),
    );
    this._map.fitBounds(bounds, { padding: 80, duration: 800 });
  }

  flyTo(lng: number, lat: number, zoom = 15): void {
    this._map?.flyTo({ center: [lng, lat], zoom, duration: 1000 });
  }

  // ─── Marker DOM elements ───────────────────────────────────────────────

  private _makeSelfElement(): HTMLElement {
    const accent = cssVar('--rm-primary', '#6B46FF');
    const glow   = cssVar('--rm-primary-glow', 'rgba(107,70,255,0.3)');

    const el = document.createElement('div');
    el.style.cssText = 'position:relative;width:24px;height:24px;';

    const pulse = document.createElement('div');
    pulse.style.cssText = `position:absolute;inset:0;background:${glow};border-radius:50%;animation:rm-ping 1.5s ease-out infinite;`;

    const dot = document.createElement('div');
    dot.style.cssText = `position:absolute;inset:4px;background:${accent};border-radius:50%;border:2px solid var(--bg-base,#000);z-index:1;`;

    el.append(pulse, dot);
    return el;
  }

  private _makeRiderElement(initials: string): HTMLElement {
    const bg     = cssVar('--bg-card',   '#131320');
    const border = cssVar('--rm-cyan',   '#00E5FF');
    const colour = cssVar('--rm-cyan',   '#00E5FF');
    const font   = cssVar('--font-display', '"Space Grotesk",sans-serif');

    const el = document.createElement('div');
    el.style.cssText = [
      `width:32px;height:32px;border-radius:8px;`,
      `background:${bg};border:1.5px solid ${border};`,
      `display:flex;align-items:center;justify-content:center;`,
      `font-family:${font};font-size:11px;font-weight:700;`,
      `color:${colour};cursor:pointer;`,
    ].join('');
    el.textContent = initials;
    return el;
  }

  private _makeDestElement(): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex;flex-direction:column;align-items:center;';

    const pin = document.createElement('div');
    pin.style.cssText = [
      'width:28px;height:28px;border-radius:50% 50% 50% 0;',
      'transform:rotate(-45deg);',
      'background:#E63946;border:2px solid #fff;',
      'box-shadow:0 2px 8px rgba(230,57,70,0.5);',
    ].join('');

    el.appendChild(pin);
    return el;
  }

  private _routeGeoJson(coords: [number, number][]): FeatureCollection<LineString> {
    return {
      type: 'FeatureCollection',
      features: [{
        type:       'Feature',
        properties: {},
        geometry:   { type: 'LineString', coordinates: coords },
      }],
    };
  }
}
