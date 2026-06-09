import { WebPlugin } from '@capacitor/core';
import type { WifiDirectPlugin, WifiP2pPeer, ConnectionInfo } from './wifi-direct.plugin';
import { peerRegistry, buildRegistry } from './ble.web';

// Re-export buildRegistry so importing this file also ensures the registry exists
export { buildRegistry };

/**
 * Browser stub for Wi-Fi Direct.
 * Uses the same peerRegistry as BleWeb so both transports discover the same
 * generated riders — MeshService merges them into single entries.
 */
export class WifiDirectWeb extends WebPlugin implements WifiDirectPlugin {
  private _scanTimer: ReturnType<typeof setInterval> | null = null;
  private _tick = 0;

  async startDiscovery(): Promise<void> {
    // Registry may already be built by BleWeb; buildRegistry() is idempotent
    this._tick = 0;

    this._scanTimer = setInterval(() => {
      this._tick++;

      const visible = peerRegistry.filter(p => {
        if (this._tick < p.appearsAt) return false;
        if (p.leavesAt > 0 && this._tick >= p.leavesAt) return false;
        return true;
      });

      if (visible.length === 0) return;

      const peers: WifiP2pPeer[] = visible.map(p => ({
        deviceName:    p.deviceName,
        deviceAddress: p.address,
        // status 0 = CONNECTED, 3 = AVAILABLE — randomly connected once seen
        status: Math.random() < 0.3 ? 0 : 3,
      }));

      this.notifyListeners('peersChanged', { peers });
    }, 1100);   // slightly different interval from BLE so events interleave naturally
  }

  async stopDiscovery(): Promise<void> {
    if (this._scanTimer) { clearInterval(this._scanTimer); this._scanTimer = null; }
  }

  async connect(_opts: { deviceAddress: string }): Promise<void> {
    await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
    this.notifyListeners('connectionChanged', {
      groupFormed:       true,
      isGroupOwner:      false,
      groupOwnerAddress: '192.168.49.1',
    });
  }

  async disconnect(): Promise<void> {
    this.notifyListeners('connectionChanged', {
      groupFormed: false, isGroupOwner: false, groupOwnerAddress: null,
    });
  }

  async requestConnectionInfo(): Promise<ConnectionInfo> {
    return { groupFormed: false, isGroupOwner: false, groupOwnerAddress: null };
  }
}
