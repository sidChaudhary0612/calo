import { Injectable, OnDestroy } from '@angular/core';
import { P2pSocket } from '../plugins/p2p-socket.plugin';

export type BusChannel = 'location' | 'sos' | 'music' | 'ptt-audio' | 'invite' | 'rtc-signal';

type FrameHandler = (payload: string, peerAddress: string) => void;

/**
 * Single subscriber to P2pSocket 'frameReceived'. Routes incoming frames by
 * channel to any registered handler. Services call register() to subscribe.
 * PttService registers directly on P2pSocket to avoid circular deps.
 */
@Injectable({ providedIn: 'root' })
export class DataBusService implements OnDestroy {
  private _handlers = new Map<BusChannel, FrameHandler[]>();
  private _listener: { remove(): void } | null = null;

  constructor() {
    this._init();
  }

  private async _init(): Promise<void> {
    this._listener = await P2pSocket.addListener('frameReceived', frame => {
      const handlers = this._handlers.get(frame.channel as BusChannel);
      handlers?.forEach(h => h(frame.payload, frame.peerAddress));
    });
  }

  register(channel: BusChannel, handler: FrameHandler): () => void {
    const list = this._handlers.get(channel) ?? [];
    list.push(handler);
    this._handlers.set(channel, list);
    return () => {
      const updated = (this._handlers.get(channel) ?? []).filter(h => h !== handler);
      this._handlers.set(channel, updated);
    };
  }

  send(channel: BusChannel, data: object, target?: string): void {
    const payload = btoa(JSON.stringify(data));
    P2pSocket.send({ channel, payload, target }).catch(() => {});
  }

  ngOnDestroy(): void {
    this._listener?.remove();
  }
}
