import { WebPlugin } from '@capacitor/core';
import type { BleDevice, BlePluginDefinition } from './ble.plugin';

// Shared registry so BLE and Wi-Fi stubs emit the same generated peers
export interface SimulatedPeer {
  address:    string;   // canonical MAC
  deviceName: string;   // e.g. "RATH-7F3A"
  fullName:   string;   // e.g. "Rider 7F3A"
  rssi:       number;
  battery:    number;
  status:     'online' | 'away' | 'offline';
  appearsAt:  number;   // scan tick when this peer first becomes visible
  leavesAt:   number;   // scan tick when this peer goes out of range (0 = never)
}

// Singleton registry shared between BleWeb and WifiDirectWeb
export const peerRegistry: SimulatedPeer[] = [];
let registryReady = false;

function randomHex(len: number): string {
  return Array.from({ length: len }, () =>
    Math.floor(Math.random() * 16).toString(16).toUpperCase()
  ).join('');
}

function randomMac(): string {
  return Array.from({ length: 6 }, () => randomHex(2)).join(':');
}

function randomRssi(): number {
  // Realistic BLE range: -45 (very close) to -92 (barely in range)
  return -(45 + Math.floor(Math.random() * 47));
}

export function buildRegistry(): void {
  if (registryReady) return;
  registryReady = true;

  const count = 2 + Math.floor(Math.random() * 4); // 2–5 riders
  for (let i = 0; i < count; i++) {
    const tag  = randomHex(4);
    const addr = randomMac();
    const rssi = randomRssi();

    // Stagger appearance: one every 2–4 ticks
    const appearsAt = i === 0 ? 1 : i * (2 + Math.floor(Math.random() * 3));

    // Some riders leave after a while (simulates passing traffic)
    const transient = Math.random() < 0.3;
    const leavesAt  = transient ? appearsAt + 8 + Math.floor(Math.random() * 8) : 0;

    peerRegistry.push({
      address:   addr,
      deviceName: `RATH-${tag}`,
      fullName:   `Rider ${tag}`,
      rssi,
      battery:    20 + Math.floor(Math.random() * 80),
      status:     Math.random() < 0.8 ? 'online' : 'away',
      appearsAt,
      leavesAt,
    });
  }
}

export class BleWeb extends WebPlugin implements BlePluginDefinition {
  private _scanTimer: ReturnType<typeof setInterval> | null = null;
  private _tick = 0;

  async startScan(): Promise<void> {
    buildRegistry();
    this._tick = 0;

    this._scanTimer = setInterval(() => {
      this._tick++;

      for (const peer of peerRegistry) {
        if (this._tick < peer.appearsAt) continue;
        if (peer.leavesAt > 0 && this._tick >= peer.leavesAt) continue;

        // RSSI drifts ±4 dBm per tick
        peer.rssi = Math.max(-100, Math.min(-35, peer.rssi + this._jitter(4)));

        // Battery drains 1% every 25 ticks
        if (this._tick % 25 === 0 && peer.battery > 0) peer.battery--;

        // 6% chance per tick to flip status
        if (Math.random() < 0.06) {
          peer.status = peer.status === 'online' ? 'away' : 'online';
        }

        const device: BleDevice = {
          deviceAddress: peer.address,
          deviceName:    peer.deviceName,
          rssi:          peer.rssi,
          // Use compact keys matching the on-device beacon format
          payload: JSON.stringify({
            n: peer.fullName,
            s: peer.status,
            b: peer.battery,
          }),
        };

        this.notifyListeners('deviceFound', device);
      }
    }, 900);
  }

  async stopScan(): Promise<void> {
    if (this._scanTimer) { clearInterval(this._scanTimer); this._scanTimer = null; }
  }

  async startAdvertise(_opts: { payload: string }): Promise<void> {
    this.notifyListeners('advertiseStarted', { advertising: true });
  }

  async stopAdvertise(): Promise<void> {}

  async isBluetoothEnabled(): Promise<{ enabled: boolean }> {
    return { enabled: true };
  }

  private _jitter(range: number): number {
    return Math.round(Math.random() * range * 2 - range);
  }
}
