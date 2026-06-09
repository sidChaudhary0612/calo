import { Injectable, signal } from '@angular/core';
import mapboxgl from 'mapbox-gl';
import { RiderLocation } from '../models/rider.model';

// Token placeholder — user must set their own Mapbox public token.
// In production inject via environment.ts or Capacitor preferences.
const MAPBOX_TOKEN = 'pk.REPLACE_WITH_YOUR_MAPBOX_TOKEN';

@Injectable({ providedIn: 'root' })
export class MapService {
  readonly isReady    = signal(false);
  readonly isOffline  = signal(false);

  private _map: mapboxgl.Map | null = null;
  private _selfMarker: mapboxgl.Marker | null = null;
  private _riderMarkers = new Map<string, mapboxgl.Marker>();
  private _routeLoaded  = false;

  // ─── Initialise ────────────────────────────────────────────────────────

  init(container: HTMLElement, center: [number, number] = [-122.4194, 37.7749], zoom = 13): void {
    if (this._map) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    this._map = new mapboxgl.Map({
      container,
      style:     'mapbox://styles/mapbox/dark-v11',
      center,
      zoom,
      attributionControl: false,
      logoPosition: 'bottom-right',
    });

    this._map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');

    this._map.on('load', () => {
      this.isReady.set(true);
    });

    this._map.on('error', () => {
      // Fall back to offline style when token is missing / network unavailable
      this.isOffline.set(true);
    });
  }

  destroy(): void {
    this._map?.remove();
    this._map = null;
    this._selfMarker = null;
    this._riderMarkers.clear();
    this.isReady.set(false);
  }

  // ─── Self location ─────────────────────────────────────────────────────

  updateSelfLocation(loc: RiderLocation): void {
    if (!this._map) return;
    const lngLat: mapboxgl.LngLatLike = [loc.lng, loc.lat];

    if (!this._selfMarker) {
      const el = this._makeSelfElement();
      this._selfMarker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat(lngLat)
        .addTo(this._map);
    } else {
      this._selfMarker.setLngLat(lngLat);
    }

    this._map.easeTo({ center: lngLat, duration: 800 });
  }

  // ─── Group rider markers ───────────────────────────────────────────────

  updateRiderMarker(id: string, name: string, initials: string, loc: RiderLocation): void {
    if (!this._map) return;
    const lngLat: mapboxgl.LngLatLike = [loc.lng, loc.lat];

    if (this._riderMarkers.has(id)) {
      this._riderMarkers.get(id)!.setLngLat(lngLat);
    } else {
      const el = this._makeRiderElement(initials);
      const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat(lngLat)
        .setPopup(new mapboxgl.Popup({ offset: 28, closeButton: false }).setText(name))
        .addTo(this._map);
      this._riderMarkers.set(id, marker);
    }
  }

  removeRiderMarker(id: string): void {
    this._riderMarkers.get(id)?.remove();
    this._riderMarkers.delete(id);
  }

  // ─── Route drawing ─────────────────────────────────────────────────────

  drawRoute(coords: [number, number][]): void {
    if (!this._map || !this.isReady()) return;
    const map = this._map;

    if (this._routeLoaded) {
      (map.getSource('rm-route') as mapboxgl.GeoJSONSource)?.setData(this._routeGeoJson(coords));
      return;
    }

    map.addSource('rm-route', {
      type: 'geojson',
      data: this._routeGeoJson(coords),
    });

    map.addLayer({
      id: 'rm-route-line',
      type: 'line',
      source: 'rm-route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color':   '#FF6B1A',
        'line-width':   4,
        'line-opacity': 0.85,
      },
    });

    this._routeLoaded = true;
  }

  clearRoute(): void {
    if (!this._map || !this._routeLoaded) return;
    if (this._map.getLayer('rm-route-line')) this._map.removeLayer('rm-route-line');
    if (this._map.getSource('rm-route'))     this._map.removeSource('rm-route');
    this._routeLoaded = false;
  }

  fitBounds(coords: [number, number][]): void {
    if (!this._map || coords.length < 2) return;
    const bounds = coords.reduce(
      (b, c) => b.extend(c as mapboxgl.LngLatLike),
      new mapboxgl.LngLatBounds(coords[0], coords[0])
    );
    this._map.fitBounds(bounds, { padding: 60, duration: 800 });
  }

  flyTo(lng: number, lat: number, zoom = 15): void {
    this._map?.flyTo({ center: [lng, lat], zoom, duration: 1000 });
  }

  // ─── Private helpers ───────────────────────────────────────────────────

  private _makeSelfElement(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'rm-self-marker';
    el.innerHTML = `
      <div class="rm-self-marker__pulse"></div>
      <div class="rm-self-marker__dot"></div>
    `;
    el.style.cssText = 'position:relative;width:24px;height:24px;';

    const dot = el.querySelector('.rm-self-marker__dot') as HTMLElement;
    dot.style.cssText = 'position:absolute;inset:4px;background:#FF6B1A;border-radius:50%;border:2px solid #fff;z-index:1;';

    const pulse = el.querySelector('.rm-self-marker__pulse') as HTMLElement;
    pulse.style.cssText = 'position:absolute;inset:0;background:rgba(255,107,26,0.3);border-radius:50%;animation:ping 1.5s ease-out infinite;';

    return el;
  }

  private _makeRiderElement(initials: string): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = [
      'width:32px;height:32px;border-radius:8px;',
      'background:#1A1A26;border:1.5px solid rgba(74,144,217,0.6);',
      'display:flex;align-items:center;justify-content:center;',
      'font-family:Inter Tight,sans-serif;font-size:11px;font-weight:700;',
      'color:#4A90D9;cursor:pointer;',
    ].join('');
    el.textContent = initials;
    return el;
  }

  private _routeGeoJson(coords: [number, number][]): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      }],
    };
  }
}
