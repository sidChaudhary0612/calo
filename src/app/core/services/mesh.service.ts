import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { Rider, RideGroup, RiderLocation } from '../models/rider.model';
import { WifiDirect, WifiP2pPeer } from '../plugins/wifi-direct.plugin';
import { BlePlugin, BleDevice } from '../plugins/ble.plugin';
import { P2pSocket } from '../plugins/p2p-socket.plugin';
import { DataBusService } from './data-bus.service';
import { SettingsService } from './settings.service';

interface BeaconPayload {
  n:  string;             // rider name  (shortened key to fit 20-byte BLE advert limit)
  s:  'online' | 'away' | 'offline';  // status
  b?: number;             // battery %
  g?: string;             // groupId (first 4 chars)
}

interface PeerRecord {
  bleAddress?:   string;
  wifiAddress?:  string;
  deviceName?:   string;   // normalised name used for BLE↔Wi-Fi merge key
  beacon?:       BeaconPayload;
  rssi?:         number;
  wifiConnected: boolean;
  location?:     RiderLocation;
  signalAngle:   number;   // stable 0-359 assigned once on first discovery
}

@Injectable({ providedIn: 'root' })
export class MeshService implements OnDestroy {

  readonly nearbyRiders  = signal<Rider[]>([]);
  readonly activeGroup   = signal<RideGroup | null>(null);
  readonly isScanning    = signal(false);
  readonly meshConnected = signal(false);
  private _settings = inject(SettingsService);
  private _bus      = inject(DataBusService);

  readonly selfRider = signal<Rider>((() => {
    const name = this._settings.riderName() || 'Rider';
    const initials = name.split(' ').map((w: string) => w[0]).join('').substring(0, 2).toUpperCase();
    return { id: 'self', name, avatarInitials: initials, status: 'online', role: 'solo', battery: 88, signal: 100 };
  })());

  readonly selfId = 'self';

  // Set by LocationService after each GPS fix so distance can be computed here
  selfLocation: RiderLocation | null = null;

  private _peers     = new Map<string, PeerRecord>();
  private _listeners: Array<{ remove(): void }> = [];
  private _busTeardown: (() => void) | null = null;

  constructor() {
    this._busTeardown = this._bus.register('location', (payload, peerAddress) => {
      try {
        const data = JSON.parse(atob(payload));
        this._updatePeerLocation(peerAddress, data);
      } catch { /* malformed */ }
    });
  }

  // ─── Rider name (called from OnboardingComponent after name is saved) ────

  applyRiderName(name: string): void {
    const initials = name.split(' ').map((w: string) => w[0]).join('').substring(0, 2).toUpperCase();
    this.selfRider.update(r => ({ ...r, name, avatarInitials: initials }));
    this._advertise();
  }

  // ─── Self location (set by LocationService) ──────────────────────────────

  updateSelfLocation(loc: RiderLocation): void {
    this.selfLocation = loc;
    this._rebuildRiders(); // distances refresh whenever self moves
  }

  // ─── Peer location from DataBus ──────────────────────────────────────────

  private _updatePeerLocation(
    peerAddress: string,
    data: { lat: number; lng: number; speed?: number; bearing?: number; timestamp: number },
  ): void {
    let key: string | undefined;
    this._peers.forEach((rec, k) => {
      if (rec.wifiAddress === peerAddress || rec.bleAddress === peerAddress) key = k;
    });
    if (!key) {
      key = peerAddress;
      this._peers.set(key, { wifiConnected: true, signalAngle: this._newAngle() });
    }
    const rec = this._peers.get(key)!;
    rec.location = { lat: data.lat, lng: data.lng, timestamp: data.timestamp };
    this._peers.set(key, rec);
    this._rebuildRiders();
  }

  getRiderLocation(riderId: string): RiderLocation | undefined {
    return this._peers.get(riderId)?.location;
  }

  // ─── Scanning ────────────────────────────────────────────────────────────

  async startScan(): Promise<void> {
    this.isScanning.set(true);
    this.nearbyRiders.set([]);
    this._peers.clear();

    const bleListener = await BlePlugin.addListener('deviceFound', (d: BleDevice) => {
      this._onBleDevice(d);
    });
    this._listeners.push(bleListener);

    const wifiListener = await WifiDirect.addListener('peersChanged', ev => {
      ev.peers.forEach(p => this._onWifiPeer(p));
    });
    this._listeners.push(wifiListener);

    const connListener = await WifiDirect.addListener('connectionChanged', info => {
      this.meshConnected.set(info.groupFormed);
    });
    this._listeners.push(connListener);

    await Promise.allSettled([
      BlePlugin.startScan(),
      WifiDirect.startDiscovery(),
      this._advertise(),
    ]);
  }

  async stopScan(): Promise<void> {
    await Promise.allSettled([BlePlugin.stopScan(), WifiDirect.stopDiscovery()]);
    this._removeListeners();
    this.isScanning.set(false);
  }

  // ─── Groups ──────────────────────────────────────────────────────────────

  // Reactive member list: self + any nearby rider whose id is in memberIds.
  // Self is always included so the leader sees themselves immediately.
  readonly groupMembers = computed<Rider[]>(() => {
    const group = this.activeGroup();
    if (!group) return [];
    const self = this.selfRider();
    const nearby = this.nearbyRiders().filter(r => group.memberIds.includes(r.id));
    return [self, ...nearby];
  });

  createGroup(name: string): RideGroup {
    const group: RideGroup = {
      id:        'g-' + Date.now(),
      name,
      leaderId:  this.selfId,
      memberIds: [this.selfId],
      createdAt: new Date(),
      status:    'forming',
      passcode:  String(Math.floor(1000 + Math.random() * 9000)),
    };
    this.activeGroup.set(group);
    this.selfRider.update(r => ({ ...r, role: 'leader' }));
    this._advertise();
    P2pSocket.startServer().catch(() => {});
    return group;
  }

  joinGroup(passcode: string): boolean {
    if (passcode.length < 4) return false;
    // Find a nearby rider whose beacon groupId starts with the entered passcode.
    // If none found yet, still create the group locally — the member list fills
    // in reactively as BLE/Wi-Fi peers with matching group beacons are discovered.
    const matchingPeers = this.nearbyRiders().filter(r => {
      const rec = this._peers.get(r.id);
      return rec?.beacon?.g === passcode;
    });
    const leader = matchingPeers[0];
    const group: RideGroup = {
      id:        'g-' + passcode,
      name:      'Ride Group',
      leaderId:  leader?.id ?? this.selfId,
      memberIds: [this.selfId, ...matchingPeers.map(r => r.id)],
      createdAt: new Date(),
      status:    'forming',
      passcode,
    };
    this.activeGroup.set(group);
    this.selfRider.update(r => ({ ...r, role: 'member' }));
    this._advertise();
    this._connectToGroupOwner();
    return true;
  }

  // Called when a BLE beacon arrives with a groupId that matches our active group.
  // Adds the peer to memberIds if not already present.
  addPeerToGroup(riderId: string): void {
    const group = this.activeGroup();
    if (!group || group.memberIds.includes(riderId)) return;
    this.activeGroup.set({ ...group, memberIds: [...group.memberIds, riderId] });
  }

  leaveGroup(): void {
    this.activeGroup.set(null);
    this.selfRider.update(r => ({ ...r, role: 'solo' }));
    this._advertise();
    P2pSocket.stopServer().catch(() => {});
  }

  // Kept for external callers — delegates to the computed signal.
  getGroupMembers(): Rider[] {
    return this.groupMembers();
  }

  getRiderById(id: string): Rider | undefined {
    return this.nearbyRiders().find(r => r.id === id);
  }

  async connectToPeer(wifiAddress: string): Promise<void> {
    await WifiDirect.connect({ deviceAddress: wifiAddress });
    this.meshConnected.set(true);
  }

  isInGroup(riderId: string): boolean {
    return this.activeGroup()?.memberIds.includes(riderId) ?? false;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async _connectToGroupOwner(): Promise<void> {
    try {
      const info = await WifiDirect.requestConnectionInfo();
      if (info.groupFormed && info.groupOwnerAddress) {
        await P2pSocket.connect({ host: info.groupOwnerAddress });
        this.meshConnected.set(true);
      }
    } catch { /* not yet connected */ }
  }

  private _onBleDevice(d: BleDevice): void {
    const canonKey   = d.deviceAddress;
    const [, record] = this._findOrCreate(canonKey, this._normalise(d.deviceName ?? d.deviceAddress));
    record.bleAddress = d.deviceAddress;
    record.rssi       = d.rssi;

    if (d.payload) {
      try {
        const raw = JSON.parse(d.payload);
        // Support both compact keys (n/s/b/g) and legacy long keys (name/status/battery/groupId)
        record.beacon = {
          n: raw.n ?? raw.name ?? '',
          s: raw.s ?? raw.status ?? 'offline',
          b: raw.b ?? raw.battery,
          g: raw.g ?? raw.groupId,
        };
        // Use the rider's actual name as the merge key if available
        if (record.beacon.n) {
          record.deviceName = this._normalise(record.beacon.n);
        }
      } catch { /* ignore malformed payload */ }
    }

    // Fall back to BLE device name if beacon didn't provide a name
    if (!record.deviceName) {
      record.deviceName = this._normalise(d.deviceName ?? d.deviceAddress);
    }

    this._peers.set(canonKey, record);
    this._rebuildRiders();

    // Auto-join: if this peer's beacon groupId matches our active group's passcode,
    // add them to our member list so they appear in the group screen immediately.
    const group = this.activeGroup();
    const beaconGroup = record.beacon?.g;
    if (group && beaconGroup && group.passcode === beaconGroup) {
      this.addPeerToGroup(canonKey);
    }
  }

  private _onWifiPeer(p: WifiP2pPeer): void {
    const nameKey  = this._normalise(p.deviceName ?? p.deviceAddress);
    // If a BLE record already exists for this name, merge into it; otherwise use Wi-Fi addr as key
    const existing = this._findByName(nameKey);
    const canonKey = existing ? (existing[0]) : p.deviceAddress;
    const record   = existing ? existing[1] : this._peers.get(p.deviceAddress) ?? { wifiConnected: false, signalAngle: this._newAngle() };
    record.wifiAddress   = p.deviceAddress;
    record.deviceName    = nameKey;
    record.wifiConnected = p.status === 0;
    this._peers.set(canonKey, record);
    this._rebuildRiders();
  }

  private _findOrCreate(canonKey: string, nameKey: string): [string, PeerRecord] {
    // Exact key match (update in place)
    if (this._peers.has(canonKey)) return [canonKey, this._peers.get(canonKey)!];
    // Name match from a previous discovery with different key (e.g. Wi-Fi first)
    const byName = this._findByName(nameKey);
    if (byName) {
      // Move to canonical key, remove old
      this._peers.delete(byName[0]);
      return [canonKey, byName[1]];
    }
    // Brand new peer
    return [canonKey, { wifiConnected: false, signalAngle: this._newAngle() }];
  }

  private _findByName(nameKey: string): [string, PeerRecord] | undefined {
    for (const [k, rec] of this._peers) {
      if (rec.deviceName === nameKey) return [k, rec];
    }
    return undefined;
  }

  private _rebuildRiders(): void {
    // Deduplicate: collect one entry per unique deviceName (handles merge)
    const seen = new Set<string>();
    const riders: Rider[] = [];

    this._peers.forEach((rec, addr) => {
      const dedupKey = rec.deviceName ?? addr;
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);

      const beacon   = rec.beacon;
      const distance = rec.location && this.selfLocation
        ? this._haversineM(this.selfLocation.lat, this.selfLocation.lng, rec.location.lat, rec.location.lng)
        : undefined;

      const displayName = beacon?.n || rec.deviceName?.replace('calo-', '') || 'Unknown';
      const rider: Rider = {
        id:             addr,
        name:           displayName,
        avatarInitials: displayName.split(' ').map((w: string) => w[0]).join('').substring(0, 2).toUpperCase() || '??',
        status:         beacon?.s ?? 'offline',
        role:           'member',
        battery:        beacon?.b,
        signal:         rec.rssi != null ? this._rssiToSignal(rec.rssi) : undefined,
        signalAngle:    rec.signalAngle,
        location:       rec.location,
        distance,
      };
      riders.push(rider);
    });

    this.nearbyRiders.set(riders);
    if (riders.length > 0) this.meshConnected.set(true);
  }

  private _normalise(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '-');
  }

  private _newAngle(): number {
    // Assign a unique stable angle spread evenly, with some jitter
    const existing = this._peers.size;
    const base = (existing * 137) % 360; // golden-angle spread
    return Math.round(base);
  }

  private _haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private async _advertise(): Promise<void> {
    const self = this.selfRider();
    // Keys are single-char to keep JSON under the 20-byte BLE service-data limit.
    // Max realistic payload: {"n":"AAAAAAAAAA","s":"online","b":100} = 37 chars —
    // we truncate the name to 10 chars so the whole thing fits in ~36 bytes and
    // advBytes in BlePlugin.java clips it to 20, keeping at minimum n + s visible.
    const payload: BeaconPayload = {
      n: self.name.substring(0, 10),
      s: self.status,
      b: self.battery,
      ...(this.activeGroup()?.passcode ? { g: this.activeGroup()!.passcode } : {}),
    };
    await BlePlugin.startAdvertise({ payload: JSON.stringify(payload) }).catch(() => {});
  }

  private _rssiToSignal(rssi: number): number {
    const clamped = Math.max(-100, Math.min(-40, rssi));
    return Math.round(((clamped + 100) / 60) * 100);
  }

  private _removeListeners(): void {
    this._listeners.forEach(l => l.remove());
    this._listeners = [];
  }

  ngOnDestroy(): void {
    this.stopScan();
    this._busTeardown?.();
  }
}
