import { registerPlugin } from '@capacitor/core';

export interface P2pFrame {
  channel:     string;
  payload:     string;   // base64
  peerAddress: string;
}

export interface P2pSocketPlugin {
  startServer():                                        Promise<void>;
  stopServer():                                         Promise<void>;
  connect(opts: { host: string }):                      Promise<void>;
  disconnectPeer(opts: { peerAddress: string }):        Promise<void>;
  send(opts: { channel: string; payload: string; target?: string }): Promise<void>;

  addListener(event: 'frameReceived',   handler: (f: P2pFrame)                      => void): Promise<{ remove(): void }>;
  addListener(event: 'peerConnected',   handler: (d: { peerAddress: string })        => void): Promise<{ remove(): void }>;
  addListener(event: 'peerDisconnected',handler: (d: { peerAddress: string })        => void): Promise<{ remove(): void }>;
}

export const P2pSocket = registerPlugin<P2pSocketPlugin>('P2pSocket', {
  web: () => import('./p2p-socket.web').then(m => new m.P2pSocketWeb()),
});
