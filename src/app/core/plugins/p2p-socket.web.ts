import { WebPlugin } from '@capacitor/core';
import type { P2pSocketPlugin, P2pFrame } from './p2p-socket.plugin';

/**
 * Browser/dev-mode stub.
 * Simulates a local loopback — frames sent are echoed back as if received
 * from a remote peer, so PTT and location sharing can be tested in-browser.
 */
export class P2pSocketWeb extends WebPlugin implements P2pSocketPlugin {
  private _loopback = true;

  async startServer(): Promise<void> {}
  async stopServer():  Promise<void> {}
  async connect(_opts: { host: string }): Promise<void> {
    this.notifyListeners('peerConnected', { peerAddress: '127.0.0.1' });
  }
  async disconnectPeer(_opts: { peerAddress: string }): Promise<void> {
    this.notifyListeners('peerDisconnected', { peerAddress: '127.0.0.1' });
  }

  async send(opts: { channel: string; payload: string; target?: string }): Promise<void> {
    if (!this._loopback) return;
    // Echo back so sender hears their own audio in dev mode (useful for testing)
    const frame: P2pFrame = {
      channel:     opts.channel,
      payload:     opts.payload,
      peerAddress: '127.0.0.1',
    };
    // Slight delay to mimic network round-trip
    setTimeout(() => this.notifyListeners('frameReceived', frame), 80);
  }
}
