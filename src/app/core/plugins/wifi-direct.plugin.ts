import { registerPlugin } from '@capacitor/core';

export interface WifiP2pPeer {
  deviceName:    string;
  deviceAddress: string;
  status:        number; // 0=connected,1=invited,2=failed,3=available,4=unavailable
}

export interface ConnectionInfo {
  groupFormed:       boolean;
  isGroupOwner:      boolean;
  groupOwnerAddress: string | null;
}

export interface WifiDirectPlugin {
  startDiscovery():          Promise<void>;
  stopDiscovery():           Promise<void>;
  connect(opts: { deviceAddress: string }): Promise<void>;
  disconnect():              Promise<void>;
  requestConnectionInfo():   Promise<ConnectionInfo>;
  addListener(event: 'peersChanged',          handler: (data: { peers: WifiP2pPeer[] }) => void): Promise<{ remove(): void }>;
  addListener(event: 'connectionChanged',     handler: (data: ConnectionInfo)           => void): Promise<{ remove(): void }>;
  addListener(event: 'wifiDirectStateChanged',handler: (data: { enabled: boolean })     => void): Promise<{ remove(): void }>;
}

export const WifiDirect = registerPlugin<WifiDirectPlugin>('WifiDirect', {
  web: () => import('./wifi-direct.web').then(m => new m.WifiDirectWeb()),
});
