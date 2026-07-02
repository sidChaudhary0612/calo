import { registerPlugin } from '@capacitor/core';

export interface BleDevice {
  deviceAddress: string;
  deviceName:    string;
  rssi:          number;
  payload:       string;   // JSON-encoded beacon payload
}

export interface InviteReceivedEvent {
  payload:     string;   // raw invite/response string written to INVITE_CHAR
  fromAddress: string;   // BLE MAC of the sender
}

export interface BlePluginDefinition {
  startScan():                             Promise<void>;
  stopScan():                              Promise<void>;
  startAdvertise(opts: { payload: string }): Promise<void>;
  stopAdvertise():                         Promise<void>;
  isBluetoothEnabled():                    Promise<{ enabled: boolean }>;
  /** Push a small invite/response payload to a peer's INVITE_CHAR via GATT write. */
  sendInvite(opts: { deviceAddress: string; payload: string }): Promise<void>;
  addListener(event: 'deviceFound', handler: (d: BleDevice) => void): Promise<{ remove(): void }>;
  addListener(event: 'scanFailed',  handler: (e: { error: string }) => void): Promise<{ remove(): void }>;
  addListener(event: 'advertiseStarted', handler: (e: { advertising: boolean }) => void): Promise<{ remove(): void }>;
  addListener(event: 'inviteReceived', handler: (e: InviteReceivedEvent) => void): Promise<{ remove(): void }>;
}

export const BlePlugin = registerPlugin<BlePluginDefinition>('BlePlugin', {
  web: () => import('./ble.web').then(m => new m.BleWeb()),
});
