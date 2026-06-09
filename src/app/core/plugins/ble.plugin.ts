import { registerPlugin } from '@capacitor/core';

export interface BleDevice {
  deviceAddress: string;
  deviceName:    string;
  rssi:          number;
  payload:       string;   // JSON-encoded beacon payload
}

export interface BlePluginDefinition {
  startScan():                             Promise<void>;
  stopScan():                              Promise<void>;
  startAdvertise(opts: { payload: string }): Promise<void>;
  stopAdvertise():                         Promise<void>;
  isBluetoothEnabled():                    Promise<{ enabled: boolean }>;
  addListener(event: 'deviceFound', handler: (d: BleDevice) => void): Promise<{ remove(): void }>;
  addListener(event: 'scanFailed',  handler: (e: { error: string }) => void): Promise<{ remove(): void }>;
  addListener(event: 'advertiseStarted', handler: (e: { advertising: boolean }) => void): Promise<{ remove(): void }>;
}

export const BlePlugin = registerPlugin<BlePluginDefinition>('BlePlugin', {
  web: () => import('./ble.web').then(m => new m.BleWeb()),
});
