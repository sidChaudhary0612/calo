import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { DataBusService } from './data-bus.service';
import { MeshService } from './mesh.service';
import { SettingsService } from './settings.service';

export interface InvitePayload {
  type:        'invite' | 'response';
  fromId:      string;
  fromName:    string;
  groupId:     string;
  groupName:   string;
  passcode:    string;
  accepted?:   boolean;   // only present on type='response'
  ts:          number;
}

export interface PendingInvite {
  payload:     InvitePayload;
  peerAddress: string;
}

@Injectable({ providedIn: 'root' })
export class InviteService implements OnDestroy {

  // Incoming invite waiting for the user to accept / decline
  readonly pendingInvite = signal<PendingInvite | null>(null);

  // Per-rider sending state: riderId → 'sending' | 'sent' | 'accepted' | 'declined'
  readonly sentState = signal<Map<string, 'sending' | 'sent' | 'accepted' | 'declined'>>(new Map());

  private _bus      = inject(DataBusService);
  private _mesh     = inject(MeshService);
  private _settings = inject(SettingsService);
  private _teardown: (() => void) | null = null;

  constructor() {
    this._teardown = this._bus.register('invite', (payload, peerAddress) => {
      try {
        const msg: InvitePayload = JSON.parse(atob(payload));
        if (msg.type === 'invite')   this._onInviteReceived(msg, peerAddress);
        if (msg.type === 'response') this._onResponseReceived(msg);
      } catch { /* malformed */ }
    });
  }

  // ─── Leader sends invite to a nearby rider ────────────────────────────────

  async sendInvite(riderId: string): Promise<void> {
    const group = this._mesh.activeGroup();
    if (!group) return;

    const self = this._mesh.selfRider();
    const wifiAddr = this._mesh.getWifiAddress(riderId);
    if (!wifiAddr) return;

    this._setSentState(riderId, 'sending');

    // Ensure Wi-Fi Direct connection exists first
    try {
      await this._mesh.connectToPeer(riderId);
    } catch { /* already connected */ }

    const invite: InvitePayload = {
      type:      'invite',
      fromId:    this._mesh.selfId,
      fromName:  self.name,
      groupId:   group.id,
      groupName: group.name,
      passcode:  group.passcode ?? '',
      ts:        Date.now(),
    };

    this._bus.send('invite', invite, wifiAddr);
    this._setSentState(riderId, 'sent');

    // Auto-clear sent state after 30s if no response
    setTimeout(() => {
      const map = this.sentState();
      if (map.get(riderId) === 'sent') {
        this._setSentState(riderId, 'declined');
        setTimeout(() => this._clearSentState(riderId), 3000);
      }
    }, 30000);
  }

  // ─── Invitee accepts ──────────────────────────────────────────────────────

  accept(): void {
    const pending = this.pendingInvite();
    if (!pending) return;

    const { payload, peerAddress } = pending;

    // Join the group using the passcode
    this._mesh.joinGroup(payload.passcode);

    // Send acceptance back to the leader
    const response: InvitePayload = {
      type:      'response',
      fromId:    this._mesh.selfId,
      fromName:  this._mesh.selfRider().name,
      groupId:   payload.groupId,
      groupName: payload.groupName,
      passcode:  payload.passcode,
      accepted:  true,
      ts:        Date.now(),
    };
    this._bus.send('invite', response, peerAddress);
    this.pendingInvite.set(null);
  }

  // ─── Invitee declines ─────────────────────────────────────────────────────

  decline(): void {
    const pending = this.pendingInvite();
    if (!pending) return;

    const { payload, peerAddress } = pending;

    const response: InvitePayload = {
      type:      'response',
      fromId:    this._mesh.selfId,
      fromName:  this._mesh.selfRider().name,
      groupId:   payload.groupId,
      groupName: payload.groupName,
      passcode:  payload.passcode,
      accepted:  false,
      ts:        Date.now(),
    };
    this._bus.send('invite', response, peerAddress);
    this.pendingInvite.set(null);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _onInviteReceived(msg: InvitePayload, peerAddress: string): void {
    // Ignore if already in a group
    if (this._mesh.activeGroup()) return;
    this.pendingInvite.set({ payload: msg, peerAddress });

    // Auto-dismiss after 30s if not acted on
    setTimeout(() => {
      const cur = this.pendingInvite();
      if (cur?.payload.ts === msg.ts) this.pendingInvite.set(null);
    }, 30000);
  }

  private _onResponseReceived(msg: InvitePayload): void {
    // Find which riderId this response came from
    const rider = this._mesh.nearbyRiders().find(r => r.name === msg.fromName);
    const riderId = rider?.id ?? msg.fromId;

    if (msg.accepted) {
      this._setSentState(riderId, 'accepted');
      // Add them to the group
      this._mesh.addPeerToGroup(riderId);
      setTimeout(() => this._clearSentState(riderId), 4000);
    } else {
      this._setSentState(riderId, 'declined');
      setTimeout(() => this._clearSentState(riderId), 3000);
    }
  }

  private _setSentState(riderId: string, state: 'sending' | 'sent' | 'accepted' | 'declined'): void {
    this.sentState.update(m => new Map(m).set(riderId, state));
  }

  private _clearSentState(riderId: string): void {
    this.sentState.update(m => { const n = new Map(m); n.delete(riderId); return n; });
  }

  ngOnDestroy(): void {
    this._teardown?.();
  }
}
